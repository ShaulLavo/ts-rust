//! Classic `getSymbolWalker` (compiler/symbolWalker.ts) over the port's checker. Go has no
//! symbol walker; this is classic's traversal, with each step answered by the port's function
//! of the same name. The caller's `accept` runs in JavaScript: the walk takes the symbols it
//! rejected and reports the symbols in visit order, so the facade can walk again until every
//! visited symbol has its verdict.

use std::collections::HashSet;

use ts_goport::ast::get_first_identifier;
use ts_goport::astdata::SyntaxKind;
use ts_goport::checker::Checker;
use ts_goport::core::{SymbolId, TypeId};
use ts_goport::flags::{ObjectFlags, SignatureKind, TypeFlags};

pub struct SymbolWalk {
    rejected: HashSet<SymbolId>,
    visited_types: HashSet<TypeId>,
    visited_symbols: HashSet<SymbolId>,
    /// Visited symbols in visit order (classic calls `accept` in this order).
    pub symbol_order: Vec<SymbolId>,
}

impl SymbolWalk {
    pub fn new(rejected: impl IntoIterator<Item = SymbolId>) -> Self {
        Self {
            rejected: rejected.into_iter().collect(),
            visited_types: HashSet::new(),
            visited_symbols: HashSet::new(),
            symbol_order: Vec::new(),
        }
    }

    /// Classic's results: `getOwnValues` of arrays indexed by id, so ascending ids.
    pub fn types(&self) -> Vec<TypeId> {
        let mut types: Vec<TypeId> = self.visited_types.iter().copied().collect();
        types.sort_by_key(|t| t.0);
        types
    }

    pub fn symbols(&self) -> Vec<SymbolId> {
        let mut symbols = self.symbol_order.clone();
        symbols.sort_by_key(|symbol| symbol.0);
        symbols
    }

    pub fn visit_type(&mut self, c: &mut Checker, t: TypeId) {
        if t.is_nil() || !self.visited_types.insert(t) {
            return;
        }
        let symbol = c.ty(t).symbol();
        if self.visit_symbol(c, symbol) {
            return;
        }
        let flags = c.ty(t).flags();
        if flags.intersects(TypeFlags::OBJECT) {
            let object_flags = c.ty(t).object_flags();
            if object_flags.intersects(ObjectFlags::REFERENCE) {
                let target = c.ty(t).target();
                self.visit_type(c, target);
                for argument in c.get_type_arguments(t).to_vec() {
                    self.visit_type(c, argument);
                }
            }
            if object_flags.intersects(ObjectFlags::MAPPED) {
                let mapped = c.ty(t).as_mapped_type();
                let parts = [
                    mapped.type_parameter,
                    mapped.constraint_type,
                    mapped.template_type,
                    mapped.modifiers_type,
                ];
                for part in parts {
                    self.visit_type(c, part);
                }
            }
            if object_flags.intersects(ObjectFlags::CLASS_OR_INTERFACE) {
                self.visit_object_type(c, t);
                let iface = c.ty(t).as_interface_type();
                let type_parameters = iface.type_parameters().to_vec();
                let this_type = iface.this_type;
                for parameter in type_parameters {
                    self.visit_type(c, parameter);
                }
                for base in c.get_base_types(t) {
                    self.visit_type(c, base);
                }
                self.visit_type(c, this_type);
            }
            if object_flags.intersects(ObjectFlags::TUPLE | ObjectFlags::ANONYMOUS) {
                self.visit_object_type(c, t);
            }
        }
        if flags.intersects(TypeFlags::TYPE_PARAMETER) {
            let constraint = c.get_constraint_of_type_parameter(t);
            self.visit_type(c, constraint);
        }
        if flags.intersects(TypeFlags::UNION_OR_INTERSECTION) {
            for member in c.ty(t).types().to_vec() {
                self.visit_type(c, member);
            }
        }
        if flags.intersects(TypeFlags::INDEX) {
            let target = c.ty(t).as_index_type().target();
            self.visit_type(c, target);
        }
        if flags.intersects(TypeFlags::INDEXED_ACCESS) {
            let access = c.ty(t).as_indexed_access_type();
            let (object_type, index_type) = (access.object_type(), access.index_type());
            self.visit_type(c, object_type);
            self.visit_type(c, index_type);
        }
    }

    fn visit_signature(&mut self, c: &mut Checker, signature: ts_goport::core::SignatureId) {
        let predicate = c.get_type_predicate_of_signature(signature);
        if predicate.is_some() && predicate != c.no_type_predicate {
            let predicate_type = c.pred(predicate).t;
            self.visit_type(c, predicate_type);
        }
        for parameter in c.sig(signature).type_parameters().to_vec() {
            self.visit_type(c, parameter);
        }
        for parameter in c.sig(signature).parameters().to_vec() {
            self.visit_symbol(c, parameter);
        }
        let rest = c.get_rest_type_of_signature(signature);
        self.visit_type(c, rest);
        let return_type = c.get_return_type_of_signature(signature);
        self.visit_type(c, return_type);
    }

    fn visit_object_type(&mut self, c: &mut Checker, t: TypeId) {
        c.resolve_structured_type_members(t);
        for info in c.get_index_infos_of_structured_type(t).to_vec() {
            let (key_type, value_type) =
                (c.index_info(info).key_type, c.index_info(info).value_type);
            self.visit_type(c, key_type);
            self.visit_type(c, value_type);
        }
        for kind in [SignatureKind::CALL, SignatureKind::CONSTRUCT] {
            for signature in c.get_signatures_of_structured_type(t, kind).to_vec() {
                self.visit_signature(c, signature);
            }
        }
        for property in c.get_properties_of_object_type(t).to_vec() {
            self.visit_symbol(c, property);
        }
    }

    /// True when `accept` rejected the symbol, so its type's walk stops.
    pub fn visit_symbol(&mut self, c: &mut Checker, symbol: SymbolId) -> bool {
        if symbol.is_nil() || !self.visited_symbols.insert(symbol) {
            return false;
        }
        self.symbol_order.push(symbol);
        if self.rejected.contains(&symbol) {
            return true;
        }
        let t = c.get_type_of_symbol(symbol);
        self.visit_type(c, t);
        let exports = c.sym(symbol).exports;
        if exports.is_some() {
            for export in c.symbols.values(exports) {
                self.visit_symbol(c, export);
            }
        }
        for declaration in c.sym(symbol).declarations.clone().iter().copied() {
            let type_node = declaration.type_();
            if type_node.is_some() && type_node.kind() == SyntaxKind::TypeQuery {
                let entity = c.get_resolved_symbol(get_first_identifier(type_node.expr_name()));
                self.visit_symbol(c, entity);
            }
        }
        false
    }
}
