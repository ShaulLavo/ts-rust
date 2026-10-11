use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use serde_json::{Value, json};
use ts_goport::api::{encoder, proto};
use ts_goport::ast::{escape_symbol_name, get_source_file_of_node, is_part_of_type_node};
use ts_goport::astdata::SyntaxKind;
use ts_goport::binder::go_symbol_name;
use ts_goport::checker::printer_impl::VerbosityContext;
use ts_goport::checker::{Checker, InternalNodeBuilderFlags, LiteralValue, NodeBuilderFlags};
use ts_goport::core::{IndexInfoId, Node, SignatureId, SymbolId, TypeId, TypePredicateId};
use ts_goport::flags::{
    CheckFlags, ContextFlags, IterationUse, SignatureFlags, SignatureKind, SymbolFlags, TokenFlags,
    TypeFlags, TypePredicateKind, UnionReduction,
};
use ts_goport::frontend::compiler::NewProgram;
use ts_goport::gostd::Context;
use ts_goport::printer::EmitFlags;
use ts_goport::program::ls_program;

pub struct ClassicChecker {
    checker: Rc<RefCell<Checker>>,
    context: Context,
    types: RefCell<HashSet<u32>>,
    symbols: RefCell<HashSet<u32>>,
    signatures: RefCell<HashSet<u32>>,
}

impl ClassicChecker {
    pub fn new(program: &NewProgram, context: &Context) -> Self {
        let (checker, release) = ls_program::get_type_checker(program, context);
        drop(release);
        Self {
            checker,
            context: context.clone(),
            types: RefCell::default(),
            symbols: RefCell::default(),
            signatures: RefCell::default(),
        }
    }

    /// Classic `Program.getClassifiableNames`: the escaped names of the binder symbols declared
    /// with a classifiable meaning (class, enum, type alias, interface, type parameter, module
    /// or alias) in the files, as classic's binder collects them in `declareSymbol`.
    pub fn classifiable_names(&self, files: &[Node]) -> Value {
        fn collect(
            node: Node,
            checker: &Checker,
            names: &mut std::collections::BTreeSet<String>,
        ) -> bool {
            let symbol = node.symbol();
            if symbol.is_some()
                && checker.sym(symbol).flags.intersects(
                    SymbolFlags::CLASS
                        | SymbolFlags::ENUM
                        | SymbolFlags::TYPE_ALIAS
                        | SymbolFlags::INTERFACE
                        | SymbolFlags::TYPE_PARAMETER
                        | SymbolFlags::MODULE
                        | SymbolFlags::ALIAS,
                )
            {
                names.insert(escape_symbol_name(&go_symbol_name(
                    &checker.symbols,
                    symbol,
                )));
            }
            node.for_each_child(|child| collect(child, checker, names));
            false
        }
        let mut checker = self.checker.borrow_mut();
        ts_goport::program::catch_up_checker(&mut checker.symbols);
        let mut names = std::collections::BTreeSet::new();
        for &file in files {
            collect(file, &checker, &mut names);
        }
        Value::Array(
            names
                .iter()
                .map(|name| crate::classic_strings::string_value(name))
                .collect(),
        )
    }

