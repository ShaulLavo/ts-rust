//! Port of Go `transformers/utilities.go`.

use crate::ast::visitor::NodeVisitor;
use crate::prelude::*;

// Go: transformers/utilities.go:12 IsGeneratedIdentifier
pub fn is_generated_identifier(emit_context: &EmitContext, name: Node) -> bool {
    emit_context.has_auto_generate_info(name)
}

// Go: transformers/utilities.go:16 IsHelperName
pub fn is_helper_name(emit_context: &EmitContext, name: Node) -> bool {
    emit_context
        .emit_flags(name)
        .intersects(EmitFlags::HELPER_NAME)
}

// Go: transformers/utilities.go:20 IsLocalName
pub fn is_local_name(emit_context: &EmitContext, name: Node) -> bool {
    emit_context
        .emit_flags(name)
        .intersects(EmitFlags::LOCAL_NAME)
}

// Go: transformers/utilities.go:24 IsExportName
pub fn is_export_name(emit_context: &EmitContext, name: Node) -> bool {
    emit_context
        .emit_flags(name)
        .intersects(EmitFlags::EXPORT_NAME)
}

// Go: transformers/utilities.go:28 IsIdentifierReference
pub fn is_identifier_reference(name: Node, parent: Node) -> bool {
    match parent.kind() {
        SyntaxKind::BinaryExpression
        | SyntaxKind::PrefixUnaryExpression
        | SyntaxKind::PostfixUnaryExpression
        | SyntaxKind::YieldExpression
        | SyntaxKind::AsExpression
        | SyntaxKind::SatisfiesExpression
        | SyntaxKind::ElementAccessExpression
        | SyntaxKind::NonNullExpression
        | SyntaxKind::SpreadElement
        | SyntaxKind::SpreadAssignment
        | SyntaxKind::ParenthesizedExpression
        | SyntaxKind::ArrayLiteralExpression
        | SyntaxKind::DeleteExpression
        | SyntaxKind::TypeOfExpression
        | SyntaxKind::VoidExpression
        | SyntaxKind::AwaitExpression
        | SyntaxKind::TypeAssertionExpression
        | SyntaxKind::ExpressionWithTypeArguments
        | SyntaxKind::JsxSelfClosingElement
        | SyntaxKind::JsxSpreadAttribute
        | SyntaxKind::JsxExpression
        | SyntaxKind::PartiallyEmittedExpression => {
            // all immediate children that can be `Identifier` would be instances of `IdentifierReference`
            true
        }
        SyntaxKind::ComputedPropertyName
        | SyntaxKind::Decorator
        | SyntaxKind::IfStatement
        | SyntaxKind::DoStatement
        | SyntaxKind::WhileStatement
        | SyntaxKind::WithStatement
        | SyntaxKind::ReturnStatement
        | SyntaxKind::SwitchStatement
        | SyntaxKind::CaseClause
        | SyntaxKind::ThrowStatement
        | SyntaxKind::ExpressionStatement
        | SyntaxKind::ExportAssignment
        | SyntaxKind::PropertyAccessExpression
        | SyntaxKind::TemplateSpan => {
            // only an `Expression()` child that can be `Identifier` would be an instance of `IdentifierReference`
            parent.expression() == name
        }
        SyntaxKind::VariableDeclaration
        | SyntaxKind::Parameter
        | SyntaxKind::BindingElement
        | SyntaxKind::PropertyDeclaration
        | SyntaxKind::PropertySignature
        | SyntaxKind::PropertyAssignment
        | SyntaxKind::EnumMember
        | SyntaxKind::JsxAttribute => {
            // only an `Initializer()` child that can be `Identifier` would be an instance of `IdentifierReference`
            parent.initializer() == name
        }
        SyntaxKind::ShorthandPropertyAssignment => parent.object_assignment_initializer() == name,
        SyntaxKind::ForStatement => {
            parent.initializer() == name
                || parent.condition() == name
                || parent.incrementor() == name
        }
        SyntaxKind::ForInStatement | SyntaxKind::ForOfStatement => {
            parent.initializer() == name || parent.expression() == name
        }
        SyntaxKind::ImportEqualsDeclaration => parent.module_reference() == name,
        SyntaxKind::ArrowFunction => parent.body() == name,
        SyntaxKind::ConditionalExpression => {
            parent.condition() == name || parent.when_true() == name || parent.when_false() == name
        }
        SyntaxKind::CallExpression | SyntaxKind::NewExpression => {
            parent.expression() == name || parent.arguments().iter().any(|a| a == name)
        }
        SyntaxKind::TaggedTemplateExpression => parent.tag() == name,
        SyntaxKind::ImportAttribute => parent.value() == name,
        SyntaxKind::JsxOpeningElement | SyntaxKind::JsxClosingElement => parent.tag_name() == name,
        _ => false,
    }
}

