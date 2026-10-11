use ts_goport::ast::{escape_symbol_name, is_identifier, is_parameter_declaration};
use ts_goport::binder::go_symbol_name;
use ts_goport::checker::Checker;
use ts_goport::core::{Node, SignatureId, SymbolId};

pub struct ParameterIdentifierInfo {
    pub parameter: Node,
    pub parameter_name: String,
    pub is_rest_parameter: bool,
}

/// TypeScript 6.0.3 checker.ts `getParameterIdentifierInfoAtPosition`.
pub fn parameter_identifier_info(
    checker: &mut Checker,
    signature: SignatureId,
    position: usize,
) -> Option<ParameterIdentifierInfo> {
    // Classic answers none for a JSDoc function type; the port parses those as reparsed
    // function types, whose signatures are answered like any other.
    let parameters = checker.sig(signature).parameters().to_vec();
    let count = parameters
        .len()
        .saturating_sub(usize::from(checker.signature_has_rest_parameter(signature)));
    if position < count {
        return identifier_info(checker, parameters[position], false);
    }
    let rest = parameters
        .get(count)
        .copied()
        .unwrap_or(checker.get_unknown_symbol());
    let info = identifier_info(checker, rest, true)?;
    let rest_type = checker.get_type_of_symbol_exported(rest);
    if checker.is_tuple_type_exported(rest_type) {
        let target = checker.ty(rest_type).target();
        let element = checker
            .ty(target)
            .as_tuple_type()
            .element_infos()
            .get(position - count)?
            .labeled_declaration();
        if element.is_nil() {
            return None;
        }
        let name = element.name();
        return Some(ParameterIdentifierInfo {
            parameter: name,
            parameter_name: escape_symbol_name(name.text()),
            is_rest_parameter: element.dot_dot_dot_token().is_some(),
        });
    }
    (position == count).then_some(info)
}

/// Classic `getParameterDeclarationIdentifier`, with the parameter's escaped name.
fn identifier_info(
    checker: &Checker,
    symbol: SymbolId,
    is_rest_parameter: bool,
) -> Option<ParameterIdentifierInfo> {
    let declaration = checker.sym(symbol).value_declaration;
    if declaration.is_nil()
        || !is_parameter_declaration(declaration)
        || !is_identifier(declaration.name())
    {
        return None;
    }
    Some(ParameterIdentifierInfo {
        parameter: declaration.name(),
        parameter_name: escape_symbol_name(&go_symbol_name(&checker.symbols, symbol)),
        is_rest_parameter,
    })
}