    pub fn request(&self, location: Node, request: &Value) -> Result<Value, String> {
        let method = request["method"]
            .as_str()
            .ok_or("checker method is required")?;
        let t = TypeId(Self::handle(request, "type", &self.types)?);
        let symbol = SymbolId(Self::symbol_handle(request, "symbol", &self.symbols)?);
        let signature = SignatureId(Self::handle(request, "signature", &self.signatures)?);
        let mut checker = self.checker.borrow_mut();
        ts_goport::program::catch_up_checker(&mut checker.symbols);
        match method {
            "getTypeData" => self.type_data(&checker, t),
            // Classic `getSymbolWalker().walkType` / `walkSymbol` with the symbols `accept` rejected.
            "walkType" | "walkSymbol" => {
                let rejected = Self::symbol_ids(request, "rejected", &self.symbols)?;
                let mut walk = crate::classic_symbol_walker::SymbolWalk::new(
                    rejected.into_iter().map(SymbolId),
                );
                if method == "walkType" {
                    walk.visit_type(&mut checker, t);
                } else {
                    walk.visit_symbol(&mut checker, symbol);
                }
                Ok(
                    json!({"types": self.type_refs(&walk.types()), "symbols": self.symbol_refs(&walk.symbols()),
                    "order": self.symbol_refs(&walk.symbol_order)}),
                )
            }
            "getSymbolData" => Ok(self.symbol_data(&checker, symbol)),
            "getSignatureData" => Ok(self.signature_data(&checker, signature)),
            "getTypeAtLocation" => {
                Ok(self.type_ref(classic_type_at_location(&mut checker, location)))
            }
            "getTypeFromTypeNode" => {
                Ok(self.type_ref(classic_type_from_type_node(&mut checker, location)))
            }
            "getSymbolAtLocation" => {
                Ok(self.symbol_ref(checker.get_symbol_at_location_exported(location)))
            }
            "getTypeOfSymbolAtLocation" => {
                Ok(self.type_ref(checker.get_type_of_symbol_at_location(symbol, location)))
            }
            "getDeclaredTypeOfSymbol" => {
                Ok(self.type_ref(checker.get_declared_type_of_symbol_exported(symbol)))
            }
            "getTypeOfSymbol" => Ok(self.type_ref(checker.get_type_of_symbol_exported(symbol))),
            "getAliasedSymbol" => Ok(self.symbol_ref(checker.get_aliased_symbol(symbol))),
            "getImmediateAliasedSymbol" => {
                Ok(self.symbol_ref(checker.get_immediate_aliased_symbol_exported(symbol)))
            }
            "getMergedSymbol" => Ok(self.symbol_ref(checker.get_merged_symbol_exported(symbol))),
            "getRootSymbols" => Ok(self.symbol_refs(&checker.get_root_symbols(symbol))),
            "getShorthandAssignmentValueSymbol" => {
                Ok(self.symbol_ref(checker.get_shorthand_assignment_value_symbol(location)))
            }
            // A symbol's `members` or `exports` table as classic `SymbolTable` entries.
            "getSymbolTable" => {
                let data = checker.sym(symbol);
                let table = if request["exports"].as_bool() == Some(true) {
                    data.exports
                } else {
                    data.members
                };
                if table.is_nil() {
                    return Ok(Value::Null);
                }
                Ok(Value::Array(
                    checker
                        .symbols
                        .entries(table)
                        .into_iter()
                        .map(|(name, member)| {
                            json!([
                                crate::classic_strings::string_value(&escape_symbol_name(&name)),
                                self.symbol_ref(member)
                            ])
                        })
                        .collect(),
                ))
            }
            // Classic `getIndexInfosOfIndexSymbol`: the infos of the index symbol's declarations,
            // with the members of its parent as the siblings that computed names contribute.
            "getIndexInfosOfIndexSymbol" => {
                let parent = checker.sym(symbol).parent;
                let siblings = if parent.is_nil() {
                    Vec::new()
                } else {
                    let members = checker.get_members_of_symbol(parent);
                    checker.symbols.values(members)
                };
                Ok(Value::Array(
                    checker
                        .get_index_infos_of_index_symbol(symbol, &siblings)
                        .into_iter()
                        .map(|info| self.index_info(&checker, info))
                        .collect(),
                ))
            }
            "getExportsOfModule" => {
                Ok(self.symbol_refs(&checker.get_exports_of_module_exported(symbol)))
            }
            "isOptionalParameter" => Ok(json!(checker.is_optional_parameter(location))),
            // Classic `getContextualType` of a token in an array literal (completions pass the
            // token before the position): `getContextualTypeForElementExpression` at index -1,
            // where Go's `getContextualType` answers only an element.
            "getContextualTypeOfArrayLiteralToken" => {
                let flags = ContextFlags(number(request, "contextFlags")?);
                let element = |c: &mut Checker| {
                    let t = c.get_apparent_type_of_contextual_type(location, flags);
                    if t.is_nil() {
                        return TypeId::NIL;
                    }
                    let undefined_type = c.undefined_type;
                    c.map_type(t, &mut |c: &mut Checker, t: TypeId| {
                        if c.is_tuple_type(t) {
                            return TypeId::NIL;
                        }
                        let property = c.get_type_of_property_of_contextual_type(t, "-1");
                        if property.is_some() {
                            return property;
                        }
                        c.get_iterated_type_or_element_type(
                            IterationUse::ELEMENT,
                            t,
                            undefined_type,
                            Node::NIL,
                            false,
                        )
                    })
                };
                // Classic's public `getContextualType`, as `get_contextual_type_exported`.
                let result = if flags.intersects(ContextFlags::IGNORE_NODE_INFERENCES) {
                    checker.run_with_inference_blocked_from_source_node(location, element)
                } else {
                    element(&mut checker)
                };
                Ok(self.type_ref(result))
            }
            "getContextualType" => Ok(self.type_ref(checker.get_contextual_type_exported(
                location,
                ContextFlags(number(request, "contextFlags")?),
            ))),
            "getSignatureFromDeclaration" => {
                Ok(self.signature_ref(checker.get_signature_from_declaration_exported(location)))
            }
            "getResolvedSignature" => {
                Ok(self.signature_ref(checker.get_resolved_signature_exported(location)))
            }
            "getReturnTypeOfSignature" => {
                Ok(self.type_ref(checker.get_return_type_of_signature_exported(signature)))
            }
            "getSignaturesOfType" => {
                let kind = signature_kind(request)?;
                Ok(self.signature_refs(&checker.get_signatures_of_type_exported(t, kind)))
            }
            "getIndexTypeOfType" => {
                let key_type = match number(request, "kind")? {
                    0 => checker.get_string_type(),
                    1 => checker.get_number_type(),
                    _ => return Err("index kind must be String or Number".into()),
                };
                Ok(self.type_ref(checker.get_index_type_of_type_exported(t, key_type)))
            }
            "typeToString" => Ok(json!(checker.type_to_string_enclosing(t, location))),
            "symbolToString" => Ok(json!(checker.symbol_to_string_exported(symbol))),
            "signatureToString" => Ok(json!(checker.signature_to_string(signature))),
            "getFullyQualifiedName" => Ok(json!(checker.get_fully_qualified_name_exported(symbol))),
            "symbolIsValue" => Ok(json!(checker.symbol_is_value_ex(
                symbol,
                request["includeTypeOnlyMembers"].as_bool() == Some(true)
            ))),
            // The binder's `node.symbol` and `node.localSymbol`.
            "getNodeSymbol" => Ok(
                self.symbol_ref(if request["local"].as_bool() == Some(true) {
                    location.local_symbol()
                } else {
                    location.symbol()
                }),
            ),
            // The binder's `node.locals` table, as classic `SymbolTable` entries.
            "getNodeLocals" => {
                let table = location.locals();
                if table.is_nil() {
                    return Ok(Value::Null);
                }
                Ok(Value::Array(
                    checker
                        .symbols
                        .entries(table)
                        .into_iter()
                        .map(|(name, local)| {
                            json!([
                                crate::classic_strings::string_value(&escape_symbol_name(&name)),
                                self.symbol_ref(local)
                            ])
                        })
                        .collect(),
                ))
            }
            "tryFindAmbientModule" => {
                Ok(self
                    .symbol_ref(checker.try_find_ambient_module_exported(string(request, "name")?)))
            }
            "getSuggestedSymbolForNonexistentClassMember" => Ok(self.symbol_ref(
                checker
                    .get_suggested_symbol_for_nonexistent_class_member(string(request, "name")?, t),
            )),
            "getSuggestedSymbolForNonexistentJSXAttribute" => Ok(self.symbol_ref(
                checker.get_suggested_symbol_for_nonexistent_jsx_attribute(
                    string(request, "name")?,
                    t,
                ),
            )),
            // Classic's checker answers this; Go's emit resolver has the same worker.
            "requiresAddingImplicitUndefined" => {
                let enclosing = node(request, "enclosing")?;
                let resolver = checker.get_emit_resolver();
                Ok(json!(resolver.requires_adding_implicit_undefined_worker(
                    &mut checker,
                    location,
                    enclosing
                )))
            }
            "isUnknownSymbol" => Ok(json!(checker.is_unknown_symbol(symbol))),
            "isUndefinedSymbol" => Ok(json!(checker.is_undefined_symbol(symbol))),
            "isArgumentsSymbol" => Ok(json!(checker.is_arguments_symbol(symbol))),
            "getSymbolsInScope" => Ok(self.symbol_refs(
                &checker.get_symbols_in_scope_exported(location, symbol_flags(request)?),
            )),
            "getAmbientModules" => Ok(self.symbol_refs(&checker.get_ambient_modules())),
            "tryGetThisTypeAt" => {
                let container = node(request, "container")?;
                let include_global_this = request["includeGlobalThis"].as_bool().unwrap_or(true);
                Ok(self.type_ref(checker.try_get_this_type_at_ex_exported(
                    location,
                    include_global_this,
                    container,
                )))
            }
            // Classic `resolveName` resolves with `isUse` false, so no symbol counts as referenced.
            "resolveName" => Ok(self.symbol_ref(checker.resolve_name(
                location,
                string(request, "name")?,
                symbol_flags(request)?,
                None,
                false,
                request["excludeGlobals"].as_bool().unwrap_or(false),
            ))),
            "getResolvedSignatureForSignatureHelp" => {
                let count = request["argumentCount"]
                    .as_i64()
                    .map_or(Ok(-1), i32::try_from);
                let (signature, candidates) = checker.get_resolved_signature_for_signature_help(
                    location,
                    count.map_err(|error| error.to_string())?,
                );
                Ok(
                    json!({"signature": self.signature_ref(signature), "candidates": self.signature_refs(&candidates)}),
                )
            }
            "containsArgumentsReference" => {
                Ok(json!(checker.contains_arguments_reference(location)))
            }
            "nodeBuilder" => self.build_node(&mut checker, location, t, symbol, signature, request),
            "tryGetMemberInModuleExportsAndProperties" => Ok(self.symbol_ref(
                checker.try_get_member_in_module_exports_and_properties(
                    string(request, "name")?,
                    symbol,
                ),
            )),
            "forEachExportAndPropertyOfModule" => {
                let mut entries = Vec::new();
                checker.for_each_export_and_property_of_module(symbol, &mut |_, exported, key| {
                    entries.push((exported, escape_symbol_name(key)));
                });
                Ok(Value::Array(
                    entries
                        .into_iter()
                        .map(|(exported, key)| {
                            json!([
                                self.symbol_ref(exported),
                                crate::classic_strings::string_value(&key)
                            ])
                        })
                        .collect(),
                ))
            }
            "getExportSymbolOfSymbol" => {
                Ok(self.symbol_ref(checker.get_export_symbol_of_symbol(symbol)))
            }
            "getPropertySymbolOfDestructuringAssignment" => {
                Ok(self
                    .symbol_ref(checker.get_property_symbol_of_destructuring_assignment(location)))
            }
            "getTypeOfAssignmentPattern" => {
                Ok(self.type_ref(checker.get_type_of_assignment_pattern(location)))
            }
            "getSuggestedSymbolForNonexistentSymbol" => Ok(self.symbol_ref(
                checker.get_suggested_symbol_for_nonexistent_symbol(
                    location,
                    string(request, "name")?,
                    symbol_flags(request)?,
                ),
            )),
            "getSuggestedSymbolForNonexistentModule" => Ok(self
                .symbol_ref(checker.get_suggested_symbol_for_nonexistent_module(location, symbol))),
            "isTypeParameterPossiblyReferenced" => Ok(json!(
                checker.is_type_parameter_possibly_referenced(t, location)
            )),
            "getResolvedSymbol" => {
                Ok(self.symbol_ref(checker.get_resolved_symbol_exported(location)))
            }
            "getTypeOnlyAliasDeclaration" => Ok(node_ref(
                checker.get_type_only_alias_declaration_exported(symbol),
            )),
            "getSymbolFlags" => Ok(json!(checker.get_symbol_flags_exported(symbol).0)),
            "getLocalTypeParametersOfClassOrInterfaceOrTypeAlias" => Ok(self.type_refs(
                &checker
                    .get_local_type_parameters_of_class_or_interface_or_type_alias_exported(symbol),
            )),
            "tryGetMemberInModuleExports" => Ok(self.symbol_ref(
                checker.try_get_member_in_module_exports(string(request, "name")?, symbol),
            )),
            "getTypePredicateOfSignature" => {
                let predicate = checker.get_type_predicate_of_signature_exported(signature);
                Ok(self.type_predicate(&checker, predicate))
            }
            "isDeclarationVisible" => {
                let resolver = checker.get_emit_resolver();
                Ok(json!(
                    resolver.is_declaration_visible(&mut checker, location)
                ))
            }
            "getExpandedParameters" => Ok(Value::Array(
                checker
                    .get_expanded_parameters_exported(
                        signature,
                        request["skipUnionExpanding"].as_bool().unwrap_or(false),
                    )
                    .iter()
                    .map(|parameters| self.symbol_refs(parameters))
                    .collect(),
            )),
            "getParameterIdentifierInfoAtPosition" => {
                let position = usize::try_from(number(request, "position")?)
                    .map_err(|error| error.to_string())?;
                Ok(
                    match crate::classic_parameters::parameter_identifier_info(
                        &mut checker,
                        signature,
                        position,
                    ) {
                        Some(info) => json!({"parameter": node_ref(info.parameter),
                            "parameterName": crate::classic_strings::string_value(&info.parameter_name),
                            "isRestParameter": info.is_rest_parameter}),
                        None => Value::Null,
                    },
                )
            }
            "hasEffectiveRestParameter" => Ok(json!(
                checker.has_effective_rest_parameter_exported(signature)
            )),
            "getJsxFragmentFactory" => {
                let entity = checker.get_jsx_fragment_factory_entity(location);
                Ok(if entity.is_nil() {
                    Value::Null
                } else {
                    json!(ts_goport::ast::get_first_identifier(entity).text())
                })
            }
            "getJsxIntrinsicTagNamesAt" => {
                Ok(self.symbol_refs(&checker.get_jsx_intrinsic_tag_names_at(location)))
            }
            "isContextSensitive" => Ok(json!(checker.is_context_sensitive_exported(location))),
            "getAccessibleSymbolChain" => {
                let chain = checker.get_accessible_symbol_chain_exported(
                    symbol,
                    location,
                    symbol_flags(request)?,
                    request["useOnlyExternalAliasing"]
                        .as_bool()
                        .unwrap_or(false),
                );
                // Classic answers undefined for no chain.
                Ok(if chain.is_empty() {
                    Value::Null
                } else {
                    self.symbol_refs(&chain)
                })
            }
            "isTypeInvalidDueToUnionDiscriminant" => Ok(json!(
                checker.is_type_invalid_due_to_union_discriminant(t, location)
            )),
            "getContextualTypeForArgumentAtIndex" => {
                let index = request["index"].as_i64().map_or(Ok(0), i32::try_from);
                Ok(
                    self.type_ref(checker.get_contextual_type_for_argument_at_index_exported(
                        location,
                        index.map_err(|error| error.to_string())?,
                    )),
                )
            }
            "getContextualTypeForObjectLiteralElement" => Ok(self.type_ref(
                checker.get_contextual_type_for_object_literal_element_exported(
                    location,
                    ContextFlags::NONE,
                ),
            )),
            "getContextualTypeForJsxAttribute" => {
                Ok(self.type_ref(checker.get_contextual_type_for_jsx_attribute_exported(location)))
            }
            "getTypeOfPropertyOfContextualType" => Ok(self.type_ref(
                checker
                    .get_type_of_property_of_contextual_type_exported(t, string(request, "name")?),
            )),
            "getSymbolsOfParameterPropertyDeclaration" => {
                let (parameter, property) = checker.get_symbols_of_parameter_property_declaration(
                    location,
                    string(request, "name")?,
                );
                Ok(json!([
                    self.symbol_ref(parameter),
                    self.symbol_ref(property)
                ]))
            }
            // The member's syntax arrives as facts: code fixes pass factory nodes the compiler
            // never parsed. The rest is Go `GetMemberOverrideModifierStatus`.
            // Classic `isLibType` is Go `IsLibTypeForHoverVerbosity`.
            "isLibType" => Ok(json!(checker.is_lib_type_for_hover_verbosity(t))),
            // Classic `getExactOptionalProperties`.
            "getExactOptionalProperties" => {
                let properties = checker.get_properties_of_type(t).to_vec();
                let mut result = Vec::new();
                for property in properties {
                    let property_type = checker.get_type_of_symbol(property);
                    if checker.contains_missing_type(property_type) {
                        result.push(self.symbol_ref(property));
                    }
                }
                Ok(Value::Array(result))
            }
            // Classic `getIndexInfosAtLocation`: the index infos of a property access's object
            // type that apply to the accessed name.
            "getIndexInfosAtLocation" => {
                let parent = location.parent();
                if !(ts_goport::ast::is_identifier(location)
                    && ts_goport::ast::is_property_access_expression(parent)
                    && parent.name() == location)
                {
                    return Ok(Value::Null);
                }
                let key_type = checker.get_literal_type_from_property_name(location);
                let object_type = checker.get_type_of_expression(parent.expression());
                let object_types = if checker.ty(object_type).flags.intersects(TypeFlags::UNION) {
                    checker.ty(object_type).types().to_vec()
                } else {
                    vec![object_type]
                };
                let mut result = Vec::new();
                for object in object_types {
                    for info in checker.get_index_infos_of_type(object).to_vec() {
                        let info_key = checker.index_info(info).key_type;
                        if checker.is_applicable_index_type(key_type, info_key) {
                            result.push(self.index_info(&checker, info));
                        }
                    }
                }
                Ok(Value::Array(result))
            }
            // Classic's synthetic checker objects, which code fixes build: a transient symbol
            // with the type its `links.type` held when it reached the checker, and anonymous
            // types, signatures and index infos over issued objects.
            "createSymbol" => {
                let flags = SymbolFlags(number(request, "flags")?);
                let name = request["name"]
                    .as_str()
                    .ok_or("symbol name must be a string")?;
                let created = checker.new_symbol(flags, name);
                checker.sym_mut(created).check_flags = CheckFlags(number(request, "checkFlags")?);
                if t.is_some() {
                    let checker = &mut *checker;
                    checker
                        .value_symbol_links
                        .get_by_id(&checker.symbols, created)
                        .resolved_type = t;
                }
                Ok(self.symbol_ref(created))
            }
            "createAnonymousType" => {
                let members: Vec<SymbolId> = Self::symbol_ids(request, "members", &self.symbols)?
                    .into_iter()
                    .map(SymbolId)
                    .collect();
                let members = checker.create_symbol_table(&members);
                let call: Vec<SignatureId> =
                    Self::ids(request, "callSignatures", &self.signatures)?
                        .into_iter()
                        .map(SignatureId)
                        .collect();
                let construct: Vec<SignatureId> =
                    Self::ids(request, "constructSignatures", &self.signatures)?
                        .into_iter()
                        .map(SignatureId)
                        .collect();
                let infos = request["indexInfos"]
                    .as_array()
                    .ok_or("indexInfos must be an array")?
                    .iter()
                    .map(|id| {
                        id.as_u64()
                            .and_then(|id| u32::try_from(id).ok())
                            .map(IndexInfoId)
                            .ok_or_else(|| "indexInfos must hold index infos".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let created =
                    checker.new_anonymous_type(symbol, members, &call, &construct, &infos);
                Ok(self.type_ref(created))
            }
            "createSignature" => {
                let type_parameters: Vec<TypeId> =
                    Self::ids(request, "typeParameters", &self.types)?
                        .into_iter()
                        .map(TypeId)
                        .collect();
                let parameters: Vec<SymbolId> =
                    Self::symbol_ids(request, "parameters", &self.symbols)?
                        .into_iter()
                        .map(SymbolId)
                        .collect();
                let this_parameter = SymbolId(Self::symbol_handle(
                    request,
                    "thisParameter",
                    &self.symbols,
                )?);
                let min_argument_count = i32::try_from(number(request, "minArgumentCount")?)
                    .map_err(|error| error.to_string())?;
                let created = checker.new_signature(
                    SignatureFlags(number(request, "signatureFlags")?),
                    location,
                    &type_parameters,
                    this_parameter,
                    &parameters,
                    t,
                    TypePredicateId(number(request, "typePredicate")?),
                    min_argument_count,
                );
                Ok(self.signature_ref(created))
            }
            "createIndexInfo" => {
                let value_type = TypeId(Self::handle(request, "valueType", &self.types)?);
                let readonly = request["isReadonly"].as_bool().unwrap_or(false);
                let created = checker.new_index_info(t, value_type, readonly, location, &[]);
                Ok(self.index_info(&checker, created))
            }
            "getMemberOverrideModifierStatus" => {
                let member = &request["member"];
                let fact = |name: &str| member[name].as_bool().unwrap_or(false);
                if !fact("hasName") || symbol.is_nil() {
                    return Ok(json!(0));
                }
                Ok(json!(
                    member_override_modifier_status(
                        &mut checker,
                        location,
                        symbol,
                        fact("hasOverride"),
                        fact("isAbstract"),
                        fact("isStatic"),
                    )
                    .0
                ))
            }
            "resolveExternalModuleName" => Ok(self
                .symbol_ref(checker.resolve_external_module_name_exported(location, TypeId::NIL))),
            "getConstantValue" => Ok(match checker.get_constant_value(location) {
                Some(LiteralValue::String(value)) => crate::classic_strings::string_value(&value),
                Some(LiteralValue::Number(value)) => json!(value.0),
                _ => Value::Null,
            }),
            "getStringLiteralType" => {
                Ok(self.type_ref(checker.get_string_literal_type(string(request, "value")?)))
            }
            "getNumberLiteralType" => {
                let value = request["value"].as_f64().ok_or("value must be a number")?;
                Ok(self.type_ref(checker.get_number_literal_type(ts_goport::jsnum::Number(value))))
            }
            "getTrueType" | "getFalseType" => {
                let fresh = request["fresh"].as_bool().unwrap_or(false);
                Ok(self.type_ref(match (method, fresh) {
                    ("getTrueType", true) => checker.true_type,
                    ("getTrueType", false) => checker.regular_true_type,
                    (_, true) => checker.false_type,
                    _ => checker.regular_false_type,
                }))
            }
            "isImplementationOfOverload" => Ok(json!(classic_is_implementation_of_overload(
                &mut checker,
                location
            ))),
            "isValidPropertyAccess" => Ok(json!(
                checker.is_valid_property_access_exported(location, string(request, "name")?)
            )),
            "isValidPropertyAccessForCompletions" => Ok(json!(
                checker.is_valid_property_access_for_completions_exported(location, t, symbol)
            )),
            "isPropertyAccessible" => Ok(json!(checker.is_property_accessible_exported(
                location,
                request["isSuper"].as_bool().unwrap_or(false),
                request["isWrite"].as_bool().unwrap_or(false),
                t,
                symbol,
            ))),
            "getJsxNamespace" => Ok(json!(checker.get_jsx_namespace_exported(location))),
            "getTypeArgumentConstraint" => {
                Ok(self.type_ref(checker.get_type_argument_constraint_exported(location)))
            }
            "getExportSpecifierLocalTargetSymbol" => {
                Ok(self.symbol_ref(checker.get_export_specifier_local_target_symbol(location)))
            }
            "getSuggestedSymbolForNonexistentProperty" => {
                Ok(self
                    .symbol_ref(checker.get_suggested_symbol_for_nonexistent_property(location, t)))
            }
            "getCandidateSignaturesForStringLiteralCompletions" => {
                let editing = node(request, "editingArgument")?;
                Ok(self.signature_refs(
                    &checker
                        .get_candidate_signatures_for_string_literal_completions(location, editing),
                ))
            }
            "getExportsAndPropertiesOfModule" => {
                Ok(self.symbol_refs(&checker.get_exports_and_properties_of_module(symbol)))
            }
            "resolveExternalModuleSymbol" => {
                Ok(self.symbol_ref(checker.resolve_external_module_symbol_exported(symbol)))
            }
            "getParameterType" => {
                let index = request["index"].as_i64().map_or(Ok(0), i32::try_from);
                Ok(self.type_ref(checker.get_type_at_position_exported(
                    signature,
                    index.map_err(|error| error.to_string())?,
                )))
            }
            "getPromiseType" => Ok(self.type_ref(checker.get_global_promise_type())),
            "getUnionType" => {
                let types = self.handles(request, "types", &self.types)?;
                let reduction = match number(request, "reduction")? {
                    0 => UnionReduction::NONE,
                    1 => UnionReduction::LITERAL,
                    2 => UnionReduction::SUBTYPE,
                    _ => return Err("union reduction must be None, Literal or Subtype".into()),
                };
                Ok(self.type_ref(checker.get_union_type_ex(&types, reduction, None, TypeId::NIL)))
            }
            "isTypeAssignableTo" => {
                let target = TypeId(Self::handle(request, "target", &self.types)?);
                Ok(json!(checker.is_type_assignable_to_exported(t, target)))
            }
            "getDiagnostics" => Ok(Value::Array(
                checker
                    .get_diagnostics(&self.context, location, false)
                    .iter()
                    .map(crate::classic_graph::diagnostic)
                    .collect(),
            )),
            "getGlobalDiagnostics" => Ok(Value::Array(
                checker
                    .get_global_diagnostics()
                    .iter()
                    .map(crate::classic_graph::diagnostic)
                    .collect(),
            )),
            _ => self.type_request(&mut checker, method, t, request),
        }
    }

    fn type_request(
        &self,
        checker: &mut Checker,
        method: &str,
        t: TypeId,
        request: &Value,
    ) -> Result<Value, String> {
        match method {
            "getPropertiesOfType" => {
                Ok(self.symbol_refs(&checker.get_properties_of_type_exported(t)))
            }
            "getAugmentedPropertiesOfType" => {
                Ok(self.symbol_refs(&checker.get_augmented_properties_of_type(t)))
            }
            "getPropertyOfType" => {
                Ok(self
                    .symbol_ref(checker.get_property_of_type_exported(t, string(request, "name")?)))
            }
            "getTypeOfPropertyOfType" => Ok(self.type_ref(
                checker.get_type_of_property_of_type_exported(t, string(request, "name")?),
            )),
            "getBaseTypes" => Ok(self.type_refs(&checker.get_base_types_exported(t))),
            "getTypeArguments" => Ok(self.type_refs(&checker.get_type_arguments_exported(t))),
            "getApparentType" => Ok(self.type_ref(checker.get_apparent_type_exported(t))),
            "getNonNullableType" => Ok(self.type_ref(checker.get_non_nullable_type(t))),
            "getNonOptionalType" => Ok(self.type_ref(checker.get_non_optional_type(t))),
            "isNullableType" => Ok(json!(checker.is_nullable_type(t))),
            "getWidenedType" => Ok(self.type_ref(checker.get_widened_type(t))),
            "typeHasCallOrConstructSignatures" => Ok(json!(
                checker.type_has_call_or_construct_signatures_exported(t)
            )),
            "getAllPossiblePropertiesOfTypes" => {
                let types = self.handles(request, "types", &self.types)?;
                Ok(self.symbol_refs(&checker.get_all_possible_properties_of_types(&types)))
            }
            "getWidenedLiteralType" => {
                Ok(self.type_ref(checker.get_widened_literal_type_exported(t)))
            }
            "getBaseTypeOfLiteralType" => {
                Ok(self.type_ref(checker.get_base_type_of_literal_type_exported(t)))
            }
            "getBaseConstraintOfType" => {
                Ok(self.type_ref(checker.get_base_constraint_of_type_exported(t)))
            }
            "getDefaultFromTypeParameter" => {
                Ok(self.type_ref(checker.get_default_from_type_parameter_exported(t)))
            }
            "getConstraintOfTypeParameter" => {
                Ok(self.type_ref(checker.get_constraint_of_type_parameter_exported(t)))
            }
            "getAwaitedType" => Ok(self.type_ref(checker.get_awaited_type_exported(t))),
            "isArrayType" => Ok(json!(checker.is_array_type_exported(t))),
            "isEmptyAnonymousObjectType" => Ok(json!(checker.is_empty_anonymous_object_type(t))),
            "isTupleType" => Ok(json!(checker.is_tuple_type_exported(t))),
            "isArrayLikeType" => Ok(json!(checker.is_array_like_type_exported(t))),
            "getPromisedTypeOfPromise" => {
                let error_node = node(request, "errorNode")?;
                Ok(self.type_ref(checker.get_promised_type_of_promise_ex(t, error_node, None)))
            }
            "createPromiseType" => Ok(self.type_ref(checker.create_promise_type(t))),
            "getIndexType" => Ok(self.type_ref(checker.get_index_type(t))),
            "createArrayType" => Ok(self.type_ref(
                checker.create_array_type_ex(t, request["readonly"].as_bool().unwrap_or(false)),
            )),
            "getElementTypeOfArrayType" => {
                Ok(self.type_ref(checker.get_element_type_of_array_type_exported(t)))
            }
            "getIndexInfoOfType" => {
                let key_type = match number(request, "kind")? {
                    0 => checker.get_string_type(),
                    1 => checker.get_number_type(),
                    _ => return Err("index kind must be String or Number".into()),
                };
                let info = checker.get_index_info_of_type_exported(t, key_type);
                Ok(self.index_info(checker, info))
            }
            "getIndexInfosOfType" => Ok(Value::Array(
                checker
                    .get_index_infos_of_type_exported(t)
                    .into_iter()
                    .map(|info| self.index_info(checker, info))
                    .collect(),
            )),
            "getUnmatchedProperties" => {
                let target = TypeId(Self::handle(request, "target", &self.types)?);
                Ok(self.symbol_refs(
                    &checker.get_unmatched_properties(
                        t,
                        target,
                        request["requireOptionalProperties"]
                            .as_bool()
                            .unwrap_or(false),
                        request["matchDiscriminantProperties"]
                            .as_bool()
                            .unwrap_or(false),
                    ),
                ))
            }
            _ => self.intrinsic_type(checker, method),
        }
    }

    /// The node builder's synthesized nodes for a classic `typeToTypeNode`, `symbolToNode` and
    /// the other builder members: each node tree as binary AST data with the symbols the builder
    /// recorded for its identifiers (classic sets `identifier.symbol`).
    fn build_node(
        &self,
        checker: &mut Checker,
        enclosing: Node,
        t: TypeId,
        symbol: SymbolId,
        signature: SignatureId,
        request: &Value,
    ) -> Result<Value, String> {
        let flags = NodeBuilderFlags(number(request, "flags")?);
        let internal = InternalNodeBuilderFlags(
            i32::try_from(number(request, "internalFlags")?).map_err(|error| error.to_string())?,
        );
        let meaning = symbol_flags(request)?;
        let builder = checker.get_node_builder_ex(None);
        // Classic's `maximumLength`, `verbosityLevel` and `out` arguments: Go's hover
        // `VerbosityContext`, whose output cells the node builder sets.
        let verbosity = request
            .get("verbosity")
            .filter(|value| !value.is_null())
            .map(|value| -> Result<VerbosityContext, String> {
                let integer = |key: &str, missing: i64| {
                    i32::try_from(value[key].as_i64().unwrap_or(missing))
                        .map_err(|error| error.to_string())
                };
                Ok(VerbosityContext {
                    level: integer("level", -1)?,
                    max_truncation_length: integer("maximumLength", 0)?,
                    ..Default::default()
                })
            })
            .transpose()?;
        builder.borrow_mut().verbosity = verbosity.clone();
        let nodes = match string(request, "operation")? {
            // Classic `getEmitResolver().symbolToDeclarations`: Go's hover expansion of a class,
            // enum, namespace or interface into declarations, with classic's modifier simplification.
            "symbolToDeclarations" => {
                checker.node_builder_expand_symbol_for_hover(&builder, symbol, meaning)
            }
            "typeToTypeNode" => vec![
                checker
                    .node_builder_type_to_type_node(&builder, t, enclosing, flags, internal, None),
            ],
            "typeParameterToDeclaration" => {
                vec![checker.node_builder_type_parameter_to_declaration(
                    &builder, t, enclosing, flags, internal, None,
                )]
            }
            "symbolToEntityName" => vec![checker.node_builder_symbol_to_entity_name(
                &builder, symbol, meaning, enclosing, flags, internal, None,
            )],
            "symbolToExpression" => vec![checker.node_builder_symbol_to_expression(
                &builder, symbol, meaning, enclosing, flags, internal, None,
            )],
            "symbolToNode" => vec![checker.node_builder_symbol_to_node(
                &builder, symbol, meaning, enclosing, flags, internal, None,
            )],
            "symbolToParameterDeclaration" => {
                vec![checker.node_builder_symbol_to_parameter_declaration(
                    &builder, symbol, enclosing, flags, internal, None,
                )]
            }
            // Classic's rule (`typeParametersToTypeParameterDeclarations`): a class, interface or
            // type alias target gives its local type parameters, any other symbol none. Go also
            // takes functions and tests `Alias` where classic tests `TypeAlias`.
            "symbolToTypeParameterDeclarations" => {
                let target = checker.get_target_symbol(symbol);
                if !checker.sym(target).flags.intersects(
                    SymbolFlags::CLASS | SymbolFlags::INTERFACE | SymbolFlags::TYPE_ALIAS,
                ) {
                    return Ok(Value::Null);
                }
                checker
                    .get_local_type_parameters_of_class_or_interface_or_type_alias(symbol)
                    .into_iter()
                    .map(|parameter| {
                        checker.node_builder_type_parameter_to_declaration(
                            &builder, parameter, enclosing, flags, internal, None,
                        )
                    })
                    .collect()
            }
            "signatureToSignatureDeclaration" => {
                let kind = u16::try_from(number(request, "kind")?)
                    .ok()
                    .and_then(|kind| SyntaxKind::try_from(kind).ok())
                    .ok_or("signature declaration kind is not a syntax kind")?;
                vec![checker.node_builder_signature_to_signature_declaration(
                    &builder, signature, kind, enclosing, flags, internal, None,
                )]
            }
            "typePredicateToTypePredicateNode" => {
                vec![checker.node_builder_type_predicate_to_type_predicate_node(
                    &builder,
                    TypePredicateId(number(request, "typePredicate")?),
                    enclosing,
                    flags,
                    internal,
                    None,
                )]
            }
            "indexInfoToIndexSignatureDeclaration" => {
                let info = IndexInfoId(number(request, "indexInfo")?);
                vec![
                    checker.node_builder_index_info_to_index_signature_declaration(
                        &builder, info, enclosing, flags, internal, None,
                    ),
                ]
            }
            operation => return Err(format!("unknown node builder operation: {operation}")),
        };
        builder.borrow_mut().verbosity = None;
        let identifiers = builder.borrow().impl_.borrow().id_to_symbol.clone();
        let emit_context = builder.borrow().impl_.borrow().e.clone();
        let mut results = Vec::with_capacity(nodes.len());
        for node in nodes {
            if node.is_nil() {
                results.push(Value::Null);
                continue;
            }
            let (bytes, table) =
                encoder::encode_node(node, Node::NIL).map_err(|error| error.to_string())?;
            let (offset, length) = crate::exports::push_payload(&bytes);
            // Classic's builder names declarations with bare identifiers
            // (`getPropertyNameNodeForSymbol`, `symbolTableToDeclarationStatements`); only entity
            // names and type parameter names carry the symbol the printer writes.
            let declaration_names: HashSet<Node> = table
                .nodes
                .iter()
                .filter(|node| node.is_some() && is_bare_named_declaration(node.kind()))
                .map(|node| node.name())
                .filter(|name| name.is_some())
                .collect();
            let symbols = table
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, node)| !declaration_names.contains(*node))
                .filter_map(|(index, node)| {
                    let symbol = identifiers.get(node)?;
                    Some(json!([index, self.symbol_ref(*symbol)]))
                })
                .collect::<Vec<_>>();
            // Classic's builder marks nodes (single-line type literals and tuples, unescaped
            // literals) with emit flags; the port records the same flags in its emit context.
            let emit_flags = table
                .nodes
                .iter()
                .enumerate()
                .filter_map(|(index, node)| {
                    let flags = emit_context.emit_flags(*node);
                    (flags != EmitFlags::NONE).then(|| json!([index, flags.bits()]))
                })
                .collect::<Vec<_>>();
            // Classic `singleQuote`: a literal the builder makes takes the quote it chose; a source
            // literal it reuses keeps classic's parsed `undefined` unless the builder's flags ask
            // for single quotes. The port's reused literals keep the parser's quote flag.
            let single_quotes = table
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, node)| node.is_some() && node.kind() == SyntaxKind::StringLiteral)
                .filter(|(_, node)| {
                    if node.pos() >= 0 || emit_context.original(**node).is_some() {
                        flags
                            .intersects(NodeBuilderFlags::USE_SINGLE_QUOTES_FOR_STRING_LITERAL_TYPE)
                    } else {
                        node.token_flags().intersects(TokenFlags::SINGLE_QUOTE)
                    }
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            // Synthetic comments, such as the `... N more elided ...` comment on an elided union.
            let comment = |comment: &ts_goport::printer::SynthesizedComment| {
                json!([
                    comment.kind as u32,
                    comment.text,
                    comment.has_leading_new_line,
                    comment.has_trailing_new_line
                ])
            };
            let comments = table
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, node)| node.is_some())
                .filter_map(|(index, node)| {
                    let leading = emit_context.get_synthetic_leading_comments(*node);
                    let trailing = emit_context.get_synthetic_trailing_comments(*node);
                    (!leading.is_empty() || !trailing.is_empty()).then(|| {
                        json!([
                            index,
                            leading.iter().map(comment).collect::<Vec<_>>(),
                            trailing.iter().map(comment).collect::<Vec<_>>()
                        ])
                    })
                })
                .collect::<Vec<_>>();
            results.push(json!({"$synthetic": {"$payload": [offset, length]}, "symbols": symbols, "emitFlags": emit_flags, "singleQuotes": single_quotes, "comments": comments}));
        }
        Ok(match verbosity {
            Some(verbosity) => {
                json!({"nodes": results, "canIncreaseExpansionDepth": verbosity.can_increase_verbosity.get(),
                "truncated": verbosity.truncated.get()})
            }
            None => Value::Array(results),
        })
    }

    /// Classic `TypePredicate`, or none for the checker's no-predicate sentinel.
    fn type_predicate(&self, checker: &Checker, predicate: TypePredicateId) -> Value {
        if predicate.is_nil() || predicate == checker.no_type_predicate {
            return Value::Null;
        }
        let data = checker.pred(predicate);
        let mut result = json!({"$typePredicate": predicate.0, "kind": data.kind.0, "type": self.type_ref(data.t)});
        if matches!(
            data.kind,
            TypePredicateKind::IDENTIFIER | TypePredicateKind::ASSERTS_IDENTIFIER
        ) {
            result["parameterName"] = crate::classic_strings::string_value(&data.parameter_name);
            result["parameterIndex"] = json!(data.parameter_index);
        }
        result
    }

    /// Classic `IndexInfo`; `id` keeps one object per index info of the checker.
    fn index_info(&self, checker: &Checker, info: IndexInfoId) -> Value {
        if info.is_nil() {
            return Value::Null;
        }
        let data = checker.index_info(info);
        let mut result = json!({"$indexInfo": info.0, "keyType": self.type_ref(data.key_type),
            "type": self.type_ref(data.value_type), "isReadonly": data.is_readonly,
            "declaration": node_ref(data.declaration)});
        if !data.components.is_empty() {
            result["components"] =
                Value::Array(data.components.iter().copied().map(node_ref).collect());
        }
        result
    }

    fn handles(
        &self,
        request: &Value,
        key: &str,
        issued: &RefCell<HashSet<u32>>,
    ) -> Result<Vec<TypeId>, String> {
        let values = request[key]
            .as_array()
            .ok_or_else(|| format!("{key} must be an array"))?;
        values
            .iter()
            .map(|value| {
                let id = value
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or_else(|| format!("{key} must hold handles"))?;
                if issued.borrow().contains(&id) {
                    Ok(TypeId(id))
                } else {
                    Err(format!("{key} handle was not issued by this checker"))
                }
            })
            .collect()
    }

    /// A list of handles this checker issued.
    fn ids(request: &Value, key: &str, issued: &RefCell<HashSet<u32>>) -> Result<Vec<u32>, String> {
        let values = request[key]
            .as_array()
            .ok_or_else(|| format!("{key} must be an array"))?;
        values
            .iter()
            .map(|value| {
                let id = value
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or_else(|| format!("{key} must hold handles"))?;
                if issued.borrow().contains(&id) {
                    Ok(id)
                } else {
                    Err(format!("{key} handle was not issued by this checker"))
                }
            })
            .collect()
    }

    /// A symbol this checker issued, or a binder lineage symbol, which names the same symbol in
    /// every checker of the instance, as a classic binder symbol is shared by every program
    /// that holds its file.
    fn symbol_handle(
        request: &Value,
        key: &str,
        issued: &RefCell<HashSet<u32>>,
    ) -> Result<u32, String> {
        let id = number(request, key)?;
        if id != 0 && !ts_goport::core::is_own_index(id) {
            issued.borrow_mut().insert(id);
        }
        Self::handle(request, key, issued)
    }

    fn symbol_ids(
        request: &Value,
        key: &str,
        issued: &RefCell<HashSet<u32>>,
    ) -> Result<Vec<u32>, String> {
        for id in request[key].as_array().into_iter().flatten() {
            if let Some(id) = id.as_u64().and_then(|id| u32::try_from(id).ok())
                && id != 0
                && !ts_goport::core::is_own_index(id)
            {
                issued.borrow_mut().insert(id);
            }
        }
        Self::ids(request, key, issued)
    }

    fn handle(request: &Value, key: &str, issued: &RefCell<HashSet<u32>>) -> Result<u32, String> {
        let id = number(request, key)?;
        if id == 0 || issued.borrow().contains(&id) {
            return Ok(id);
        }
        Err(format!("{key} handle was not issued by this checker"))
    }

    fn type_ref(&self, t: TypeId) -> Value {
        reference(&self.types, t.0, "$type")
    }

    fn symbol_ref(&self, symbol: SymbolId) -> Value {
        let mut value = reference(&self.symbols, symbol.0, "$symbol");
        if symbol.is_some() && !ts_goport::core::is_own_index(symbol.0) {
            value["lineage"] = json!(true);
        }
        value
    }

    fn signature_ref(&self, signature: SignatureId) -> Value {
        reference(&self.signatures, signature.0, "$signature")
    }

    fn type_refs(&self, types: &[TypeId]) -> Value {
        Value::Array(types.iter().map(|&t| self.type_ref(t)).collect())
    }

    fn symbol_refs(&self, symbols: &[SymbolId]) -> Value {
        Value::Array(
            symbols
                .iter()
                .map(|&symbol| self.symbol_ref(symbol))
                .collect(),
        )
    }

    fn signature_refs(&self, signatures: &[SignatureId]) -> Value {
        Value::Array(
            signatures
                .iter()
                .map(|&signature| self.signature_ref(signature))
                .collect(),
        )
    }

    fn intrinsic_type(&self, checker: &Checker, method: &str) -> Result<Value, String> {
        let t = match method {
            "getAnyType" => checker.get_any_type(),
            "getStringType" => checker.get_string_type(),
            "getNumberType" => checker.get_number_type(),
            "getBooleanType" => checker.get_boolean_type(),
            "getVoidType" => checker.get_void_type(),
            "getUndefinedType" => checker.get_undefined_type(),
            "getNullType" => checker.get_null_type(),
            "getNeverType" => checker.get_never_type(),
            "getUnknownType" => checker.get_unknown_type(),
            "getBigIntType" => checker.get_big_int_type(),
            "getESSymbolType" => checker.get_es_symbol_type(),
            "getErrorType" => checker.get_error_type(),
            _ => return Err(format!("unknown checker operation: {method}")),
        };
        Ok(self.type_ref(t))
    }

    fn type_data(&self, checker: &Checker, t: TypeId) -> Result<Value, String> {
        if t.is_nil() {
            return Err("type handle is required".into());
        }
        let mut response = proto::new_type_response(checker, t, proto::TypeID(t.0));
        let literal = std::mem::take(&mut response.value);
        let texts = std::mem::take(&mut response.texts);
        let intrinsic = std::mem::take(&mut response.intrinsic_name);
        let mut data = crate::classic_strings::json_value(&response)?;
        data["value"] = crate::classic_strings::from_any(literal);
        if !texts.is_empty() {
            data["texts"] = Value::Array(
                texts
                    .iter()
                    .map(|text| crate::classic_strings::string_value(text))
                    .collect(),
            );
        }
        if !intrinsic.is_empty() {
            data["intrinsicName"] = crate::classic_strings::string_value(&intrinsic);
        }
        let ty = checker.ty(t);
        data["symbol"] = self.symbol_ref(ty.symbol());
        data["aliasSymbol"] = ty
            .alias()
            .map_or(Value::Null, |alias| self.symbol_ref(alias.symbol()));
        if ty
            .flags()
            .intersects(TypeFlags::UNION_OR_INTERSECTION | TypeFlags::TEMPLATE_LITERAL)
        {
            data["types"] = self.type_refs(ty.types());
        }
        for key in [
            "target",
            "objectType",
            "indexType",
            "checkType",
            "extendsType",
            "baseType",
            "substConstraint",
            "typeParameter",
            "constraintType",
            "nameType",
            "templateType",
            "freshType",
            "regularType",
            "thisType",
        ] {
            if let Some(id) = data[key].as_u64() {
                data[key] = self.type_ref(TypeId(
                    u32::try_from(id).map_err(|error| error.to_string())?,
                ));
            }
        }
        // Classic's index and string mapping types name their operand `type`; Go's `target`.
        if ty
            .flags()
            .intersects(TypeFlags::INDEX | TypeFlags::STRING_MAPPING)
            && let Some(target) = data.as_object_mut().and_then(|data| data.remove("target"))
        {
            data["type"] = target;
        }
        for key in [
            "typeParameters",
            "outerTypeParameters",
            "localTypeParameters",
            "aliasTypeArguments",
        ] {
            let Some(values) = data[key].as_array_mut() else {
                continue;
            };
            for value in values {
                let id = value.as_u64().ok_or("type reference is not an integer")?;
                let id = u32::try_from(id).map_err(|error| error.to_string())?;
                *value = self.type_ref(TypeId(id));
            }
        }
        Ok(data)
    }

    fn symbol_data(&self, checker: &Checker, symbol: SymbolId) -> Value {
        if symbol.is_nil() {
            return Value::Null;
        }
        let data = checker.sym(symbol);
        let mut links = Value::Null;
        if data.flags.intersects(SymbolFlags::TRANSIENT) {
            let (target, name_type) = checker
                .value_symbol_links
                .try_get_by_id(&checker.symbols, symbol)
                .map_or((SymbolId::NIL, TypeId::NIL), |links| {
                    (links.target, links.name_type)
                });
            links = json!({"checkFlags": classic_check_flags(data.check_flags), "target": self.symbol_ref(target)});
            // Classic `links.nameType`: a mapped or late-bound member's property name type.
            if name_type.is_some() {
                links["nameType"] = self.type_ref(name_type);
            }
            // Classic `links.target` and `links.originatingImport` of the uncallable namespace
            // symbol `resolveESModuleSymbol` makes; the port keeps them in its export type links.
            if let Some(export) = checker.export_type_links.try_get(symbol) {
                if target.is_nil() {
                    links["target"] = self.symbol_ref(export.target);
                }
                if export.originating_import.is_some() {
                    links["originatingImport"] = node_ref(export.originating_import);
                }
            }
        }
        // The port's index symbol is a transient property; classic's is a `Signature` symbol
        // (`getApplicableIndexSymbol`) without a value declaration.
        let index_symbol = data.check_flags.intersects(CheckFlags::INDEX_SYMBOL);
        let flags = if index_symbol {
            SymbolFlags::TRANSIENT | SymbolFlags::SIGNATURE
        } else {
            data.flags
        };
        let value_declaration = if index_symbol {
            Node::NIL
        } else {
            data.value_declaration
        };
        json!({"id": symbol.0, "flags": flags.0, "links": links,
            "hasMembers": data.members.is_some(), "hasExports": data.exports.is_some(), "escapedName": crate::classic_strings::string_value(&escape_symbol_name(&go_symbol_name(&checker.symbols, symbol))),
            "declarations": data.declarations.iter().copied().map(node_ref).collect::<Vec<_>>(), "valueDeclaration": node_ref(value_declaration),
            "parent": self.symbol_ref(data.parent), "exportSymbol": self.symbol_ref(data.export_symbol)})
    }

    fn signature_data(&self, checker: &Checker, signature: SignatureId) -> Value {
        if signature.is_nil() {
            return Value::Null;
        }
        let data = checker.sig(signature);
        let mut result = json!({"id": signature.0, "flags": data.flags().0, "declaration": node_ref(data.declaration()),
            "parameters": self.symbol_refs(data.parameters()),
            "thisParameter": self.symbol_ref(data.this_parameter()), "target": self.signature_ref(data.target()),
            "minArgumentCount": data.min_argument_count});
        if !data.type_parameters().is_empty() {
            result["typeParameters"] = self.type_refs(data.type_parameters());
        }
        result
    }
}