// Go: transformers/utilities.go:112 convertBindingElementToArrayAssignmentElement
fn convert_binding_element_to_array_assignment_element(
    emit_context: &EmitContext,
    element: Node,
) -> Node {
    let f = emit_context.factory();
    if element.name().is_nil() {
        let elision = f.new_omitted_expression();
        emit_context.set_original(elision, element);
        emit_context.assign_comment_and_source_map_ranges(elision, element);
        return elision;
    }
    if element.dot_dot_dot_token().is_some() {
        let spread = f.new_spread_element(element.name());
        emit_context.set_original(spread, element);
        emit_context.assign_comment_and_source_map_ranges(spread, element);
        return spread;
    }
    let expression =
        convert_binding_name_to_assignment_element_target(emit_context, element.name());
    if element.initializer().is_some() {
        let assignment = f.new_assignment_expression(expression, element.initializer());
        emit_context.set_original(assignment, element);
        emit_context.assign_comment_and_source_map_ranges(assignment, element);
        return assignment;
    }
    expression
}

// Go: transformers/utilities.go:135 convertBindingElementToObjectAssignmentElement
fn convert_binding_element_to_object_assignment_element(
    emit_context: &EmitContext,
    element: Node,
) -> Node {
    let f = emit_context.factory();
    if element.dot_dot_dot_token().is_some() {
        let spread = f.new_spread_assignment(element.name());
        emit_context.set_original(spread, element);
        emit_context.assign_comment_and_source_map_ranges(spread, element);
        return spread;
    }
    if element.property_name().is_some() {
        let mut expression =
            convert_binding_name_to_assignment_element_target(emit_context, element.name());
        if element.initializer().is_some() {
            expression = f.new_assignment_expression(expression, element.initializer());
        }
        let assignment = f.new_property_assignment(
            ModifierList::NIL, /*modifiers*/
            element.property_name(),
            Node::NIL, /*postfixToken*/
            Node::NIL, /*typeNode*/
            expression,
        );
        emit_context.set_original(assignment, element);
        emit_context.assign_comment_and_source_map_ranges(assignment, element);
        return assignment;
    }
    let mut equals_token = Node::NIL;
    if element.initializer().is_some() {
        equals_token = f.new_token(SyntaxKind::EqualsToken);
    }
    let assignment = f.new_shorthand_property_assignment(
        ModifierList::NIL, /*modifiers*/
        element.name(),
        Node::NIL, /*postfixToken*/
        Node::NIL, /*typeNode*/
        equals_token,
        element.initializer(),
    );
    emit_context.set_original(assignment, element);
    emit_context.assign_comment_and_source_map_ranges(assignment, element);
    assignment
}

// Go: transformers/utilities.go:169 ConvertBindingPatternToAssignmentPattern
pub fn convert_binding_pattern_to_assignment_pattern(
    emit_context: &EmitContext,
    element: Node,
) -> Node {
    match element.kind() {
        SyntaxKind::ArrayBindingPattern => {
            convert_binding_element_to_array_assignment_pattern(emit_context, element)
        }
        SyntaxKind::ObjectBindingPattern => {
            convert_binding_element_to_object_assignment_pattern(emit_context, element)
        }
        _ => panic!("Unknown binding pattern"),
    }
}

