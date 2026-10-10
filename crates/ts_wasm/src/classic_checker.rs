use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use serde_json::{Value, json};
use ts_goport::api::{encoder, proto};
use ts_goport::ast::{escape_symbol_name, get_source_file_of_node, is_part_of_type_node};
use ts_goport::astdata::SyntaxKind;
use ts_goport::binder::go_symbol_name;
use ts_goport::checker::Checker;
use ts_goport::core::{IndexInfoId, Node, SignatureId, SymbolId, TypeId};
use ts_goport::flags::{ContextFlags, SignatureKind, SymbolFlags, TypeFlags};
use ts_goport::frontend::compiler::NewProgram;
use ts_goport::gostd::Context;
use ts_goport::program::ls_program;

pub struct ClassicChecker {
    checker: Rc<RefCell<Checker>>,
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
            types: RefCell::default(),
            symbols: RefCell::default(),
            signatures: RefCell::default(),
        }
    }

    pub fn request(&self, location: Node, request: &Value) -> Result<Value, String> {
        let method = request["method"]
            .as_str()
            .ok_or("checker method is required")?;
        let t = TypeId(Self::handle(request, "type", &self.types)?);
        let symbol = SymbolId(Self::handle(request, "symbol", &self.symbols)?);
        let signature = SignatureId(Self::handle(request, "signature", &self.signatures)?);
        let mut checker = self.checker.borrow_mut();
        ts_goport::program::catch_up_checker(&mut checker.symbols);
        match method {
            "getTypeData" => self.type_data(&checker, t),
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
            "getExportsOfModule" => {
                Ok(self.symbol_refs(&checker.get_exports_of_module_exported(symbol)))
            }
            "isOptionalParameter" => Ok(json!(checker.is_optional_parameter(location))),
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
            "isTupleType" => Ok(json!(checker.is_tuple_type_exported(t))),
            "isArrayLikeType" => Ok(json!(checker.is_array_like_type_exported(t))),
            "getPromisedTypeOfPromise" => {
                let error_node = node(request, "errorNode")?;
                Ok(self.type_ref(checker.get_promised_type_of_promise_ex(t, error_node, None)))
            }
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
        reference(&self.symbols, symbol.0, "$symbol")
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
        json!({"id": symbol.0, "flags": data.flags.0, "escapedName": crate::classic_strings::string_value(&escape_symbol_name(&go_symbol_name(&checker.symbols, symbol))),
            "declarations": data.declarations.iter().copied().map(node_ref).collect::<Vec<_>>(), "valueDeclaration": node_ref(data.value_declaration),
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
    checker.get_type_at_location(node)
}

fn node_ref(node: Node) -> Value {
    if node.is_nil() {
        return Value::Null;
    }
    let file = get_source_file_of_node(node);
    let table = encoder::get_node_index_table(file);
    json!({"$node": {"fileName": ts_goport::ast::source_file_info(file).file_name, "fileId": file.file_index(), "index": table.get_index(node), "nativeKind": node.kind() as u32}})
}