fn reference(issued: &RefCell<HashSet<u32>>, id: u32, kind: &str) -> Value {
    if id == 0 {
        return Value::Null;
    }
    issued.borrow_mut().insert(id);
    json!({kind: id})
}

fn number(request: &Value, key: &str) -> Result<u32, String> {
    let Some(value) = request.get(key) else {
        return Ok(0);
    };
    let value = value
        .as_u64()
        .ok_or_else(|| format!("{key} must be a nonnegative integer"))?;
    u32::try_from(value).map_err(|error| error.to_string())
}

fn string<'a>(request: &'a Value, key: &str) -> Result<&'a str, String> {
    request[key]
        .as_str()
        .ok_or_else(|| format!("{key} must be a string"))
}

/// A node the request names beside its location, or nil.
fn node(request: &Value, key: &str) -> Result<Node, String> {
    crate::classic_sources::with_sources(|sources| sources.resolve(&request[key]))
}

/// Symbol flags the facade translated to the port's bits.
fn symbol_flags(request: &Value) -> Result<SymbolFlags, String> {
    number(request, "meaning").map(SymbolFlags)
}

fn signature_kind(request: &Value) -> Result<SignatureKind, String> {
    match number(request, "kind")? {
        0 => Ok(SignatureKind::CALL),
        1 => Ok(SignatureKind::CONSTRUCT),
        _ => Err("signature kind must be Call or Construct".into()),
    }
}