// Go: transformers/utilities.go:180 convertBindingElementToObjectAssignmentPattern
fn convert_binding_element_to_object_assignment_pattern(
    emit_context: &EmitContext,
    element: Node,
) -> Node {
    let properties: Vec<Node> = element
        .elements()
        .iter()
        .map(|e| convert_binding_element_to_object_assignment_element(emit_context, e))
        .collect();
    let f = emit_context.factory();
    let property_list = f.new_node_list_with_loc(&properties, element.element_list().loc());
    let object = f.new_object_literal_expression(property_list, false /*multiLine*/);
    emit_context.set_original(object, element);
    emit_context.assign_comment_and_source_map_ranges(object, element);
    object
}

// Go: transformers/utilities.go:193 convertBindingElementToArrayAssignmentPattern
fn convert_binding_element_to_array_assignment_pattern(
    emit_context: &EmitContext,
    element: Node,
) -> Node {
    let elements: Vec<Node> = element
        .elements()
        .iter()
        .map(|e| convert_binding_element_to_array_assignment_element(emit_context, e))
        .collect();
    let f = emit_context.factory();
    let element_list = f.new_node_list_with_loc(&elements, element.element_list().loc());
    let object = f.new_array_literal_expression(element_list, false /*multiLine*/);
    emit_context.set_original(object, element);
    emit_context.assign_comment_and_source_map_ranges(object, element);
    object
}

// Go: transformers/utilities.go:206 convertBindingNameToAssignmentElementTarget
fn convert_binding_name_to_assignment_element_target(
    emit_context: &EmitContext,
    element: Node,
) -> Node {
    if is_binding_pattern(element) {
        return convert_binding_pattern_to_assignment_pattern(emit_context, element);
    }
    element
}

// Go: transformers/utilities.go:213 ConvertVariableDeclarationToAssignmentExpression
pub fn convert_variable_declaration_to_assignment_expression(
    emit_context: &EmitContext,
    element: Node,
) -> Node {
    if element.initializer().is_nil() {
        return Node::NIL;
    }
    let expression =
        convert_binding_name_to_assignment_element_target(emit_context, element.name());
    let assignment = emit_context
        .factory()
        .new_assignment_expression(expression, element.initializer());
    emit_context.set_original(assignment, element);
    emit_context.assign_comment_and_source_map_ranges(assignment, element);
    assignment
}

// Go: transformers/utilities.go:224 SingleOrMany
// PORT: Go distinguishes a nil slice (result nil) from an empty one (an
// empty SyntaxList). `None` is the nil slice.
pub fn single_or_many(nodes: Option<&[Node]>, factory: &NodeFactory) -> Node {
    let Some(nodes) = nodes else {
        return Node::NIL;
    };
    if nodes.len() == 1 {
        return nodes[0];
    }
    factory.new_syntax_list(nodes)
}

// Go: transformers/utilities.go:241 IsSimpleCopiableExpression
// Used in the module transformer to check if an expression is reasonably without sideeffect,
//
//	and thus better to copy into multiple places rather than to cache in a temporary variable
//	- this is mostly subjective beyond the requirement that the expression not be sideeffecting
//
// Also used by the logical assignment downleveling transform to skip temp variables when they're
// not needed.
pub fn is_simple_copiable_expression(expression: Node) -> bool {
    is_string_literal_like(expression)
        || is_numeric_literal(expression)
        || is_keyword_kind(expression.kind())
        || is_identifier(expression)
}

// Go: transformers/utilities.go:248 IsOriginalNodeSingleLine
pub fn is_original_node_single_line(emit_context: &EmitContext, node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    let original = emit_context.most_original(node);
    if original.is_nil() {
        return false;
    }
    let source = get_source_file_of_node(original);
    if source.is_nil() {
        return false;
    }
    let start_line = get_ecma_line_of_position(source, original.loc().pos());
    let end_line = get_ecma_line_of_position(source, original.loc().end());
    start_line == end_line
}

// Go: transformers/utilities.go:270 IsSimpleInlineableExpression
/// A simple inlinable expression is an expression which can be copied into multiple locations
/// without risk of repeating any sideeffects and whose value could not possibly change between
/// any such locations
pub fn is_simple_inlineable_expression(expression: Node) -> bool {
    !is_identifier(expression) && is_simple_copiable_expression(expression)
}

