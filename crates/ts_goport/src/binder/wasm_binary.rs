use crate::prelude::*;

enum Stage {
    Left,
    Type,
    LeftEffect,
    Operator,
    Right,
    RightEffect,
    Unreachable { children: Vec<Node>, index: usize },
    Exit,
}

struct Frame {
    node: Node,
    expression: BinaryView,
    stage: Stage,
    saved_parse_error: bool,
    own_parse_error: bool,
    saved_assignment_pattern: bool,
}

enum Step {
    Child(Node),
    Continue,
    Exit,
}

impl Binder {
    pub(super) fn can_bind_binary_iteratively(&self, node: Node) -> bool {
        if node.is_nil() || node.kind() != SyntaxKind::BinaryExpression {
            return false;
        }
        let expression = self.binary_view(node);
        !expression.is_destructuring_assignment()
            && !is_logical_or_coalescing_binary_operator(expression.operator)
            && !is_logical_or_coalescing_assignment_operator(expression.operator)
    }

    // Go: binder/binder.go:576 bind
    // PORT: WASM uses explicit frames to preserve binding order on a small stack.
    pub(super) fn bind_binary_iteratively(&mut self, node: Node) {
        let mut work = vec![self.enter_binary_frame(node)];
        while let Some(frame) = work.last_mut() {
            let step = self.step_binary_frame(frame);
            self.apply_binary_step(&mut work, step);
        }
    }

    fn enter_binary_frame(&mut self, node: Node) -> Frame {
        let expression = self.binary_view(node);
        self.bind_binary_declaration(node, &expression);
        let own_parse_error = self
            .node_flags(node)
            .intersects(NodeFlags::THIS_NODE_HAS_ERROR);
        let saved_parse_error = self.seen_parse_error;
        self.seen_parse_error = false;
        let saved_assignment_pattern = self.in_assignment_pattern;
        self.in_assignment_pattern = false;
        let stage = self.binary_initial_stage(node);
        Frame {
            node,
            expression,
            stage,
            saved_parse_error,
            own_parse_error,
            saved_assignment_pattern,
        }
    }

    // Go: binder/binder.go:1645 bindChildren
    // PORT: Unreachable expressions keep the original child visits and flags.
    fn binary_initial_stage(&mut self, node: Node) -> Stage {
        if self.current_flow != self.unreachable_flow {
            return Stage::Left;
        }
        self.set_flow_node(node, FlowNodeId::NIL);
        if is_potentially_executable_node(node) {
            self.add_node_flags(node, NodeFlags::UNREACHABLE);
        }
        Stage::Unreachable {
            children: node.iter_children().collect(),
            index: 0,
        }
    }

    // Go: binder/binder.go:2240 bindBinaryExpressionFlow
    // PORT: Each frame runs child visits and flow effects in the original order.
    fn step_binary_frame(&mut self, frame: &mut Frame) -> Step {
        match &mut frame.stage {
            Stage::Left => {
                frame.stage = Stage::Type;
                Step::Child(frame.expression.left)
            }
            Stage::Type => {
                frame.stage = Stage::LeftEffect;
                Step::Child(frame.expression.type_)
            }
            Stage::LeftEffect => {
                self.bind_binary_comma_effect(frame.expression.operator, frame.expression.left);
                frame.stage = Stage::Operator;
                Step::Continue
            }
            Stage::Operator => {
                frame.stage = Stage::Right;
                Step::Child(frame.expression.operator_token)
            }
            Stage::Right => {
                frame.stage = Stage::RightEffect;
                Step::Child(frame.expression.right)
            }
            Stage::RightEffect => {
                self.bind_binary_comma_effect(frame.expression.operator, frame.expression.right);
                self.bind_binary_write_effect(frame.node, &frame.expression);
                frame.stage = Stage::Exit;
                Step::Continue
            }
            Stage::Unreachable { children, index } => Self::next_unreachable_child(children, index),
            Stage::Exit => Step::Exit,
        }
    }

    fn next_unreachable_child(children: &[Node], index: &mut usize) -> Step {
        let Some(&child) = children.get(*index) else {
            return Step::Exit;
        };
        *index += 1;
        Step::Child(child)
    }

    fn apply_binary_step(&mut self, work: &mut Vec<Frame>, step: Step) {
        match step {
            Step::Child(node) => self.bind_binary_child(work, node),
            Step::Continue => {}
            Step::Exit => {
                let frame = work.pop().expect("a binary frame exists for its exit");
                self.in_assignment_pattern = frame.saved_assignment_pattern;
                let has_error = frame.own_parse_error || self.seen_parse_error;
                self.seen_parse_error = frame.saved_parse_error;
                self.finish_binary_error(frame.node, has_error);
            }
        }
    }

    fn finish_binary_error(&mut self, node: Node, has_error: bool) {
        if !has_error {
            return;
        }
        self.add_node_flags(node, NodeFlags::THIS_NODE_OR_ANY_SUB_NODES_HAS_ERROR);
        self.seen_parse_error = true;
    }

    fn bind_binary_child(&mut self, work: &mut Vec<Frame>, node: Node) {
        if self.can_bind_binary_iteratively(node) {
            work.push(self.enter_binary_frame(node));
            return;
        }
        self.bind(node);
    }

    fn bind_binary_comma_effect(&mut self, operator: SyntaxKind, node: Node) {
        if operator == SyntaxKind::CommaToken {
            self.maybe_bind_expression_flow_if_call(node);
        }
    }

    fn bind_binary_write_effect(&mut self, node: Node, expression: &BinaryView) {
        if !is_assignment_operator(expression.operator) || is_assignment_target(node) {
            return;
        }
        self.bind_assignment_target_flow(expression.left);
        if expression.operator != SyntaxKind::EqualsToken
            || expression.left.kind() != SyntaxKind::ElementAccessExpression
            || !is_narrowable_operand(expression.left.expression())
        {
            return;
        }
        self.current_flow =
            self.create_flow_mutation(FlowFlags::ARRAY_MUTATION, self.current_flow, node);
    }
}