/// Declarations whose names classic's node builder makes without a symbol.
fn is_bare_named_declaration(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::PropertySignature
            | SyntaxKind::PropertyDeclaration
            | SyntaxKind::MethodSignature
            | SyntaxKind::MethodDeclaration
            | SyntaxKind::GetAccessor
            | SyntaxKind::SetAccessor
            | SyntaxKind::PropertyAssignment
            | SyntaxKind::EnumMember
            | SyntaxKind::Parameter
            | SyntaxKind::ClassDeclaration
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::EnumDeclaration
            | SyntaxKind::TypeAliasDeclaration
            | SyntaxKind::FunctionDeclaration
            | SyntaxKind::VariableDeclaration
    )
}

/// Classic `CheckFlags` for the port's: the same flags by name; the port's own flags
/// (write containment, discriminant caching, index symbols) have no classic bit.
fn classic_check_flags(flags: CheckFlags) -> u32 {
    const BITS: [(CheckFlags, u32); 21] = [
        (CheckFlags::INSTANTIATED, 1 << 0),
        (CheckFlags::SYNTHETIC_PROPERTY, 1 << 1),
        (CheckFlags::SYNTHETIC_METHOD, 1 << 2),
        (CheckFlags::READONLY, 1 << 3),
        (CheckFlags::READ_PARTIAL, 1 << 4),
        (CheckFlags::WRITE_PARTIAL, 1 << 5),
        (CheckFlags::HAS_NON_UNIFORM_TYPE, 1 << 6),
        (CheckFlags::HAS_LITERAL_TYPE, 1 << 7),
        (CheckFlags::CONTAINS_PUBLIC, 1 << 8),
        (CheckFlags::CONTAINS_PROTECTED, 1 << 9),
        (CheckFlags::CONTAINS_PRIVATE, 1 << 10),
        (CheckFlags::CONTAINS_STATIC, 1 << 11),
        (CheckFlags::LATE, 1 << 12),
        (CheckFlags::REVERSE_MAPPED, 1 << 13),
        (CheckFlags::OPTIONAL_PARAMETER, 1 << 14),
        (CheckFlags::REST_PARAMETER, 1 << 15),
        (CheckFlags::DEFERRED_TYPE, 1 << 16),
        (CheckFlags::HAS_NEVER_TYPE, 1 << 17),
        (CheckFlags::MAPPED, 1 << 18),
        (CheckFlags::STRIP_OPTIONAL, 1 << 19),
        (CheckFlags::UNRESOLVED, 1 << 20),
    ];
    BITS.iter()
        .filter(|(bit, _)| flags.intersects(*bit))
        .fold(0, |result, (_, classic)| result | classic)
}

