# Classic failure recovery

Status: Approved, paused by the owner on 2026-10-11. Current batch is **WIP (unverified)** and must not be promoted to the feature branch until its remaining gates pass.

## Baseline and current measured result

Lane B started at `64951879e667f6f15a4d6cfbb8fe2da33f7ea711`.
The unchanged TypeScript 6.0.3 fourslash/services roster has 7,853 test occurrences.
The accepted fork baseline passes 7,482 (5,958 fourslash, 1,524 services), with 371 failures.
The existing 75 removed-TypeScript-Go cases remain excluded and unchanged. See `TYPESCRIPT_API_PLAN.md`, “Classified, not changed”, for their case inventory. No new exclusions were added.

The completed lane-B batch-1 roster measures **7,494 passes** (5,970 fourslash, 1,524 services), with **359 failures**. Occurrence-qualified comparison retains all 7,482 earlier passes, recovers twelve, and finds zero lost, absent or added names.
This result is measured, not fully verified batch acceptance.

## Batch 1: destructuring breakpoints

Cause: native Go/Rust ASTs represent array-binding holes as nameless `BindingElement` nodes. Classic TypeScript exposes `OmittedExpression`. The classic AST projection now maps that native shape to its classic kind and child-field layout, preserving its Rust handle, ranges, parent and source-local identity. No Rust parser, binder or checker semantics changed.

Pinned TS 6.0.3 and candidate probes reproduce the kind mismatch and identical ranges on variables, parameters, nested arrays, defaults and rest elements. The unchanged breakpoint family improves from 60/75 to 72/75. All twelve `breakpointValidationDestructuring*ArrayBindingPattern*` failures recover. Ambient class/module and enum breakpoint cases remain failing and unclassified.

Two new focused runtime tests pass. They cover projected kinds and fields, raw Rust handle kinds, visitation, parent identity, breakpoint navigation, edits and retained old source identity.

### Completed gates

- Fresh Rust 1.98.1 size-profile WASM built in lane B's separate Cargo target. Its 7,486,468 bytes match the baseline build size.
- Full 7,853-occurrence roster completed with the counts above.
- Passing-name comparison completed with zero losses and all twelve expected recoveries.
- Focused new runtime tests pass 2/2.

### Pending gates

- Full runtime test suite.
- Browser matrix, because the classic AST runtime adapter changed.
- Independent source review.
- Rebase/integration checks before publishing to `feat/wasm-language-service`.

No `ts_goport` source changed, so the fresh fourteen-binary and emit-corpus gates do not apply to this batch. No independent acceptance verdict is claimed.

## Rename: blocked on lane A resolver unit

Reproduced thirteen failing and sixteen passing fourslash rename cases. An initially broad grep also ran thirteen unrelated tsserver cases; those are outside this roster and grant no evidence for service recovery.
Coordinator assigned full resolver repair to lane A. Lane B must resume rename after that verified unit is pushed.

Eleven post-move failures require ordered `failedLookupLocations`, including skipped missing-directory candidates and failures preceding a successful `.js` resolution:

- `getEditsForFileRename.ts`
- `getEditsForFileRename_caseInsensitive.ts`
- `getEditsForFileRename_casing.ts`
- `getEditsForFileRename_directory.ts`
- `getEditsForFileRename_directory_down.ts`
- `getEditsForFileRename_directory_up.ts`
- `getEditsForFileRename_js_simple.ts`
- `getEditsForFileRename_keepFileExtensions.ts`
- `getEditsForFileRename_notAffectedByJsFile.ts`
- `getEditsForFileRename_renameFromIndex.ts`
- `getEditsForFileRename_renameToIndex.ts`

Two pre-move failures also require Classic/baseUrl resolution:

- `getEditsForFileRename_amd.ts`
- `getEditsForFileRename_preferences.ts`

These remain open implementation failures, not newly excluded TypeScript-Go semantic cases. Metadata alone does not establish recovery of either pre-move case. Native arbitrary resolution and lexical/public routing belong to the same lane-A unit.

## TypeScript-Go semantics classification

Existing removed-semantics inventory remains **75**. Newly classified removed-semantics cases: **0**. Twelve array-binding holes are an AST representation difference repaired in the classic view, not exclusions. The remaining three breakpoint failures have not been classified.

## Next execution order

1. Complete batch-1 runtime/browser/review gates, integrate and push fast-forward.
2. Duplicate code fixes (historical “Found 2 codefixes” group, five cases).
3. JS export-assignment errors (four cases).
4. Region diagnostics (`checkSourceFileNodes` port).
5. JSDoc `@import`.
6. Verbosity, then the largest remaining groups.
7. Recheck the thirteen rename failures and sixteen passing controls after lane A's resolver unit.

## Local continuation evidence

Preserved outside the package:

- `/work/tmp/tsrust-ls-probes/lane-b/b1-roster.jsonl`, `.stderr`, and `b1-compare.json`.
- `breakpoint-base.jsonl`, `breakpoint-candidate.jsonl`, `rename-base.jsonl`.
- `holes-probe.mjs`, `holes-before.jsonl`, `holes-after.jsonl`.
- `build-base-retry.log`; the initial `build-base.log` failed only because Cargo was launched from the parent checkout.
- `tools/` contains parameterized runner copies, targeting only lane B and its isolated upstream test worktree.

Lane B worktree remains `/work/worktrees/ts-rust/classic-failures`. Its Cargo target is `/work/tmp/tsrust-ls-probes/lane-b/wasm-target`.
Pinned upstream suite worktree is `/work/worktrees/typescript/classic-lane-b` at `050880ce59`; its unchanged built bundle and dependency tree are shared read-only through symlinks. Test configuration and local baselines are isolated.
No detached builds or live children remain at the pause checkpoint.