// Go: transformers/utilities.go:275 FindSuperStatementIndexPath
// FindSuperStatementIndexPath finds a path of indices to a statement containing a `super()` call.
// PORT: Go returns a nil slice when there is no `super()` call; that is an
// empty `Vec` here (Go callers only check `len`).
pub fn find_super_statement_index_path(statements: &[Node], start: usize) -> Vec<usize> {
    let mut indices =
        find_super_statement_index_path_worker(statements, start, Vec::new()).unwrap_or_default();
    indices.reverse();
    indices
}

// Go: transformers/utilities.go:281 findSuperStatementIndexPathWorker
fn find_super_statement_index_path_worker(
    statements: &[Node],
    start: usize,
    mut indices: Vec<usize>,
) -> Option<Vec<usize>> {
    for (i, &statement) in statements.iter().enumerate().skip(start) {
        if get_super_call_from_statement(statement).is_some() {
            indices.push(i);
            return Some(indices);
        } else if is_try_statement(statement) {
            if let Some(mut result) = find_super_statement_index_path_worker(
                &statement.try_block().statements().to_vec(),
                0,
                indices.clone(),
            ) {
                result.push(i);
                return Some(result);
            }
        }
    }
    None
}

// Go: transformers/utilities.go:296 GetSuperCallFromStatement
// GetSuperCallFromStatement extracts the super() call expression from an expression statement, if any.
pub fn get_super_call_from_statement(statement: Node) -> Node {
    if !is_expression_statement(statement) {
        return Node::NIL;
    }
    let expression = skip_parentheses(statement.expression());
    if is_super_call(expression) {
        return expression;
    }
    Node::NIL
}

// Go: transformers/utilities.go:308 MoveRangePastModifiers
// MoveRangePastModifiers returns a text range that starts past any modifiers on the node.
pub fn move_range_past_modifiers(node: Node) -> TextRange {
    if is_property_declaration(node) || is_method_declaration(node) {
        return TextRange::new(node.name().pos(), node.end());
    }

    let mut last_modifier = Node::NIL;
    if can_have_modifiers(node) {
        last_modifier = node.modifier_nodes().last().unwrap_or(Node::NIL);
    }

    if last_modifier.is_some() && !position_is_synthesized(last_modifier.end()) {
        return TextRange::new(last_modifier.end(), node.end());
    }
    move_range_past_decorators(node)
}

// Go: transformers/utilities.go:325 MoveRangePastDecorators
// MoveRangePastDecorators returns a text range that starts past any decorators on the node.
pub fn move_range_past_decorators(node: Node) -> TextRange {
    let mut last_decorator = Node::NIL;
    if can_have_modifiers(node) {
        last_decorator = node
            .modifier_nodes()
            .iter()
            .filter(|&n| is_decorator(n))
            .last()
            .unwrap_or(Node::NIL);
    }

    if last_decorator.is_some() && !position_is_synthesized(last_decorator.end()) {
        return TextRange::new(last_decorator.end(), node.end());
    }
    node.loc()
}

// Go: transformers/utilities.go:341 GetNonAssignmentOperatorForCompoundAssignment
// GetNonAssignmentOperatorForCompoundAssignment returns the non-assignment operator for a compound assignment.
pub fn get_non_assignment_operator_for_compound_assignment(kind: SyntaxKind) -> SyntaxKind {
    match kind {
        SyntaxKind::PlusEqualsToken => SyntaxKind::PlusToken,
        SyntaxKind::MinusEqualsToken => SyntaxKind::MinusToken,
        SyntaxKind::AsteriskEqualsToken => SyntaxKind::AsteriskToken,
        SyntaxKind::AsteriskAsteriskEqualsToken => SyntaxKind::AsteriskAsteriskToken,
        SyntaxKind::SlashEqualsToken => SyntaxKind::SlashToken,
        SyntaxKind::PercentEqualsToken => SyntaxKind::PercentToken,
        SyntaxKind::LessThanLessThanEqualsToken => SyntaxKind::LessThanLessThanToken,
        SyntaxKind::GreaterThanGreaterThanEqualsToken => SyntaxKind::GreaterThanGreaterThanToken,
        SyntaxKind::GreaterThanGreaterThanGreaterThanEqualsToken => {
            SyntaxKind::GreaterThanGreaterThanGreaterThanToken
        }
        SyntaxKind::AmpersandEqualsToken => SyntaxKind::AmpersandToken,
        SyntaxKind::BarEqualsToken => SyntaxKind::BarToken,
        SyntaxKind::CaretEqualsToken => SyntaxKind::CaretToken,
        SyntaxKind::BarBarEqualsToken => SyntaxKind::BarBarToken,
        SyntaxKind::AmpersandAmpersandEqualsToken => SyntaxKind::AmpersandAmpersandToken,
        SyntaxKind::QuestionQuestionEqualsToken => SyntaxKind::QuestionQuestionToken,
        _ => kind,
    }
}