/// Classic `isImplementationOfOverload`: a function-like declaration with a body whose symbol
/// has another signature.
fn classic_is_implementation_of_overload(checker: &mut Checker, node: Node) -> bool {
    if !ts_goport::ast::node_is_present(node.body()) {
        return false;
    }
    if matches!(
        node.kind(),
        SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
    ) {
        return false;
    }
    let symbol = checker.get_symbol_of_declaration(node);
    let signatures = checker.get_signatures_of_symbol(symbol);
    signatures.len() > 1
        || (signatures.len() == 1 && checker.sig(signatures[0]).declaration() != node)
}

fn classic_type_from_type_node(checker: &mut Checker, node: Node) -> TypeId {
    if matches!(
        node.kind(),
        SyntaxKind::Identifier | SyntaxKind::QualifiedName | SyntaxKind::PropertyAccessExpression
    ) {
        let symbol = checker.get_symbol_at_location_exported(node);
        let t = if symbol.is_nil() {
            checker.get_error_type()
        } else {
            checker.get_declared_type_of_symbol_exported(symbol)
        };
        return checker.get_conditional_flow_type_of_type(t, node);
    }
    checker.get_type_from_type_node_exported(node)
}

fn classic_type_at_location(checker: &mut Checker, node: Node) -> TypeId {
    if is_part_of_type_node(node)
        && matches!(
            node.kind(),
            SyntaxKind::Identifier
                | SyntaxKind::QualifiedName
                | SyntaxKind::PropertyAccessExpression
        )
    {
        return classic_type_from_type_node(checker, node);
    }
    // Classic `checkMetaPropertyKeyword` for the keyword of `import.meta` or `new.target`; Go's is
    // an unported stub that answers the error type.
    let parent = node.parent();
    if parent.is_some()
        && parent.kind() == SyntaxKind::MetaProperty
        && parent.keyword_token() == node.kind()
    {
        return classic_meta_property_keyword_type(checker, parent);
    }
    // Classic `getTypeOfNode` answers import attributes with the global `ImportAttributes`
    // type; Go's has no case for them.
    if node.kind() == SyntaxKind::ImportAttributes {
        return checker.get_global_import_attributes_type();
    }
    checker.get_type_at_location(node)
}

