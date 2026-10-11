//! Rust-only: classic TypeScript's cancellation polls. Classic's checker and node builder call
//! `cancellationToken.throwIfCancellationRequested()` at fixed points (`typeToTypeNodeWorker`,
//! `createRecoveryBoundary`, `checkExpressionWorker` and `checkSourceElementWorker`); Go cancels
//! a check through its `context.Context` instead (`isCanceled`). A host that answers classic's
//! API arms a poll for one request, and these points call it. Nothing is armed otherwise, and
//! the points then do nothing.

use std::cell::RefCell;

thread_local! {
    static POLL: RefCell<Option<Box<dyn FnMut() -> bool>>> = const { RefCell::new(None) };
}

/// Arms `poll` until `disarm`. It answers whether cancellation was requested.
pub fn arm(poll: Box<dyn FnMut() -> bool>) {
    POLL.with(|cell| *cell.borrow_mut() = Some(poll));
}

pub fn disarm() {
    POLL.with(|cell| *cell.borrow_mut() = None);
}

/// One classic poll point. A poll that reports cancellation disarms itself: classic's
/// exception ends the request at its first cancelled poll, so there are no later polls.
/// The poll runs outside the cell, so a host that polls or arms from it is safe.
pub fn poll() {
    let Some(mut poll) = POLL.with(|cell| cell.borrow_mut().take()) else {
        return;
    };
    if !poll() {
        POLL.with(|cell| {
            let mut cell = cell.borrow_mut();
            if cell.is_none() {
                *cell = Some(poll);
            }
        });
    }
}
