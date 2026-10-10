use std::cell::RefCell;
use std::rc::Rc;

use ts_goport::ast::get_source_file_of_node;
use ts_goport::astdata::SyntaxKind;
use ts_goport::checker::{Checker, create_printer_with_remove_comments_omit_trailing_semicolon_never_ascii_escape, to_node_builder_flags};
use ts_goport::core::{Node, SignatureId};
use ts_goport::flags::{NodeBuilderFlags, SignatureKind, TypeFormatFlags};
use ts_goport::printer::{EmitTextWriter, get_single_line_string_writer, new_text_writer};

/// Classic signatureToString selects the declaration kind from its explicit argument.
pub fn signature_to_string(checker: &mut Checker, signature: SignatureId, enclosing: Node, flags: TypeFormatFlags, kind: SignatureKind) -> String {
    let output = if flags.intersects(TypeFormatFlags::WRITE_ARROW_STYLE_SIGNATURE) {
        if kind == SignatureKind::CONSTRUCT { SyntaxKind::ConstructorType } else { SyntaxKind::FunctionType }
    } else if kind == SignatureKind::CONSTRUCT {
        SyntaxKind::ConstructSignature
    } else {
        SyntaxKind::CallSignature
    };
    let node = checker.signature_to_signature_declaration_exported(signature, output, enclosing,
        to_node_builder_flags(flags) | NodeBuilderFlags::IGNORE_ERRORS | NodeBuilderFlags::WRITE_TYPE_PARAMETERS_IN_QUALIFIED_NAME);
    let context = checker.get_node_builder().borrow().emit_context();
    let mut printer = create_printer_with_remove_comments_omit_trailing_semicolon_never_ascii_escape(context);
    let source = if enclosing.is_nil() { Node::NIL } else { get_source_file_of_node(enclosing) };
    if flags.intersects(TypeFormatFlags::MULTILINE_OBJECT_LITERALS) {
        let writer = Rc::new(RefCell::new(new_text_writer("\n", 0)));
        let inner: Rc<RefCell<dyn EmitTextWriter>> = writer.clone();
        printer.write_exported(node, source, inner, None);
        return writer.borrow().string();
    }
    let writer = Rc::new(RefCell::new(get_single_line_string_writer()));
    let inner: Rc<RefCell<dyn EmitTextWriter>> = writer.clone();
    printer.write_exported(node, source, inner, None);
    writer.borrow().string()
}
