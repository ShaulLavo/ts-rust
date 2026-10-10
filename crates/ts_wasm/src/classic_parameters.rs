use ts_goport::ast::{escape_symbol_name, is_identifier, is_parameter};
use ts_goport::astdata::SyntaxKind;
use ts_goport::binder::go_symbol_name;
use ts_goport::checker::Checker;
use ts_goport::core::{Node, SignatureId, SymbolId};

pub struct ParameterIdentifierInfo {
    pub parameter: Node,
    pub parameter_name: String,
    pub is_rest_parameter: bool,
}

/// TypeScript 6.0.3 checker.ts getParameterIdentifierInfoAtPosition.
pub fn parameter_identifier_info(checker: &mut Checker, signature: SignatureId, position: usize) -> Option<ParameterIdentifierInfo> {
    let data = checker.sig(signature);
    if data.declaration().kind() == SyntaxKind::JsDocFunctionType {
        return None;
    }
    let count = data.parameters().len().saturating_sub(usize::from(checker.signature_has_rest_parameter(signature)));
    if position < count {
        return identifier_info(checker, data.parameters()[position], false);
    }
    let rest = data.parameters().get(count).copied().unwrap_or(checker.get_unknown_symbol());
    let mut info = identifier_info(checker, rest, true)?;
    let rest_type = checker.get_type_of_symbol_exported(rest);
    if !checker.is_tuple_type_exported(rest_type) {
        return (position == count).then_some(info);
    }
    let target = checker.ty(rest_type).target();
    let tuple = checker.ty(target).as_tuple_type();
    let declaration = tuple.element_infos().get(position - count)?.labeled_declaration();
    if declaration.is_nil() {
        return None;
    }
    info.parameter = declaration.name();
    info.parameter_name = escape_symbol_name(info.parameter.text());
    info.is_rest_parameter = declaration.dot_dot_dot_token().is_some();
    Some(info)
}

fn identifier_info(checker: &Checker, symbol: SymbolId, is_rest_parameter: bool) -> Option<ParameterIdentifierInfo> {
    let declaration = checker.sym(symbol).value_declaration;
    if declaration.is_nil() || !is_parameter(declaration) || !is_identifier(declaration.name()) {
        return None;
    }
    Some(ParameterIdentifierInfo { parameter: declaration.name(), parameter_name: escape_symbol_name(&go_symbol_name(&checker.symbols, symbol)), is_rest_parameter })
}