/// Classic `checkMetaPropertyKeyword` with `createNewTargetExpressionType`.
fn classic_meta_property_keyword_type(checker: &mut Checker, node: Node) -> TypeId {
    if node.keyword_token() == SyntaxKind::ImportKeyword {
        return checker.get_global_import_meta_expression_type();
    }
    let target_type = checker.check_new_target_meta_property(node);
    if checker.is_error_type(target_type) {
        return checker.error_type;
    }
    let symbol = checker.new_symbol(SymbolFlags::NONE, "NewTargetExpression");
    let target = checker.new_symbol_ex(SymbolFlags::PROPERTY, "target", CheckFlags::READONLY);
    checker.sym_mut(target).parent = symbol;
    checker
        .value_symbol_links
        .get_by_id(&checker.symbols, target)
        .resolved_type = target_type;
    let members = checker.create_symbol_table(&[target]);
    checker.sym_mut(symbol).members = members;
    checker.new_anonymous_type(symbol, members, &[], &[], &[])
}

/// Go `GetMemberOverrideModifierStatus` (checker.go) after its member reads.
fn member_override_modifier_status(
    checker: &mut Checker,
    node: Node,
    member_symbol: SymbolId,
    has_override: bool,
    is_abstract: bool,
    is_static: bool,
) -> ts_goport::flags::MemberOverrideStatus {
    let class_symbol = checker.get_symbol_of_declaration(node);
    if class_symbol.is_nil() {
        return ts_goport::flags::MemberOverrideStatus::NONE;
    }
    let t = checker.get_declared_type_of_symbol(class_symbol);
    let type_with_this = checker.get_type_with_this_argument(t, TypeId::NIL, false);
    let static_type = checker.get_type_of_symbol(class_symbol);
    let mut base_with_this = TypeId::NIL;
    if ts_goport::ast::get_class_extends_heritage_element(node).is_some() {
        let base_types = checker.get_base_types(t);
        if !base_types.is_empty() {
            let this_type = checker.ty(t).as_interface_type().this_type;
            base_with_this = checker.get_type_with_this_argument(base_types[0], this_type, false);
        }
    }
    let base_static_type = checker.get_base_constructor_type_of_class(t);
    checker.check_member_for_override_modifier_worker(
        node,
        static_type,
        base_static_type,
        base_with_this,
        t,
        type_with_this,
        has_override,
        is_abstract,
        is_static,
        false, /*memberIsParameterProperty*/
        member_symbol,
        Node::NIL, /*errorNode*/
    )
}

fn node_ref(node: Node) -> Value {
    if node.is_nil() {
        return Value::Null;
    }
    let file = get_source_file_of_node(node);
    let table = encoder::get_node_index_table(file);
    json!({"$node": {"fileName": ts_goport::ast::source_file_info(file).file_name, "fileId": file.file_index(), "index": table.get_index(node), "nativeKind": node.kind() as u32}})
}