#[derive(Clone, Copy)]
enum BinaryPhase {
    Left,
    Type,
    Operator,
    Right,
}

struct BinaryFrame {
    node: Node,
    modifiers: ModifierList,
    left: Node,
    type_node: Node,
    operator: Node,
    phase: BinaryPhase,
}

/// Go `ast_generated.go` binary-child order, with owned continuations for binary chains.
/// Opt-in traversal for callbacks whose binary-expression branch only visits children.
/// Node and modifier overrides must be unset; all other children use the running callback.
pub(crate) fn visit_binary_expression_chain<C>(
    node: Node,
    visitor: &mut NodeVisitor<'_, C>,
) -> Node {
    debug_assert_eq!(node.kind(), SyntaxKind::BinaryExpression);
    debug_assert!(visitor.visit.is_some());
    debug_assert!(visitor.hooks.visit_node.is_none());
    debug_assert!(visitor.hooks.visit_modifiers.is_none());
    let mut frames = Vec::new();
    let mut next = node;
    loop {
        if next.is_some() && next.kind() == SyntaxKind::BinaryExpression {
            let modifiers = visitor.visit_modifiers(next.modifiers());
            frames.push(BinaryFrame {
                node: next,
                modifiers,
                left: Node::NIL,
                type_node: Node::NIL,
                operator: Node::NIL,
                phase: BinaryPhase::Left,
            });
            next = next.left();
            continue;
        }
        let mut result = visitor.visit_node(next);
        loop {
            let Some(frame) = frames.last_mut() else {
                return result;
            };
            match frame.phase {
                BinaryPhase::Left => {
                    frame.left = result;
                    frame.phase = BinaryPhase::Type;
                    next = frame.node.type_();
                    break;
                }
                BinaryPhase::Type => {
                    frame.type_node = result;
                    frame.phase = BinaryPhase::Operator;
                    next = frame.node.operator_token();
                    break;
                }
                BinaryPhase::Operator => {
                    frame.operator = result;
                    frame.phase = BinaryPhase::Right;
                    next = frame.node.right();
                    break;
                }
                BinaryPhase::Right => {
                    let frame = frames.pop().unwrap();
                    result = visitor.factory().update_binary_expression(
                        frame.node,
                        frame.modifiers,
                        frame.left,
                        frame.type_node,
                        frame.operator,
                        result,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod binary_transform_tests {
    use super::*;
    use crate::checker::emit_resolver_p1::get_emit_resolver_of_shared_checker;
    use crate::transformers::transformer::{EmitResolverReferenceResolver, TransformOptions};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

    struct FixtureDirectory(PathBuf);

    impl Drop for FixtureDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct FixtureProgram(&'static GoProgram);

    impl Drop for FixtureProgram {
        fn drop(&mut self) {
            crate::program::release_program(self.0);
        }
    }

    pub(crate) fn with_program(
        source: &str,
        file_name: &str,
        edit_options: impl FnOnce(&mut CompilerOptions),
        run: impl FnOnce(&TransformOptions, Node),
    ) {
        let path = std::env::temp_dir().join(format!(
            "goport-binary-transform-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        let directory = FixtureDirectory(path);
        std::fs::write(directory.0.join(file_name), source).unwrap();
        let config = directory.0.join("tsconfig.json");
        std::fs::write(&config, format!(r#"{{"files":["{file_name}"]}}"#)).unwrap();
        let program = FixtureProgram(
            crate::program::try_load_version(config.to_str().unwrap(), |options| {
                options.no_lib = Tristate::True;
                options.target = ScriptTarget::ES2020;
                options.module = ModuleKind::ES2015;
                options.allow_js = Tristate::True;
                edit_options(options);
            })
            .unwrap(),
        );
        let _scope = crate::core::enter_program(Some(program.0));
        let checker = Rc::new(RefCell::new(
            crate::program::ls_program::new_checker_for_version(program.0),
        ));
        let emit_resolver: Rc<dyn crate::printer::EmitResolver> =
            get_emit_resolver_of_shared_checker(&checker);
        let compiler_options = program.0.options;
        let opts = TransformOptions {
            context: new_emit_context(),
            compiler_options,
            resolver: Rc::new(EmitResolverReferenceResolver(emit_resolver.clone())),
            emit_resolver,
            get_emit_module_format_of_file: Rc::new(move |_| {
                compiler_options.get_emit_module_kind()
            }),
        };
        let file = program
            .0
            .source_files()
            .find(|file| file.info.file_name.ends_with(file_name))
            .unwrap()
            .root;
        run(&opts, file);
    }

    pub(crate) fn preorder(root: Node) -> Vec<Node> {
        let mut pending = vec![root];
        let mut nodes = Vec::new();
        while let Some(node) = pending.pop() {
            nodes.push(node);
            let start = pending.len();
            node.for_each_child(|child| {
                pending.push(child);
                false
            });
            pending[start..].reverse();
        }
        nodes
    }

    pub(crate) fn binary(factory: &NodeFactory, left: Node, right: Node) -> Node {
        factory.new_binary_expression(
            ModifierList::NIL,
            left,
            Node::NIL,
            factory.new_token(SyntaxKind::PlusToken),
            right,
        )
    }

    pub(crate) fn deep_chain(factory: &NodeFactory, depth: usize, right: bool) -> Node {
        let mut node = factory.new_numeric_literal("0", TokenFlags::NONE);
        for _ in 0..depth {
            let leaf = factory.new_numeric_literal("1", TokenFlags::NONE);
            node = if right {
                binary(factory, leaf, node)
            } else {
                binary(factory, node, leaf)
            };
        }
        node
    }

    fn balanced(factory: &NodeFactory, depth: usize) -> Node {
        let mut nodes: Vec<_> = (0..(1 << depth))
            .map(|_| factory.new_numeric_literal("1", TokenFlags::NONE))
            .collect();
        while nodes.len() > 1 {
            nodes = nodes
                .chunks_exact(2)
                .map(|pair| binary(factory, pair[0], pair[1]))
                .collect();
        }
        nodes[0]
    }

    struct VisitState {
        iterative: bool,
        seen: Vec<Node>,
        replacements: FxHashMap<Node, Node>,
    }

    fn visit(node: Node, visitor: &mut NodeVisitor<'_, VisitState>) -> Node {
        if node.kind() == SyntaxKind::BinaryExpression {
            if visitor.ctx.iterative {
                return visit_binary_expression_chain(node, visitor);
            }
            return visitor.visit_each_child(node);
        }
        visitor.ctx.seen.push(node);
        if let Some(&replacement) = visitor.ctx.replacements.get(&node) {
            return replacement;
        }
        visitor.visit_each_child(node)
    }

    fn run(
        context: &EmitContext,
        root: Node,
        iterative: bool,
        replacements: FxHashMap<Node, Node>,
    ) -> (Node, Vec<Node>) {
        let mut visitor = context.new_node_visitor(
            visit,
            VisitState {
                iterative,
                seen: Vec::new(),
                replacements,
            },
        );
        let result = visitor.visit_node(root);
        (result, visitor.ctx.seen)
    }

    #[test]
    fn binary_transform_deep_left_right_balanced_identity_cold_and_warm() {
        let context = new_emit_context();
        let factory = &context.factory().ast;
        let roots = [
            deep_chain(factory, 10_000, false),
            deep_chain(factory, 10_000, true),
            balanced(factory, 13),
        ];
        for root in roots {
            assert!(static_ast_node(root).is_none());
            let (cold, cold_seen) = run(&context, root, true, FxHashMap::default());
            let (warm, warm_seen) = run(&context, root, true, FxHashMap::default());
            assert_eq!(cold, root);
            assert_eq!(warm, root);
            assert_eq!(warm_seen, cold_seen);
            assert_eq!(context.original(root), Node::NIL);
        }
    }

    #[test]
    fn binary_transform_preserves_go_roles_modifiers_and_factory_metadata() {
        let context = new_emit_context();
        let factory = &context.factory().ast;
        let modifier = factory.new_modifier(SyntaxKind::ExportKeyword);
        let modifiers = factory.new_modifier_list_with_loc(&[modifier], TextRange::new(1, 3));
        let left = factory.new_numeric_literal("1", TokenFlags::NONE);
        let type_node = factory.new_identifier("T");
        let operator = factory.new_token(SyntaxKind::PlusToken);
        let right = factory.new_numeric_literal("2", TokenFlags::NONE);
        let root = factory.new_binary_expression(modifiers, left, type_node, operator, right);
        set_node_flags(root, root.flags() | NodeFlags::AMBIENT);
        set_node_loc(root, TextRange::new(4, 12));
        context.add_emit_flags(root, EmitFlags::NO_COMMENTS);
        context.set_comment_range(root, TextRange::new(0, 15));
        context.set_source_map_range(root, TextRange::new(3, 13));
        let (original, original_seen) = run(&context, root, false, FxHashMap::default());
        let (unchanged, seen) = run(&context, root, true, FxHashMap::default());
        assert_eq!(original, root);
        assert_eq!(unchanged, root);
        assert_eq!(seen, original_seen);
        assert_eq!(seen, vec![modifier, left, type_node, operator, right]);

        let changed_modifier = factory.new_modifier(SyntaxKind::DeclareKeyword);
        let changed_left = factory.new_numeric_literal("3", TokenFlags::NONE);
        let changed_type = factory.new_identifier("U");
        let changed_operator = factory.new_token(SyntaxKind::MinusToken);
        let replacements = FxHashMap::from_iter([
            (modifier, changed_modifier),
            (left, changed_left),
            (type_node, changed_type),
            (operator, changed_operator),
        ]);
        let (recursive, recursive_seen) = run(&context, root, false, replacements.clone());
        let (changed, changed_seen) = run(&context, root, true, replacements);
        assert_eq!(changed_seen, recursive_seen);
        assert_ne!(changed, root);
        assert_eq!(changed.left(), recursive.left());
        assert_eq!(changed.type_(), recursive.type_());
        assert_eq!(changed.operator_token(), recursive.operator_token());
        assert_eq!(changed.right(), right);
        assert_eq!(changed.modifier_nodes().to_vec(), vec![changed_modifier]);
        assert_eq!(
            changed.modifiers().node_list().loc(),
            modifiers.node_list().loc()
        );
        assert_eq!(changed.flags(), root.flags());
        assert_eq!(changed.loc(), root.loc());
        assert_eq!(context.original(changed), root);
        assert_eq!(context.emit_flags(changed), context.emit_flags(root));
        assert_eq!(context.comment_range(changed), context.comment_range(root));
        assert_eq!(
            context.source_map_range(changed),
            context.source_map_range(root)
        );
    }

    #[test]
    fn binary_transform_keeps_nil_empty_modifiers_and_single_node_lifting() {
        let context = new_emit_context();
        let factory = &context.factory().ast;
        let left = factory.new_numeric_literal("1", TokenFlags::NONE);
        let right = factory.new_numeric_literal("2", TokenFlags::NONE);
        for modifiers in [ModifierList::NIL, factory.new_modifier_list(&[])] {
            let root = factory.new_binary_expression(
                modifiers,
                left,
                Node::NIL,
                factory.new_token(SyntaxKind::PlusToken),
                right,
            );
            let stored_modifiers = root.modifiers();
            assert_eq!(stored_modifiers.is_nil(), modifiers.is_nil());
            assert!(stored_modifiers.nodes().is_empty());
            if modifiers.is_some() {
                assert_ne!(stored_modifiers, modifiers);
                assert_eq!(stored_modifiers.loc(), modifiers.loc());
            }
            let (unchanged, _) = run(&context, root, true, FxHashMap::default());
            assert_eq!(unchanged, root);
            assert_eq!(unchanged.modifiers(), stored_modifiers);
            assert_eq!(unchanged.modifiers().is_nil(), modifiers.is_nil());
            let replacement = binary(factory, right, left);
            let lifted = factory.new_syntax_list(&[replacement]);
            let replacements = FxHashMap::from_iter([(left, lifted)]);
            let (recursive, recursive_seen) = run(&context, root, false, replacements.clone());
            let (result, seen) = run(&context, root, true, replacements);
            assert_eq!(result.left(), replacement);
            assert_eq!(result.left(), recursive.left());
            assert_eq!(seen, recursive_seen);
            assert_eq!(seen, vec![left, root.operator_token(), right]);
        }
    }

    #[test]
    fn binary_transform_static_parsed_chain_keeps_handles() {
        use crate::frontend::parser::{SourceFileParseOptions, parse_source_file};
        let context = new_emit_context();
        let options = SourceFileParseOptions {
            file_name: "/binary-transform-static.ts".to_string(),
            ..Default::default()
        };
        let file = parse_source_file(&options, "const value = 1 + 2 * 3;", ScriptKind::TS).root;
        let root = preorder(file)
            .into_iter()
            .find(|node| node.kind() == SyntaxKind::BinaryExpression)
            .unwrap();
        assert!(static_ast_node(root).is_some());
        let (recursive, recursive_seen) = run(&context, root, false, FxHashMap::default());
        assert_eq!(recursive, root);
        for _ in 0..2 {
            let (result, seen) = run(&context, root, true, FxHashMap::default());
            assert_eq!(result, root);
            assert_eq!(seen, recursive_seen);
        }
    }

    #[test]
    fn binary_transform_preserves_nil_callback_result() {
        let context = new_emit_context();
        let factory = &context.factory().ast;
        let type_node = factory.new_identifier("T");
        let root = factory.new_binary_expression(
            ModifierList::NIL,
            factory.new_numeric_literal("1", TokenFlags::NONE),
            type_node,
            factory.new_token(SyntaxKind::PlusToken),
            factory.new_numeric_literal("2", TokenFlags::NONE),
        );
        let replacements = FxHashMap::from_iter([(type_node, Node::NIL)]);
        let (recursive, recursive_seen) = run(&context, root, false, replacements.clone());
        let (result, seen) = run(&context, root, true, replacements);
        assert!(result.type_().is_nil());
        assert!(recursive.type_().is_nil());
        assert_eq!(seen, recursive_seen);
        assert_eq!(context.original(result), root);
    }

    #[test]
    fn binary_transform_scoped_parsed_chain_keeps_handles() {
        use crate::frontend::parser::{SourceFileParseOptions, parse_source_file};
        let options = SourceFileParseOptions {
            file_name: "/binary-transform-owned.ts".to_string(),
            ..Default::default()
        };
        let file = {
            let _scope = crate::ast::enter_owned_parse();
            parse_source_file(&options, "export const value = 1 + 2 * 3;", ScriptKind::TS)
        };
        let context = new_emit_context();
        let root = preorder(file.root)
            .into_iter()
            .find(|node| node.kind() == SyntaxKind::BinaryExpression)
            .unwrap();
        assert_ne!(root.file_index(), SYNTHETIC_NODE_FILE);
        assert!(static_ast_node(root).is_none());
        assert!(crate::ast::try_store_ast_node(root).is_none());
        assert!(file.root.statement_list().store_list().is_some());
        let (cold, cold_seen) = run(&context, root, true, FxHashMap::default());
        let (warm, warm_seen) = run(&context, root, true, FxHashMap::default());
        let (recursive, recursive_seen) = run(&context, root, false, FxHashMap::default());
        assert_eq!(cold, root);
        assert_eq!(warm, root);
        assert_eq!(recursive, root);
        assert_eq!(cold_seen, recursive_seen);
        assert_eq!(warm_seen, cold_seen);
    }
}
