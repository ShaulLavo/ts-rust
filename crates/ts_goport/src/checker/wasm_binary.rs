use crate::prelude::*;

enum Stage {
    Left,
    Right,
    Finish,
}

struct Frame {
    node: Node,
    stage: Stage,
    left_type: TypeId,
    right_type: TypeId,
    saved_current_node: Node,
    _trace: Option<crate::tracing::Pop>,
}

impl Checker {
    pub(super) fn can_check_binary_iteratively(&self, node: Node) -> bool {
        if node.kind() != SyntaxKind::BinaryExpression {
            return false;
        }
        !(node.operator_token().kind() == SyntaxKind::EqualsToken
            && matches!(
                node.left().kind(),
                SyntaxKind::ObjectLiteralExpression | SyntaxKind::ArrayLiteralExpression
            ))
    }

    // Go: checker/checker.go:12575 checkBinaryLikeExpression
    // PORT: WASM uses explicit frames for the same left-to-right type checks.
    pub(super) fn check_binary_iteratively(&mut self, node: Node, mode: CheckMode) -> TypeId {
        let mut work = vec![self.enter_binary_check(node)];
        loop {
            let child = Self::binary_check_child(work.last().expect("binary check frame exists"));
            if let Some(child) = child {
                self.check_binary_child(&mut work, child, mode);
                continue;
            }
            let frame = work.pop().expect("binary check frame exits");
            let result = self.finish_binary_check(frame, mode);
            let Some(parent) = work.last_mut() else {
                return result;
            };
            Self::accept_binary_result(parent, result);
        }
    }

    // Go: checker/checker.go:7759 checkExpressionEx
    // PORT: Each frame retains the per-expression state until its operands finish.
    fn enter_binary_check(&mut self, node: Node) -> Frame {
        let trace = self.tracer.map(|tracer| {
            tracer.push(
                crate::tracing::Phase::Check,
                "checkExpression",
                crate::tracing::node_args(node),
                false,
            )
        });
        let saved_current_node = self.current_node;
        self.current_node = node;
        self.instantiation_count = 0;
        Frame {
            node,
            stage: Stage::Left,
            left_type: TypeId::NIL,
            right_type: TypeId::NIL,
            saved_current_node,
            _trace: trace,
        }
    }

    fn binary_check_child(frame: &Frame) -> Option<Node> {
        match frame.stage {
            Stage::Left => Some(frame.node.left()),
            Stage::Right => Some(frame.node.right()),
            Stage::Finish => None,
        }
    }

    fn check_binary_child(&mut self, work: &mut Vec<Frame>, node: Node, mode: CheckMode) {
        if self.can_check_binary_iteratively(node) {
            work.push(self.enter_binary_check(node));
            return;
        }
        let result = self.check_expression_ex(node, mode);
        Self::accept_binary_result(work.last_mut().expect("binary check awaits child"), result);
    }

    fn accept_binary_result(frame: &mut Frame, result: TypeId) {
        match frame.stage {
            Stage::Left => {
                frame.left_type = result;
                frame.stage = Stage::Right;
            }
            Stage::Right => {
                frame.right_type = result;
                frame.stage = Stage::Finish;
            }
            Stage::Finish => unreachable!("completed binary check cannot accept a child"),
        }
    }

    fn finish_binary_check(&mut self, frame: Frame, mode: CheckMode) -> TypeId {
        let uninstantiated = self.check_binary_expression_types(
            frame.node.left(),
            frame.node.operator_token(),
            frame.node.right(),
            mode,
            frame.node,
            frame.left_type,
            frame.right_type,
        );
        let result = self.instantiate_type_with_single_generic_call_signature(
            frame.node,
            uninstantiated,
            mode,
        );
        if self.is_const_enum_object_type(result) {
            self.check_const_enum_access(frame.node, result);
        }
        self.current_node = frame.saved_current_node;
        result
    }
}
