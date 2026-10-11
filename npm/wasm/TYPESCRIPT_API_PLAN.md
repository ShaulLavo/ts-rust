# Classic TypeScript language-service compatibility

Status: Approved. Private runtime implementation started. The current WebAssembly editor API does not satisfy this contract.

## Required calling code

Consumers can replace the package import while keeping their language-service code:

```ts
const service = ts.createLanguageService(host, documentRegistry);
const info = service.getQuickInfoAtPosition(fileName, utf16Offset);
const diagnostics = service.getSemanticDiagnostics(fileName);
const program = service.getProgram();
const file = program?.getSourceFile(fileName);
const checker = program?.getTypeChecker();
service.dispose();
```

Creation and methods keep their TypeScript signatures and synchronous return values. The supplied
`LanguageServiceHost` controls files, snapshots, versions, options, resolution and cancellation.
Existing setup helpers, including `ScriptSnapshot.fromString`, `createDocumentRegistry`, enums
and display-part helpers, remain available where callers need them.

TypeScript 6.0.3's published declarations are the initial classic API contract. This is a calling
contract, separate from the compiler semantics of the TypeScript-Go revision this port targets.
Independent package-wide `createProgram` support is outside this request. Objects reachable from
`LanguageService.getProgram`, diagnostics and completion symbols are inside it.

## Current gaps

The current factory accepts file/configuration options and returns a promise. Its service has
`request`, `updateFiles`, `deleteFiles` and asynchronous `dispose`. The reference interface has
65 unique members, including overloads and optional members. Its host and return types differ.

The Rust port's native API also has a different contract. It creates snapshots, projects and
compiler objects. Its completion response has numeric LSP kinds and omits several classic
completion fields. Existing hover responses contain rendered Markdown. A JavaScript adapter
cannot recover original display parts, modifiers and documentation tags from those responses.

`getProgram`, `getCompletionEntrySymbol` and `Diagnostic.file` expose object graphs with methods,
cycles and identity. Source files, nodes, symbols, types and signatures need faithful JavaScript
objects backed by retained Rust data. Plain JSON results do not fulfill that requirement.

Custom resolution and emit-transformer callbacks operate on those objects. Filesystem callbacks
alone do not cover the host contract. Refactors, paste edits and the remaining classic methods
need an explicit producer and behavior check; matching an LSP feature name is insufficient.

## Implementation shape

Use a synchronous facade on the caller's thread. Rust imports invoke the supplied host directly.
Build classic result records before the LSP conversions discard information. Reuse the native
snapshot leases, object registries and AST encoder where they preserve the required semantics.
Keep transport handles private and preserve the identities and lifetime of returned objects.

The native API transport is useful infrastructure, but its existing schemas do not implement
the classic interface. The installed native TypeScript decoder also uses a different AST protocol
version from the port. Generate or use a decoder from the same pinned source as the encoder.

A browser's synchronous methods cannot depend on blocking worker RPC. Asset readiness must be
handled by package loading without adding an initialization call to consumer code. Synchronous
execution also needs new stack evidence; the existing async worker-stack checks do not prove it.

Do not return promises, fabricate missing fields, install unsupported-method stubs, parse hover
Markdown into guessed TypeScript structures, or run the JavaScript TypeScript service as a hidden
fallback. None meets this contract.

## Execution and checks

- [x] Read authoritative factory, host and language-service declarations.
- [x] Prove the current declarations fail factory and service assignability.
- [x] Compare direct Rust bindings and native-session transport designs.
- [x] Implement a private synchronous channel and snapshot/version host bridge.
- [ ] Prove synchronous loading, host callbacks, reentrancy and adequate stack in Node and browsers.
- [ ] Bind versions, snapshots, options, cancellation, registry sharing and custom host callbacks.
- [ ] Preserve program/source-file/node/symbol/type/signature identity and lifetime across edits.
- [ ] Implement every declared method and overload with complete classic result records.
- [ ] Compare unchanged callers against the reference for results, edits, callbacks and disposal.
- [ ] Pass compile-time compatibility and runtime comparisons before describing the API as drop-in.

The first runtime gate creates a service from an ordinary host, returns a diagnostic with a real
source-file object, observes a version change, and checks the retained old source file. Include
the existing deep-expression fixture on this synchronous path. The first result-record gate
checks quick info and completions with documentation, tags, modifiers and symbol identities.

## First runtime unit

`service-channel.js` calls the existing WASM ABI synchronously after a compiled module is available.
`classic-host.js` captures the supplied host's snapshots and tracks script and project versions.
It refreshes roots and configuration through an internal compiler-argument translator. The full
classic compiler-option translation and public method facade remain to be implemented. The shared
WASI bridge lives in `runtime.js`; the existing asynchronous compiler and editor entries use it too.

Synchronization uses the decisions of TypeScript 6.0.3's `synchronizeHostDataWorker` and
`isProgramUptoDate`. A truthy, unchanged `getProjectVersion()` returns before any other host
callback unless `hasChangedAutomaticTypeDirectiveNames()` is true. Otherwise the bridge rebuilds
when options, roots or `getTypeRootsVersion()` change, a loaded file's script version or kind
changes, `hasInvalidatedResolutions(path)` is true, `hasChangedAutomaticTypeDirectiveNames()` is
true, or a file the last build could not load now exists. A rebuild reads every loaded file's snapshot again; an
undefined snapshot makes the file missing, and an unchanged version keeps its earlier text and
parse. Non-root files exist when `fileExists` says so, and a host without `directoryExists` has
every directory. A host exception inside a build reaches the caller, and the next call rebuilds.

Known deviations: callback order and counts follow the Rust module resolver, not the reference.
A root exists for module resolution even when `fileExists` denies it, so an import of such a
root resolves. A rebuild resolves every import again, while the reference reuses resolutions of
unchanged files. A `/// <reference path>` target that is created later with an unchanged
referencing file stays missing: the Rust loader rejects it before loading, so it never enters
the program's missing files, which the reference checks again. After a host exception the next call retries even when the project version is
unchanged, where the reference keeps its earlier program.

The private unit checks synchronous returns, dependency edits, unchanged snapshot reuse, option
and root changes, the project-version fast path, isolation, disposal and callback failures. These checks operate on private LSP results and retained host snapshots.
They do not establish TypeScript result objects, `Diagnostic.file`, or `getProgram` compatibility.

With Rust 1.93's size profile and no Binaryen optimization, the module is 7,376,814 bytes. The basic
private sequence passes on Chromium and WebKit main threads and workers. Chromium rejects the
18 MB release-profile module when synchronously creating an instance on its main thread, so
browser synchronous-instantiation checks must use the distributable size profile.

The synchronous stack gate failed here first on Node 22 (a 5,000-term addition raised
`RangeError`); the binder, checker and encoder repairs fix every step but emit, which still
overflows (see "Deep-expression stack check (r35)"). A worker promise would change the contract.

To run the declaration check, install the reference into a temporary directory and pass its
package directory to `npm run check:typescript-api --prefix npm/wasm -- <reference-directory>`.
Use `typescript@6.0.3` for the initial contract. The command derives the member list from that
package and checks both the factory and returned service against its declarations. It currently
exits with status 1 because compatibility is incomplete. It is separate from the scoped WASM
tests and is not a claim of runtime equivalence.

Pass the reference package's `lib/typescript.js` as a second argument for a positive control.
The reference passes its own declarations. This checks that a failed replacement result comes
from the replacement contract rather than a broken declaration-check harness.

## Factory architecture

The public factory runs the pinned classic `createLanguageService` dispatch from
`src/services/services.ts`, bundled with explicit source provenance. Its compiler entry points
are replaced: `createProgram` builds a Rust program, `createLanguageServiceSourceFile` and
`updateLanguageServiceSourceFile` decode Rust parses, and `getTypeChecker` returns the
Rust-backed checker. Five original compiler entry points throw when reached; the boundary audit
below records alternate parser, resolver, printer and transform paths still requiring closure.
Each classic service algorithm then works exactly as far as the Rust-backed program,
source-file, symbol, type and signature objects satisfy its dependencies. A dependency that
cannot be bridged moves its algorithm into Rust.

Every classic service and registry of a compiled module lives in one shared WASM instance
(`classic-instance.js`). A shared registry therefore shares Rust parses, so `SourceFile` and node
identity hold across services.

## Public facade and browser unit (u7, locally verified)

The root package now selects `classic-node.js` or `classic-browser.js`. Import evaluation makes
the WASM module ready; `createLanguageService`, `createDocumentRegistry` and ordinary service
methods stay synchronous. The environment-neutral `classic-namespace.js` owns the Rust injection.
The explicit `ts-rust-wasm/lsp` entry retains the asynchronous editor/CLI interface. Generated
entries expose the pinned runtime's 2,248 named exports and default namespace; declarations retain
the pinned 6.0.3 namespace with ESM aliases. Both factory declaration checks pass with
`skipLibCheck: false`. Matching types is not a claim of complete implementation behavior.

The preserved pre-repair size build is 7,463,611 bytes, SHA-256
`fb2b5f8a1fdbec63d178ce826095666819fd6033b17d4a8e4a56bf4033480f3b`. Chromium's module worker
passed through deep quick info, then overflowed during cold 5,000-term emit. Chromium main and
both WebKit cells passed. A named diagnostic build identified repeated
`printer_p3::Printer::emit_expression` frames; its size exceeds Chromium's 8 MiB synchronous
main-thread limit, so it is diagnostic evidence only. All failed runs remain under `u7/`.

The final Rust 1.98.1 size-profile build (`CI=1`, plain Cargo, `WASM_OPT=none`) is 7,464,717 bytes,
SHA-256 `e6ce8855c39fc65f583942528019039f61d929114f0300ad9e51def3c2118c10`.
Chromium 156.0.8078.4 and WebKit 27.2 now pass on both main threads and module workers, with no
page errors. Each cell verifies synchronous construction, bound host callbacks, registry/program/
symbol/diagnostic identity, edits, syntactic mode, host-exception recovery, disposal, and exact
cold/warm 5,000-term emit (20,018 bytes). Node 22.23.3 passes the same public sequence.
The runner records frozen executed assets and sequence hashes in `u7/printer-final/browser-size.json`.

A fresh npm tarball installs into a new project and passes the complete Node sequence. A real
esbuild browser bundle selects `classic-browser.js` with zero external imports and no polyfills;
all four packed-browser cells also pass. Bundle SHA-256
`53e27f4aa44850568cc9172bbb456bcda45f0ef72a933c71c17d93a14b6c515c`;
tarball SHA-256 `cef8cc9d6e46cb3b29a530ca730ebec7f5789d205887ac96aa6e6361a7a862cd`.
The initial bundle failure from original Node `require` sites is preserved. The generator removes
those nine Node-tooling calls using pinned AST ranges, preserves global performance, and guards
file tracing. Generated artifact SHA-256
`daff7ddee9b3c88f4364577555df87847351699edc1f1204366f3d6cc6934b7a`.
Unchanged roster `r42` repeats against this artifact: 7,482/7,853 passes, including 5,958 fourslash
and 1,524 services, with zero lost/absent/gained occurrences. Original-JavaScript compiler reachability
remains a separate failing boundary gate.

The sole compiler writer owns `printer/printer_p3.rs` for the demonstrated binary-printer path.
The repair must preserve traversal, precedence, hooks, comments, source maps and output text with
owned continuations, without balancing the expression. Fresh independent review and regression
audit, all fourteen local native binaries against `9f6ee6d1` and the u6 accepted local repair,
original 19,915-row emit corpus, full classic pass-list retention and all four browser cells are
required before pushing the compiler unit. Formal R188 remains unrun and unchanged.

The source-reviewed continuation candidate is frozen locally at `4f1f0e2b`, printer SHA-256
`0f5f00cf07951fefeeba089b8a3827177f563181c71d734efb08e38be82f5d08`.
Independent static review passes, and all five focused release tests pass. Two preserved focused
compile attempts failed on test-only parser text ownership and a nonexistent node-slice method;
a third run passed three tests and exposed missing parsed-fixture publication in two tests.
The final candidate fixes those fixture APIs and uses the production note/publish sequence,
without changing the reviewed printer logic or weakening assertions. Premature broad builds
against `b8a09f04` were stopped and preserved under `u7/printer-verified/`; they give no acceptance
credit. Final release and browser gates use `u7/printer-final/`: 56/56 runtime tests, 18/18
default-stack deep checks, all 19,915 original corpus rows identical, full `r42` passing-name
retention, and both source/packed browser matrices pass. Independent regression audit verifies
source/tool/reference hashes and these results. All fourteen native binaries complete their
nineteen result suites: 181,927 passes, retaining all 181,891 immutable-base and 181,922 u6 passes
with zero lost/absent/unrun names. Both independent agents issue source-bound LOCAL printer-unit
PASS verdicts; these are no formal R188 or overall language-service acceptance. The actual packed
root declaration check passes with 65 required service members and `skipLibCheck: false`.
An initial additional check incorrectly value-imported `index.d.ts` and failed TS2846; its evidence
is preserved. The corrected scratch harness changes only its virtual package root to the installed
package and exercises the real root export without changing assertions. The frozen facade separately passes all 56 runtime tests on the
preserved pre-repair size WASM, including the optional real-reference boundary tests.

The original-JavaScript boundary audit remains **STOP** with seven reachable routes: JSON,
isolated entity-name, isolated JSDoc comment and type parsing, module resolution, printing and
transformation. The plan grants no blanket printer or JSDoc exception. Existing Rust-built nodes
printed by classic writers describe the implementation gap, not accepted compiler delegation.
Close lexical call paths through Rust as well as public namespace paths. JSON needs a dedicated
syntax-only detached-source action; isolated parser actions need detached-node encoding.
Resolution also needs ordered failed/affecting lookup locations. Checker display writers
must retain structured parts and symbol callbacks; arbitrary edit/snippet trees additionally need
Rust tree encoding. Standalone transformations require the previously documented context ABI.
Scanner-based editing and synthetic factories remain distinct from these compiler operations.

An isolated JSON lexical-delegation prototype is preserved under
`u7/json-boundary-prototype/`. Node 22.23.3 repeats the preserved Node 26 diagnostic exactly.
All 138 no-cursor comparisons match core AST kinds, spans, text, flags and UTF-16 maps, but none
matches the complete source snapshot: parent visibility, counts and literal/list metadata differ.
Parse diagnostics match 96/138; Rust validates some JSON earlier than the classic syntax-only
entry. Two configuration-conversion fixtures change diagnostic priority or span; their host traces
still match. Invalid-input recovery also makes the private syntax cursor observable. This is
measured evidence against shipping a one-line redirect, not a closure result. Static caller tracing
establishes that the private cursor-bearing call is unreachable after the main parser guard;
the public two-argument wrapper never forwards a cursor. The next JSON unit needs a dedicated
syntax-only `parseJsonText` operation with a detached source lease. Preserve validation for
`createSourceFile(..., ScriptKind.JSON)` and existing native consumers. Export actual parser
counts, expose recorded `multiLine`, and preserve classic recovery-array metadata and parentless
visibility without changing shared registry/program wrappers or filtering diagnostic codes.
No production JSON changes have been made.

Read-only profiling on current-head release code attributes cold completions to AST wrapper
materialization and per-version node-index sorting. In 502 completion samples, 249 pass through
`findPrecedingToken`, 252 through `classicChildren`, 223 through `wrap`, and 84 through first
`NodeIndexTable::get_index`; these are overlapping inclusive counts. JSON decoding accounts for
eight samples. Thirty bridge calls transfer about 4.2 KiB of JSON per completion. Warm same-version
completions are much cheaper. Edits encode each retained source tree twice (`parseDocument`, then
program `getSourceFile`), and the second payload is discarded after identity lookup. The five
extra filesystem probes occur once per build, not during completions. The preserved 11.295 ms
versus 0.465 ms completion and 11.385 ms versus 5.614 ms edit medians are a preliminary paired
baseline. Concurrent-work diagnostic profiles are not final timing evidence; those exploratory
runs establish no performance speedup.

The bounded wrapper-allocation repair is now implemented and frozen for verification in
`classic-ast.js`: immutable field-layout descriptions use complete node shape, and method/deletion
collections allocate on demand. Eager child arrays and per-source wrapper identity are unchanged.
The six new focused contracts pass on both unchanged baseline and candidate; the complete runtime
suite passes 62/62. Source and freshly packed packages pass Chromium/WebKit main-thread/worker
verification. Independent source and benchmark-tool reviews pass within their stated scope.
The full unchanged roster retains all 7,482 passing occurrences: 5,958 fourslash and 1,524 services,
with zero recovered, lost, absent or unrun cases. The same 371 failures remain across 7,853 tests;
the 75 removed-TypeScript-Go exclusions are unchanged. Six sequential fresh-process timing
triplets are complete. Formal R188 remains unrun and all seven original-JS boundary routes remain
STOP. The final independent regression audit passes for this local wrapper unit; it grants no
formal compiler acceptance or boundary waiver. The verified runtime unit was published
fast-forward to the fork as `7995aa63`; the remote SHA was checked after pushing.

Frozen candidate evidence is at `/work/tmp/tsrust-ls-probes/u8-performance/wrapper-unit`.
Its `classic-ast.js` hash is `80d10c2251f1283b4d9b3e80da968f7846fbdc11a5b3edf57fa920ca906ae5a2`;
freshly rebuilt WASM matches the baseline byte-for-byte. The portable editing comparison runner
preserves the original workload and aggregates process results separately without pooling edits.

### Wrapper-allocation measurements (2026-10-11)

Node 22.23.3, six fresh processes per arm, 2,000 declarations and 30 edits per process. Odd
triplets run base/candidate/reference; even triplets reverse that order. Baseline is frozen
`0e4713d3`; both Rust-backed arms use byte-identical freshly rebuilt size-profile WASM. The
reference is pinned TypeScript 6.0.3. No runtime checks or profiles overlap these timing runs.
Each cell below is the across-process median / nearest-rank p95 of each process's phase median,
in milliseconds. The frozen workload uses the upper middle of 30 observations within a process;
the comparison runner averages the middle pair across the six processes. Edit observations are
never pooled as independent process samples.

| Phase | Frozen baseline | Wrapper candidate | TypeScript 6.0.3 |
| --- | ---: | ---: | ---: |
| Open | 64.116 / 77.987 | 61.442 / 68.623 | 55.534 / 57.564 |
| Edit / program update | 21.138 / 22.476 | 21.633 / 22.220 | 6.168 / 6.310 |
| Completions | 14.246 / 14.941 | 9.921 / 10.188 | 0.570 / 0.591 |
| Quick info | 1.313 / 1.375 | 1.333 / 1.389 | 0.628 / 0.634 |
| Diagnostics | 6.298 / 6.337 | 6.279 / 6.544 | 3.829 / 3.964 |
| 20,000 line/position round trips | 13.233 / 21.097 | 14.312 / 14.783 | 4.474 / 5.053 |

Completion median improves 30.4%; edit/program-update median does not improve (2.3% higher).
The remaining completion gap versus TypeScript is approximately 17.4×. Module loading is separate:
72.210 / 195.237 ms baseline, 74.614 / 636.958 ms candidate, 142.145 / 152.751 ms reference.
Median across each process's completion p95 improves 24.224 → 19.800 ms (18.3%), while the
corresponding diagnostic p95 rises 8.084 → 9.664 ms. Repeated line-map median rises 8.2%.
These six-process results support a bounded completion improvement, not broad performance parity.

Every baseline and candidate process makes `readFile=0`, `getScriptSnapshot=31`,
`getScriptVersion=184`, and `fileExists=155` calls. Every reference process has the same counts
except `fileExists=0`. Separate instrumented count-only runs match exactly: 15 bridge calls and
1,002,303 response bytes on open; 10 calls and about 1,002,134 bytes per edit; 30 calls and about
4,197 bytes per completion; 12 calls and about 1,093 bytes per quick info; 8 calls and 184 bytes
per diagnostic phase. Line-map probes make zero bridge calls. The wrapper change reduces local
allocation work; it removes neither the duplicated AST encoding nor filesystem probes.

Timing evidence: `wrapper-unit/replicates/summary.json` and all 18 raw child results. Count evidence:
`wrapper-unit/count-only/comparison.json`; its timings are excluded. Exploratory baseline timing
that overlapped a profile remains preserved and excluded from these claims. The new packed root
passes strict declaration checks (`skipLibCheck=false`, 65 members, zero diagnostics). Fresh
boundary provenance/dependency checks find no unresolved imports, missing packed dependencies or
browser Node imports, but the runtime tripwires still detect the seven original routes plus
binder-factory setup at initialization; transitive closure is unproved. This is a boundary STOP,
not a dependency or runtime-compiler acceptance.

After this unit's verified publication, a separate source-descriptor unit can remove redundant
program AST encoding, with full payload fetch on a genuine cache miss; retain library metadata
and cross-program diagnostic identity. Typed file/directory callback intent is another separate
unit: current generic stat probes call `fileExists` for directories. Package-scope metadata policy
must be investigated separately; removing those probes without proving equivalent behavior is
outside the wrapper-allocation repair.

### Typed existence bridge (u9, 2026-10-11)

Private host operations 11 and 12 now carry file and directory existence intent; cancellation
remains operation 10. Native dispatch, the synchronous runtime, shared-instance adapter and
public classic `createProgram` adapter forward the separate callbacks with their receiver.
Stat-only filesystem adapters retain their existing behavior. Classic hosts without
`directoryExists` report directories present. Retained host generations store separate file
and directory facts, including false results, without polling live callbacks.

The initial private-adapter candidate passed its roster but still made 155 `fileExists` calls:
the public program adapter was missing typed forwarding. That attempt and its evidence remain
preserved under `u9-existence/typed-unit`; final proof uses `typed-unit-final` only. The final
candidate makes 93 calls in every timing process, exactly 62 fewer than the frozen u8 baseline.
`readFile=0`, `getScriptSnapshot=31` and `getScriptVersion=184` remain unchanged.

Fresh Rust 1.98.1 size-profile WASM is 7,464,915 bytes, SHA-256
`68213f32dcfa02bc995387fc6ed9e7bda6591b17bdd9b9bfaeec52525f0c35c3`.
Final runtime tests pass 69/69 without skips; source and packed Chromium/WebKit main-thread/
worker matrices each pass 4/4; packed Node and strict declarations pass (65 service members,
zero diagnostics). The full unchanged roster runs all 7,853 identities, retaining 7,482 passes
with zero lost, absent or recovered occurrences and the same 371 failures. The 75 exclusions
are unchanged. All 19,915 original emit-corpus rows remain identical with no missing or changed
sources. Rust 1.93.0 native `ts_wasm` tests pass 2/2, including typed file/directory assertions.
No `ts_goport` source changed; the fourteen-binary native protected set was not freshly rerun,
and its historical 181,927 passes are not fresh acceptance evidence. Formal R188 is **unrun**.
Independent source review passes. The regression auditor confirms the exact evidence but
raises a completeness STOP on the old emit comparator: two equally truncated streams can pass.
A separate strict inventory guard now validates both full source inventories and hashes, requires
the candidate completion record, and rejects manifest-only, one-row and missing-last-row streams.
`emit-completeness.json` records 19,922 enumerated inputs, 19,915 readable identical rows and the
seven unchanged non-UTF-8 exclusions. Earlier evidence and comparator results remain preserved;
the independent auditor re-executes the strict guard, reproduces all truncation rejections and
clears its completeness STOP. LOCAL u9 source review and regression gates pass. The strict
inventory guard remains required evidence for later corpus comparisons; it grants no boundary
waiver or formal compiler acceptance.

Six sequential fresh-process triplets use Node 22.23.3, the unchanged 2,000-declaration,
30-edit fixture and alternating arm order. No ts-rust build, roster, corpus or profile overlaps
these runs. Host quietness was not established; latency is observational shared-host evidence.
Cells show across-process median / nearest-rank p95 of phase medians in milliseconds;
module load remains separate and edit observations are not pooled.

| Phase | Frozen u8 baseline | Typed candidate | TypeScript 6.0.3 |
| --- | ---: | ---: | ---: |
| Open | 66.701 / 73.801 | 64.510 / 76.442 | 61.545 / 101.503 |
| Edit / program update | 23.145 / 27.190 | 23.892 / 28.563 | 6.599 / 6.704 |
| Completions | 11.412 / 14.264 | 11.184 / 12.137 | 0.630 / 0.680 |
| Quick info | 1.608 / 1.979 | 1.597 / 1.913 | 0.650 / 0.674 |
| Diagnostics | 6.663 / 9.080 | 6.643 / 8.443 | 3.973 / 4.422 |
| 20,000 line/position round trips | 14.738 / 20.621 | 14.090 / 22.969 | 4.537 / 6.003 |

Module-load median / p95: 80.345 / 857.155 ms baseline, 83.633 / 542.034 ms candidate,
149.390 / 174.178 ms reference. This unit proves fewer callbacks, not an edit speedup:
edit median is 3.2% higher. Count-only timings are excluded. Final evidence is
`/work/tmp/tsrust-ls-probes/u9-existence/typed-unit-final`, including frozen source hashes,
complete roster comparison, raw process results and `replicates/summary.json`.

The 4,140-assertion pinned TS 6.0.3 package-scope probe confirms ordinary `.d.ts/.ts/.tsx/.js/.jsx`
lookup only for Node16 through NodeNext resolution or paths inside `node_modules`; fixed-format
extensions determine their format before lookup. Bundler is outside that interval. Shared pinned
Go intentionally collects scope metadata more broadly for dependency-symlink discovery and
inclusion explanations. Preserve that native policy: do not blanket-guard `file_loader.rs` or
use `SkipModuleResolution`. A future explicitly selected classic metadata policy must update
both serial and parallel loading, before cache access, preserve fixed formats, and leave skipped
ordinary-file implied format absent. Probe evidence is `u9-existence/probe`. No shared compiler
policy change is included in u9.

All seven original-JavaScript boundary routes still **STOP**. Dependency graphs have no unresolved
imports, missing packed files or browser Node imports, but binder-factory initialization is
observed and transitive closure remains unproved. Continue in order: non-encoding source
descriptors in the three assigned files; end-to-end edit profiling and largest-cost repair;
completion profiling and largest-cost repair; Rust-owned JSON/isolated parsing, resolution
metadata, writers/synthesized trees and transform ABI; then the 371 failures, rename first.
Read-only failure triage identifies 13 file-rename failures (11 after moving), missing ordered
resolver lookup metadata plus Classic/Node10 resolution gaps; twelve array-hole breakpoint
failures; and four direct missing-checker-member failures. These are investigation targets,
not claimed recoveries or new exclusions.

### Non-encoding source descriptors (u10, 2026-10-11)

The verified u9 unit was published fast-forward to the fork as
`1b65f8c1cabea895ad3250aba207bfb616e2efc7`; the remote tip was checked.
The descriptor unit was published fast-forward as
`fdf9d34879d9b120412c0c6a70e57f247902861f`; the remote tip was checked.
This runtime unit changes only `classic_sources.rs`, `classic_graph.rs` and
`classic-source-files.js` in production. Program source requests retain the same lease and
return its ID, filename and per-program library flags without encoding the tree. Materialization
first checks the instance/source lease cache; a live file returns immediately. A genuine miss
uses a supplied full response or fetches the existing Rust `source` operation once. Parsing still
returns full data. No version negotiation or old-request compatibility path is introduced.

Scratch contracts pass for supplied full responses, zero-fetch descriptor hits, one-fetch misses,
parse target/version, diagnostic-file identity, pragmas, shared sources with per-program library
flags, and bundled-library first use with no host version. The unchanged baseline demonstrably
fails the descriptor-miss contract. Independent source review matches the frozen three-file patch
and passes all eight registry/program focused tests; retention and finalizer guards are unchanged.

Fresh Rust 1.98.1 size-profile WASM is 7,465,287 bytes, SHA-256
`f218d5ac6c0971758ec9198d568f7bbc53f2543c05520127650c422094329a7a`.
Runtime passes 69/69 with no skips; source and packed browser matrices each pass 4/4, packed Node
passes and strict declarations have 65 members with zero diagnostics. The complete 7,853-case
roster retains all 7,482 passing occurrences, with zero recovered, lost, absent or unrun cases;
371 failures and 75 exclusions remain unchanged. All 19,915 original emit rows remain identical,
with the strict guard independently validating the full 19,922-input inventory and unchanged
seven non-UTF-8 exclusions. Scoped native `ts_wasm` tests pass 2/2 on Rust 1.93.0. The first
formatter attempt failed because that toolchain lacks rustfmt; the installed 1.97.1 formatter
then passes both files. No shared `ts_goport` source changed. Formal R188 remains **unrun** and
the historical fourteen-binary 181,927 result is not fresh evidence for u10.

Count-only probes use the identical 59,844-byte fixture. Open response bytes fall
1,002,303 → 501,420; thirty edits fall 30,064,018 → 15,037,187. Open remains 15 bridge calls,
each edit remains ten calls, and both arms perform zero extra full-source fetches in these phases.
Completion response bytes remain 125,902 across thirty calls to the service (900 bridge calls).
Both arms retain `fileExists=93`, `readFile=0`, 31 snapshots and 184 version calls. Instrumented
probe timings are excluded.

Six fresh processes per arm, alternating triplet order and the unchanged original workload,
measure the following median / p95 of process phase medians in milliseconds. No ts-rust build,
full roster, corpus or diagnostic profile overlaps these timing processes. A subsequent process
inspection found unrelated owner build/test jobs with elapsed times overlapping the run; none
was stopped or altered. These are shared-host latency observations, not isolated speedup proof.
Edit observations are not pooled; module loading is reported separately.

| Phase | Frozen u9 baseline | Descriptor candidate | TypeScript 6.0.3 |
| --- | ---: | ---: | ---: |
| Open | 72.789 / 100.725 | 87.362 / 112.692 | 75.641 / 108.363 |
| Edit / program update | 27.023 / 42.221 | 21.208 / 38.891 | 7.491 / 12.812 |
| Completions | 12.653 / 18.820 | 11.791 / 20.135 | 0.679 / 1.360 |
| Quick info | 1.751 / 2.597 | 1.530 / 2.456 | 0.677 / 1.223 |
| Diagnostics | 7.328 / 14.610 | 6.982 / 15.368 | 4.497 / 10.421 |
| 20,000 line/position round trips | 14.488 / 21.734 | 16.815 / 22.132 | 4.971 / 7.133 |

Module-load median / p95 is 165.882 / 772.001 ms baseline, 152.077 / 477.143 ms candidate,
172.375 / 295.082 ms reference. Observed edit median is 21.5% lower, but cold open median is
20.0% higher and repeated line-map median is 16.1% higher. Shared-host contention and variable
results preclude a causal latency improvement or broad parity claim. The deterministic payload
reduction is approximately 50%.
Evidence: `/work/tmp/tsrust-ls-probes/u10-descriptors/final`, with count-only results in the
sibling `count-only` directory. Independent regression audit returned LOCAL PASS for the exact
frozen source/WASM: all 7,853 occurrence-qualified identities were compared, all 7,482 passes
retained, strict corpus completeness independently checked, and all eighteen timing outputs
validated. This approves local publication only; original-JavaScript boundaries and formal
compiler acceptance remain open. Shared-host timings establish no isolated speedup.
All seven original-JavaScript boundary routes still **STOP**, with binder-factory initialization
observed and transitive closure unproved. Dependency checks still report no unresolved imports,
missing packed files or browser Node imports.

#### Approved continuation after u10

Context-limited checkpoint: u9 and u10 are source-reviewed, regression-audited and pushed.
Units for the remaining edit repair, completion repair, boundary closure and 371 failure
recoveries are still open. No background build or reviewer remains pending at this checkpoint.

The edit-cost observation now has a known-good control in the same diagnostic directory:
`publication-control.mjs`, `.json`, `.cpuprofile` and `publication-control-phases.json`.
It encodes the identical source lease thirty times before and thirty times after `getProgram`;
source identity, fixture hash and the 500,760-byte payload length agree. Before publication,
1,098 phase samples include 1,048 `encode_tree`, 392 `get_node_data` and 352 `collect_children`;
after publication, 230 include 194, 5 and 25 respectively, with 15 `push_store_children`.
These are diagnostic stack observations, not accepted timing measurements or a speedup claim.

Independent bounded design review identifies why the existing fast path misses standalone
classic parses: `parse_document` acquires an unpublished store and immediately encodes it,
while `FileNodes::of` supplies only published stores. Do not substitute `acquire_bound`: it
also binds and changes binder timing. Do not call `publish_parsed_files` before encoding:
it drains every pending store on the thread, including collateral stores, and classic parsing
can be nested inside a program host callback. A standalone parse also has no host publication
cwd/case-sensitivity contract. Keep the current publication and retention boundaries.

The next implementation should add an encoder reader for completed frozen unpublished stores,
resolving the store cell once and using short scoped reads for headers, ordinary node data and
child/list metadata. No borrowed node data or store-list reference may escape into the task
stack. Finish each store borrow before `node.js_doc`: lazy JSDoc writes the same store.
Reuse the existing data-word and child-field logic, retaining visitor handling for JSDoc,
`SyntaxList` and nodes outside that store. Do not eagerly parse JSDoc, bind during parsing,
clone the whole tree or redesign AST ownership. Compare exact payload bytes and node indices
against the existing visitor for static/freeable, unpublished/published, lazy-JSDoc and nested
host-callback cases. This necessarily changes shared `ts_goport` support and therefore needs
fresh native fourteen-binary zero-loss evidence before publication, in addition to all classic
and WASM gates below. No such production change is implemented at this checkpoint.

1. Finish the end-to-end edit-cost unit. The named diagnostic profile in
   `u10-descriptors/profile-debug` uses a different name-retaining WASM and overlaps correctness
   gates: its timings are excluded. Of 3,198 edit samples, 1,589 include Rust `encode_tree`,
   994 include parse-cache acquisition and 991 include parsing. These counts overlap; encoding
   is the largest demonstrated remaining edit subtree. Investigate its allocations and child/data
   traversal before changing the shared encoder. Any `ts_goport` change needs fresh independent
   review, the fourteen-binary native comparison with zero losses, and original corpus checks.
2. Profile and repair completion cost. The same diagnostic run has 1,670 completion samples;
   505 include `NodeIndexTable::get_index`, 481 its first-use sort, and 362 `get_node_id`.
   Exclusive leaves include 303 JS `wrap` samples and 300 Rust `get_node_id` samples. Inspect
   wrapper materialization and the per-version node-handle index separately; measure candidates
   with six fresh processes and the full retained roster. The source/data representation,
   rather than callback count, is the demonstrated remaining cost.
3. Close all seven Rust-ownership boundaries: dedicated syntax-only JSON and detached entity/
   JSDoc parsing; resolver lookup metadata and arbitrary resolution requests; structured printer
   writers and synthesized-tree encoding; transform context ABI. Keep dependency checks green.
4. Recover the 371 failures, rename first. Of 13 file-rename failures, eleven occur after moving
   and two before moving. Stored resolver results lack ordered failed/affecting locations;
   Classic/Node10 resolution is also missing for the two pre-move cases. Preserve all sixteen
   passing file-rename controls. Twelve destructuring breakpoints expose array-binding holes as
   `BindingElement` where classic expects `OmittedExpression`. Four direct failures require
   `getAnyAsyncIterableType`, `getNullableType` and `writeTypePredicate`. No recovery is yet claimed.

#### u11 scoped unpublished reader — local correctness gates pass; timing pending

Status: **Approved; source-bound local correctness verification complete, performance pending.** Evidence is retained under
`/work/tmp/tsrust-ls-probes/u11-unpublished`. The production reader resolves a frozen unpublished
store once and confines each header/data read to a short borrow. Queued unpublished lists own
handles and range values; lazy JSDoc runs after those borrows end. Published files retain their
pinned reader/list fast path. No parse is bound or published early.

The final focused source manifest is `focused-retry4/source-before.sha256`: encoder SHA-256
`29646d633c3fda743168c549bcf5fac037ecafb2f9c4b4e30fe5240a224f3ed5`, store SHA-256
`54c48b233450b8cea773d8fb78363f5154b5e0f235a317e2fe29e107603a48e2`. The focused encoder run
passed **7/7**. Independent cold controls cover static/freeable × unpublished/published sources,
64 genuinely lazy documented functions, deep chains, aliases and nil/empty list fields.
Cross-publication comparisons preserve full payload bytes, table shapes and ordinary node identity;
same-state comparisons preserve exact handles. A nested host-callback registry control is included.
The separate reader guard passed 1/1; the optional encoding test compared all 64 inventoried,
unchanged compiler fixtures through published static/freeable and unpublished freeable controls.

Keep all attempts: the first compile failed on a test-only `NodeSlice` iterator call; retry2
revealed invalid assertions about eagerly parsed `@see`/`@link` and synthetic JSDoc identity
across publication; retry3 caught a test-only nonexistent `NodeSlice::is_nil` accessor. Retry4
corrects the controls without changing production code or existing expectations. The independent
reviewer confirmed the corrected cache/identity contracts. Final evidence-bound scoped-reader review
passed for the frozen commit/tree, including all 80 package-input hashes and actual gate artifacts.
The independent regression auditor also returned **LOCAL u11 REGRESSION AUDIT PASS** for that
exact source/tree, independently rebuilding per-name outcome maps and validating original emit
completeness. Neither verdict supplies formal R188 acceptance or a performance claim.

Both unchanged snapshot generators passed 1/1; live parse/bind checks passed 2/2. Parse blob
sections changed only their eight-byte source keys; bind regeneration was byte-identical.
`focused-retry4/blob-delta.json` records the hashes and section comparisons.
Frozen compiler candidate: `dcb48df984830c69496e58fefbb4677ace546d01`, crates tree
`9c7121743d77f4d7fe5faaa5a3fb622d71794be1`. Fresh fourteen-binary / nineteen-suite local
comparison passed: **181,931 passing, 3,623 ignored**, retaining all 181,891 local-base,
181,922 u6 and 181,927 u7 passes, with **0 lost, 0 absent, 0 unrun** and four new passing
u7-relative names. Results SHA-256 `1ec8cd6aba327917be2f55c2d69bb53ac7abd2c62b1318006a9c303ae52e6a61`;
binary-manifest digest `10fcde1a9fef7dd8c47fa0fb985a2bf4919162c8aa75630ce5a3f7f650abb420`.

Fresh Rust 1.98.1 WASM: **7,486,468 bytes**, SHA-256
`1ce891ea72ddc2d2496a6f579dd5e9c973b5ea6399f36923ec52b581678dbf60`.
`final/source-manifest.json` binds the source/package inputs. Runtime passed **70/70**, with
no skips. Source and packed Chromium/WebKit main-thread/worker matrices passed **8/8 cells**.
Packed Node smoke and strict declarations passed, covering the same 65 required service members.
The full occurrence-qualified classic roster remained **7,482/7,853**, **371 failures**:
**7,482 retained, 0 recovered, 0 lost, 0 absent**, with no added/missing names.
Original emit equality and strict completeness both passed: **19,922 inventoried inputs,
19,915 identical readable rows, the same seven non-UTF8 exclusions, 19,745 outputs**,
with no changed/missing rows or changed inputs. See `final/classic-compare.json`,
`final/emit-compare.json` and `final/emit-completeness.json`; all gate jobs ended `DONE`.
No recovery or speedup is claimed. Formal R188 and its unavailable wider protected evidence remain
**UNRUN** locally and are separate from these fork checks. The boundary diagnostic still exits 1:
all seven original-JavaScript boundary routes remain **STOP**.

Timing is blocked by host load 11–20, above the required 2. Do not disturb other workloads or
accept overlapping timings. After correctness gates, obtain six fresh processes per arm on a quiet
host, re-profile edits, repair the next demonstrated edit cause, then continue the completion unit.

Read-only completion investigation identifies two separate costs for the next verified unit:
`NodeIndexTable::get_index` lazily sorts indices using repeated global `get_node_id` map access.
The workload edits before each completion, so this cold sort repeats per source version. Consider
sorting/searching the existing full `Node` handle only for tables proven unique, preserving slots,
nil/missing behavior and per-source ownership; do not change global node IDs. Duplicate tables must
retain the exact existing ID-based path, rebuilt from original encoder order: binary search selects
a matching midpoint, and changing distinct-key order can select another duplicate slot. Distinct
slots can have distinct JS wrappers and encoded parents even when they resolve to the same Rust
node. Add old-versus-candidate controls for duplicate ranks, preassigned IDs, synthetic/foreign
aliases and per-slot JS identity. Prove every lookup against the old result and retain old versions
across edits before measuring. Of 303 exclusive diagnostic
`wrap` samples, 257 follow token navigation through `classicChildren`, 18 follow semicolon detection,
and six follow checker declaration decoding. A separate token-position optimization must retain
public child-array semantics. Eager symbol loads are per newly interned object; disabling eager
loads alone has no demonstrated saving and must not be presented as a repair.

Read-only preparation for later units (no candidate changes or closure claimed):

- TypeScript 6.0.3 package-scope probe: **360 observations / 720 passing assertions**. Ordinary
  `.ts`/`.d.ts` outside `node_modules` perform implied-format scope lookup only under Node16/NodeNext;
  inside `node_modules`, Classic/Node10/Bundler also lookup. Fixed `.mts`/`.cts` retain their fixed
  format without that lookup. Apply an explicit classic policy before parse-cache access, in serial
  and parallel paths; retain native package-directory/symlink behavior and independent resolver reads.
- JSON syntax-only probe: a fresh **27-fixture TypeScript-only baseline** is retained at
  `/work/tmp/tsrust-ls-probes/u11-preparation/ts603-json-baseline-5a8183e6-8fb1-4298-b6f2-251a2b1ed2b7.json`.
  Use a dedicated Rust syntax-only parse entry, explicit synchronous instance action and standalone
  retained source lease; keep native validating defaults and registry parse-cache policy unchanged.
  Redirect the lexical `parseJsonText` wrapper and guard its retained original implementation:
  replacing only the namespace export leaves config parsing on the original parser. Do not filter
  validating diagnostics afterward. Cover parentless visibility, actual node/identifier counts,
  identifier-map membership/order, recovery-list ranges, multiline/Unicode flags and empty JSON
  pragma/reference metadata. The historical u7 prototype is incomplete and is not current proof.

## Native regression repair after r35

Source `8523cc943d120e31b43a7f2e6879d2e9d3df333b` repairs the protected-test losses
found by the local comparison of `9f6ee6d1` with `291a002b` (still present at `94c71d7b`):

- Regenerated `binder/lib_bind.bin` with the unchanged `generate_lib_bind_snapshot` test.
  The binder source extraction in `891c14ca` changed its source hash without changing native
  lib binding. All three regenerated sections are byte-identical to the earlier sections
  except their first eight source-key bytes. New blob SHA-256
  `225d43908dbb7c68f94a9fced14f4978988ed226c5883336906f1d771a2de23d`.
  The generator passed with Rust 1.98.1, release profile, running alone.
- The native test host handles `Op::PollCancellation` with an empty successful response,
  matching a runtime host without a cancellation callback. Its new test checks the public
  host-call result. The previously missing match prevented native `ts_wasm` tests compiling.

Evidence is under `/work/tmp/tsrust-ls-probes/u5/`. The complete local protected build and
comparison finished in `protected-repair`, using Rust 1.93.0, all 14 test binaries including
`ts_wasm`, Go pin `673a5f17d713`, and the preserved local base result
(`/work/tmp/goport-protected-base/results/results.json`, SHA-256
`76a034e680ac0b9e934b832452206aa0c1d6016798c70d7086cd28ace9aeaf0e`).
The comparison retained **181,891** base passing suite/name entries, with **0 lost, 0 absent,
0 unrun**, no incomplete suites, and one new passing cancellation-host test. Both native
`ts_wasm` tests passed. Candidate results SHA-256:
`30d69bec893d6ffed4325d5e1ffaa044b2be0d80befad3752f6d20d517c4225c`.
Its crates tree is `35e9e0253d06b19a0e5c5457a1fd8dc1a1c521a7`; binary-manifest SHA-256:
`28f01c96e6a8f8000c9df574fc273437c26c47d99182c9a812c4f29052ac72a4`.
The local scratch runner only adapts pin paths and sandbox destinations; the preliminary
runner that excluded `ts_wasm` is not used. Independent reviewer `af9b8b5f413b1cdc5` and
regression auditor `a3455239e0083b302` both returned source-bound **PASS** verdicts for this
narrow local fork repair, checking source identity, binary manifests, per-name retention,
and normal closure. Earlier failing base-environment and old-head evidence remains preserved;
neither verdict claims formal acceptance.

Native-regressions gate limitation: the local branch base has 181,891 passing suite/name
entries, but it is not the last accepted R188 source. The saved R188 protected result,
gate and oracle evidence live on Theo's unreachable hosts and are absent locally. The existing
full candidate runner names that unavailable remote home. Fork development uses the complete
source-bound local test comparison, independent review, and corpus/baseline checks; it does
not accept a revision into Theo's main or replace his saved accepted base. The formal gate,
bound Query/Hono runs, LSP/API oracles and np-suite remain unrun. The local comparison is the
available fork regression check, not evidence that these unrun formal checks passed.

Fresh release-WASM roster `r36` completed at this repair source: **7,482/7,853**
(fourslash 5,958, services 1,524), with zero lost or gained passing names against `r35`.
Runtime tests passed **50/50**. Module SHA-256:
`787ddc64276efaaca74272f65f022f24bc8e8ee501b2041fa079237af30a3b60`.
The default-stack 5,000-term fixture still overflows in subtree facts during emit; construction,
syntactic and semantic diagnostics, and quick info complete. Emit stack repair and public exports
have not advanced. The unchanged-source ES2020 emit baseline contains 19,915 valid UTF-8 files
from the original TypeScript 6.0.3 `src` and `tests/cases` (19,922 paths inventoried); its module
copy and output hashes are preserved under `u5` for the next compiler comparison. The preceding
ES5 corpus run is retained as preliminary target-choice evidence, not the supported-target proof.
The 75 removed-TypeScript-Go-semantics cases below stay listed and out of scope.

The next emit unit (`u6`) assigns the facts evaluator and focused tests exclusively to one
writer, with fresh independent review and regression audit. Its comparison tools preserve
classic test occurrences (7,482 passes include three duplicated titles) and every corpus row,
including 170 no-output files. Positive controls retain the whole reference; deliberate
single-output-byte and duplicate-test regressions are rejected. Default-stack cold/warm emit
controls pass at 100 and 1,000 operators with byte-identical TypeScript 6.0.3 output, while
5,000 operators still fail before the facts repair. The completed evaluator diff has independent
static review with no blocking findings at `node.rs` SHA-256
`bafa16904093310533e9d489f1003c5a6fcbb605923c1a9622673d06e77f4fb4`.
Its static atomic cache reference is stable and retains no node-data or TLS borrow; raw publication,
dependency order, member-name repropagation and skipped-child behavior were reviewed explicitly.
Release focused tests pass 16/16 at compiler commit `7f3a75459afab2be645b90f64bb3268c2e2a49ed`;
complete source-bound runtime gates remain pending. Committing the node source exposed its parser
snapshot key dependency, so the first queued gate runs were cancelled before runtime and retained.
The unchanged ignored parser generator refreshed `lib_parse.bin` at
`7480fbfb68bd148d6a7c0058ba29d8087c687cc0` (crates tree
`6941f00f750b834ae1ce3d4c5db20ac4eef1fc60`). Both sections remain byte-identical after their first
eight source-key bytes; blob SHA-256 is
`609837bdb62d0b59537a17f3811073e8344d3fbe183182e69bcfebdc78d34a0c`.
Fresh gates use `u6/verified` with both immutable local-base and repaired-u5 comparisons.
Roster `r37` retained all 7,482 passing occurrences out of 7,853, with zero lost, absent or gained;
the full runtime suite passed 50/50. The refreshed module SHA-256 is
`82947be6892a17788c9864e0c366d9a22c4cd32d11aa903ae05b1d3810951a51`.
The unchanged emit corpus failed: 19,913/19,915 rows identical, two stress fixtures changed from
emitted output to stack exceptions, and no source or coverage changes. Those losses block pushing
this unit. Exact standalone default-stack controls also fail on the saved pre-facts module
(in facts), while the candidate fails in linked references; neither control erases the saved
successful corpus rows. A complete original-baseline repeat is retained separately under
`u6/verified/protected-runtime-retry`; engine tiering is an unconfirmed explanation.
All 14 protected binaries built, but the first native runtime launch stopped before executing
any suite because its separate tool checkout could not resolve the candidate commit. A local Git
fetch corrected object visibility without changing tool source. The complete source-bound retry
then closed normally: all 14 binaries, 181,905 passing entries and 3,623 ignored, no incomplete
suites. Comparisons retained 181,891 local-base passes and all 181,892 repaired-u5 passes, with
zero lost, absent or unrun; the thirteen new facts tests pass. Results SHA-256 is
`3194d6acf15a64640384ba2be0848a0412add00583df3af3c22ebb258cf9b89a`.
The failed launch and original corpus results are preserved; native retention does not clear
the corpus/deep-operation STOP.
This is not an accepted compiler unit. The refreshed release module is 19,381,756 bytes.
Its actual default-stack 5,000-operator emit now fails in
`checker/emit_resolver_p2.rs::mark_linked_references_recursively_visit`, reached through the
recursive child callback. Subtree-facts recursion is absent from this new observed stack.
Construction, diagnostics and quick info still pass; 100/1,000 cold/warm emit remains exact to
TypeScript 6.0.3. The complete deep-emit comparator correctly fails at 5,000, and disposal trap
is recorded separately. Linked-reference traversal is the next demonstrated stack repair;
transformer/printer paths remain potential later exposures, not currently observed failures.
Both independent roles issued interim STOP for the two lost corpus outputs and incomplete deep
operation. The full exact old-module corpus repeat also loses those two outputs, but the original
successful rows remain protected without a flake waiver. The same sole writer now owns only
`checker/emit_resolver_p2.rs` and its focused tests for a bounded regression repair of the measured
linked-reference walk. The same reviewer/auditor remain assigned; facts/snapshot hashes stay
frozen. This is repair within the blocked batch, with complete fresh gates required before push.

The bounded linked-reference worker is now implemented with an owned DFS stack and four
same-file real-checker tests. Independent static review found no blocking code findings against
pinned Go preorder, child order, import skips, root exclusion and checker ownership. Root's
first release-test compile failed before execution on two test-only `EndOfFileToken` spellings;
those were corrected to the repository's `EndOfFile` variant, with the original failed launch
preserved in `u6/linked-focused`. The reviewer verified production code is byte-unchanged;
corrected file SHA-256 is `f39a7ced487cdd94f84ee607787278d2a6beaab11ce055e56a4cb296d219b3a3`.
The two release retries on that corrected source (`u6/linked-focused-2` and the separate
backtrace run) execute three passing controls and one failing deep fixture. The actual stack
is `is_jsx_tag_name` reading a nil parent: factory child ownership does not create parent links.
Root added only parent-link setup before marking; independent review verified unchanged
production and deep assertions. Fresh `u6/linked-focused-3` passes all four tests serially.

The linked-reference repair is frozen locally at `95d61edb47d4e1a656f3e6118d7dcd1891432020`,
crates tree `ac134eeab746ad1d1d80839217d7b08f5eedc3c5`, with fresh gates under
`u6/linked-verified` and roster label `r38`. It is unpushed and unaccepted. The actual default-stack
probe now gets beyond facts and linked-reference traversal, then overflows at 5,000 in
`transformers/moduletransforms/es_module::visit_in` through
`visit_each_child_binary_expression`. 100/1,000 cold/warm output remains exact. Disposal after
the trap still fails. The same writer completed the bounded diagnosis of this newly observed transformer barrier.
Frozen gates have closed; the next repair is limited to the two structural binary-transform
paths described below. No corpus recovery, full emit success or STOP closure is claimed.

Fresh frozen-source results now retain all 7,482 classic passing occurrences (5,958 fourslash,
1,524 services), with 371 failures and no lost/absent/gained identities; full runtime tests pass
50/50. The original 19,915-row corpus still differs only on the same two protected stress rows:
19,913 identical, no missing/changed sources, outputs 19,745 → 19,743. Both exact CLI controls
now overflow in `ConstEnumInliningTransformer::visit` through the same generic binary-child
visitor. Saved module SHA-256 is `65e97010546b1b8c7b1b8dd1015b995577a5e1b402cd6f4b019922871cde94a8`;
corpus SHA-256 is `515d7bf5945f78bc690732b278f74c2c6e008cda0346948187a8380cd8a2b509`.
The complete fourteen-binary native runtime closed normally with **181,909 passing entries**,
3,623 ignored and no incomplete suites. Comparisons retain all 181,891 local-base passes and
181,892 repaired-u5 passes, with zero lost/absent/unrun and respectively 18/17 new passing names.
Results SHA-256 is `ce2540d73152340c868642928c52a0654bc4938d4ace1c4c2de174452c3d66de`;
binary-manifest SHA-256 is `979fa5f98b4b295969461b0d1b8f9203463005b11a6b0d61f9f7e33de159f895`.
The same independent auditor verified all source/binary bindings and per-name retention, clearing
the missing-native-evidence blocker only. Its source-bound verdict remains STOP for the corpus
and deep emit failures. The WASM gate closes `FAIL rc=1`; no previous failure is erased.

Read-only diagnosis identifies a bounded shared binary continuation for the two demonstrated
transformers, preserving Go's modifiers → left → optional type → operator → right traversal and
postorder factory updates. Nonbinary callbacks must retain real const-enum replacement/pruning
and ES-module import/require rewriting/finalization. It is explicitly opt-in for structural
binary callbacks with empty override hooks; generic `ast::visitor` behavior stays unchanged.
Existing subtree facts do not prove safe pruning for either whole transformer. Independent
Go-alignment design review found no blocking issue in this narrow boundary, while retaining STOP.
After normal frozen-gate closure, the sole writer owns `transformers/utilities.rs`,
`transformers/moduletransforms/es_module.rs` and `transformers/inliners/const_enum.rs`, including
focused tests in those files. Root retains integration, execution, state, commits and pushes.
The pre-edit hypothesis and exact expected recoveries are recorded in state note
`classic-wasm-u6-binary-repair-preflight`: default-stack 5,000-operator synchronous emit and both
original corpus stress outputs must recover byte-identically, with all retained gates rerun.
Consecutive binary-chain safety is the bounded claim; any later observed barrier remains a failure
requiring its own diagnosis. Generic visitor changes, subtree-facts pruning and speculative printer
repairs are outside this patch.

The three-file draft now implements the owned binary continuation and adds thirteen
`binary_transform_` tests covering deep geometry, static/scoped handles, ordering, replacement
pruning, metadata, real-checker enum values and module rewriting/finalization. The same reviewer
found no blocking static correctness issue; this is no runtime PASS. First complete serial library
compile (`u6/binary-library-1`) failed before executing tests on two test-only `NodeList.to_vec`
accesses. Root changed only those accesses to `NodeList.nodes().get(0)` and preserved the failed
source/log. The corrected draft is frozen by hashes under `u6/binary-library-2`; a fresh complete
serial release library retry failed (427 passed, three failed, two ignored). Two new controls
had invalid setup assumptions: a stored field-backed empty modifier list differs from its
factory input handle, and initial program parsing uses static storage. Root preserved that run
and corrected only fixture setup: compare the saved stored list identity, retain nil/present-empty
and location checks, and force an owned direct parse with explicit storage-tier and existing
cold/warm/oracle checks. The unchanged formatter test also lacked documented `TS_GO_REPO`;
the preceding frozen binary reproduces its exact missing-path failure without that variable and
passes with the pinned fixture path (`u6/binary-format-base-controls`). A fresh complete serial
run (`u6/binary-library-3`) uses corrected fixtures and that existing pinned input. Production is
unchanged. This fresh complete run passed: **430 passed, zero failed, two ignored** (8.76s).
The same independent reviewer verified both fixture corrections and the environment controls
with no blocking finding or weakened traversal assertion. Failed runs remain preserved;
no waiver, runtime recovery or acceptance is claimed.

Root froze this compiler-only repair at `ae233dc3acffb9b6ef22fe71049d3e5531cb8bbc`
(crates tree `946ff19d0db1930a5a4d7f497be0126308a68455`). Fresh source-bound full gates
are running under `u6/binary-verified`, classic label `r39`: runtime, default-stack deep
cold/warm/disposal, both exact CLI stress cases, unchanged classic roster and original
emit corpus, plus all fourteen native binaries and retention against local/u5/linked bases.
The early runtime portion has now completed: **50/50 runtime tests**, and real synchronous
facade program/diagnostics/quick-info/cold emit/warm emit/disposal pass at 100, 1,000 and
5,000 operators on Node 22.23.3 with the default stack; all compared outputs match the
unchanged TypeScript 6.0.3 reference. Both exact CLI stress fixtures again produce outputs
identical in source hash, exit code, file name, length and SHA-256 to their original successful
corpus rows (`early-runtime-note.json`). The complete unchanged `r39` classic roster has also closed: **7,482/7,853 retained**
(fourslash **5,958**, services **1,524**), zero lost/absent/gained or added/removed identities;
371 failures remain. The strict original emit corpus has now closed **PASS: 19,915/19,915
identical rows and 19,745/19,745 outputs**, zero changed/missing/source-changed rows,
including restoration of both original stress outputs. `wasm.status` is `DONE`.
All-fourteen native checks have now closed `DONE`: **181,922 passing entries, 3,623 ignored**,
19 covered suites, no incomplete suites. Per-name comparisons retain all 181,891 local-base,
181,892 repaired-u5 and 181,909 linked-source passes, with respectively 31, 30 and 13 new
passing entries; zero recovered/lost/absent/unrun/new-failed entries and no maps. All 24 native
manifest entries and six source hashes verified. Results SHA-256:
`480968752d981f2265237a185944b048be55184fd1bbaed8c908a16d9f3cd14c`; binary manifest:
`327d0310627226cf4715a286b9446cb5ef88f0b414dceda8562bf7b2385da500`.
The same independent reviewer and auditor both returned source-bound **PASS** for this exact
bounded local regression repair. The native/corpus/deep regression STOP is **closed** on
`ae233dc3`/`946ff19d`; all failed earlier runs stay preserved without waiver or retroactive PASS.
This is **not formal R188 or overall language-service acceptance**. Current-fork Query/Hono,
LSP/API oracles, np-suite and full quality remain unavailable/unrun; historical accepted state
is unchanged. Browser loading/public exports, remaining classic repairs, performance and
original-JavaScript compiler-entry closure remain separate outstanding work.
Native, runtime, classic, corpus and deep outcomes above
remain results of the preceding linked-source commit and cannot be carried forward to this draft.

Read-only `r36` rename investigation finds 29 family cases, 16 passing and 13 failing. Eleven
fail in the harness's second, post-move check; their first check passes. The classic algorithm
uses ordered `failedLookupLocations` to recover the old import target after moving it, but the
Rust resolution wrapper supplies none. Six truncated content mismatches beginning with a reference
directive do not establish a triple-slash defect. The `_amd` and `_preferences` failures occur
before the move and separately require legacy resolution analysis; neither is newly excluded.
Recovery counts and exact returned edits remain unverified until the ordered focused run.
The moved-importer branch has an additional no-fallback boundary gap: generated
`getEditsForFileRename` calls its lexical original JavaScript `resolveModuleName`, without Rust
delegation. Package metadata lookup can fall from strict `JSON.parse` into original
`Parser.parseJsonText2`, which bypasses the guarded `Parser.parseSourceFile`. This is demonstrated
static reachability, not a claim that a roster case executed the parser fallback. Resolution must
become Rust-owned and the JSON parser bypass must close; current guards do not prove the full
no-JavaScript-compiler/parser requirement.

The subsequent read-only `r42` investigation confirms the same thirteen failing rename occurrences
and exposes a larger resolver seam. Native `DefaultResolver` in
`crates/ts_goport/src/frontend/module/resolver_p1.rs:638` supports Node16/NodeNext/Bundler,
while Classic/Node10 are absent. Native missing-directory branches return early where TypeScript
6.0.3 records suffix/package/index candidates without invoking `fileExists`. Callback logs therefore
cannot substitute for ordered lookup arrays. Add native metadata at `resolver_p2.rs:719`
(`try_file_lookup`) and `:991` (`get_package_json_info`), including cache hits and omitted callbacks;
preserve duplicates, alternate-pass paths, and primary/fallback concatenation order.

The live moved-importer branch is pinned `typescript.js:144872`, invoking lexical resolution with
no cache/mode; `:144900` consumes failed locations in order. Other live lexical callers include
module-specifier services and import-attribute code fixes. Direct exported Classic/Node10/Bundler
and type-reference resolver families also need Rust routing. Existing native module `Arc` and
reference `Rc` caches must retain result-object identity, missing-result distinctions and separate
undefined/CommonJS/ESNext mode keys. The frozen program-resolution snapshot alone cannot resolve
arbitrary post-move imports. A dedicated synchronous resolution-host adapter must preserve direct
`fileExists`, `directoryExists`, `readFile`, `realpath`, trace and exception behavior; the generic
stat bridge's file-then-directory probes are not the classic callback contract.

This is a complete operation, not a thin response-field fix. Scope includes native resolver/cache/
result types, `classic_resolutions.rs`, graph and host transport, and matching classic JS adapters;
the generator owner redirects lexical and public families afterward. Syntax-only package JSON
parsing is a dependency. Verify five strategies, modes, redirects, missing directories, suffix and
package order, paths/rootDirs, malformed JSON, symlinks/casing, callback traces, duplicate metadata,
cache hit/readonly/clear behavior, program isolation, and both pre-/post-move rename results.
Retain every unchanged roster occurrence; no repair or recovery count is claimed yet.

A separate static boundary audit found additional bypasses: syntactic comment classifications
call the lexical original isolated-JSDoc parser; isolated entity-name/JSDoc parse APIs also remain
on the candidate namespace. Editor `ChangeTracker` text and Rust-checker display writers reach
the original `createPrinter().writeNode` pipeline, which the `emitFiles` guard does not cover.
Namespace compiler transforms and standalone declaration diagnostics can likewise enter original
transformation code. These are source-demonstrated routes, not new runtime fallback measurements;
namespace exposure is distinct from the still-unpublished package exports. Rust-backed isolated
parsing/printing boundaries and original-entry guards are required before claiming no fallback.
Scanner-based editor algorithms, synthetic node factories and external reference harnesses are
separate from these compiler paths. The original main binder/checker entries and full-file
`Program.emit` delegation remain covered by the inspected guards/bridge.

A preliminary fixed-workload control is preserved in `u6/performance-baseline-manifest.json`:
real TypeScript 6.0.3 and the pre-facts candidate both finish construction, open, 30 edits,
completions, quick info, diagnostics, and 20,000 line-position round trips on Node 22.23.3.
This is one paired baseline, not the replicated final performance gate. Both use 31 snapshot
callbacks and zero `readFile` callbacks; the candidate adds 155 `fileExists` calls. The existing
LSP line-map benchmark on the same preserved module makes zero file reads for warm semantic
tokens and document symbols at 1,000 and 4,000 rows. References still make 1,001 and 4,001 reads;
those counts are recorded separately. Read-only ownership investigation confirms the converter
and line-map cache survive warm requests. The remaining per-reference read occurs earlier in
`LanguageService::get_script`, through WASM `LanguageHost::read_file`; the retained program text
is not reused at that host boundary. Pinned Go makes the same logical read through a snapshot
that reuses file content. This identifies the bridge seam, not a measured repair. An isolated
comparison must hold one source base and vary only the earlier line-map callback; comparing
whole commits also varies wrappers/error handling. Classic line-position round trips and snapshot
counts exercise another path. The earlier cache speedup is not yet isolated by a before/after-source
comparison.

Browser/export preparation identified the remaining loading blocker: private `classic.js`
statically imports the Node loader; package exports and declarations still describe the
asynchronous editor service and do not expose `createDocumentRegistry`. The browser unit must
share environment-neutral namespace setup, use environment-specific loaders, and test the
actual exported synchronous facade with a size-profile module in all four browser/realm cells.
Historical private-channel browser evidence is not a current-source facade gate. Its scratch
harness failed to enforce the main-thread result; the new matrix must require both main and
worker results. `scripts/check-typescript-api.mjs` also defaults to a missing `index.js` and
must target the chosen public entry while checking both factories.

## Deep-expression stack check (r35)

Injected run: **7,482 of 7,853** (fourslash 5,958, services 1,524), the same names as `r34`
(none lost, none gained), on a fresh release module (`/work/tmp/tsrust-ls-probes/u3/r35*`).

Finding: the binder and checker repair (`binder/wasm_binary.rs`, `checker/wasm_binary.rs`) still
holds; it did not regress. The 5,000-term check failed on a newer recursive path: every parse the
classic factory or the host channel ships to JavaScript goes through the API AST encoder
(`api/encoder/encoder.rs` `encode_tree`), which recursed through the `NodeVisitor`, as Go's
`encodeTree` does. It has done so since the classic bridge first encoded parses (`891c14c`,
binary payloads in `687dc66`), so no bisect was needed. A registry parse inside a build's host
callback then trapped, and the outer request reported the follow-on `TypeError: Cannot read
properties of undefined (reading 'buffer')` from `fs_take` in place of the `RangeError`.

Fixes:

- `ts_goport` (reviewed): the encoder's visit and its list hooks collect each child that
  `visit_each_child` reaches, and `run_encode_tasks` visits them with a task stack in Go's
  preorder (sibling links, parent indices, list entries, the store-data children mask, JSDoc
  after children, the root's children then its JSDoc). Unpublished parses (the classic registry)
  and published store files both take it.
- `classic-instance.js`: a nested request's trap stays the instance's failure (`failure ??=`), so
  callers see the real error.

Evidence: 39,615 encodings of TypeScript 6.0.3's `src` and `tests/cases` (19,915 files, static
and freeable publishes) are identical in length and hash to the unchanged encoder at `291a002`
(temporary dump, not committed); an intermediate version that dropped the root's child order was
caught by that comparison, so `assert_same_encoding` now also checks the node table against
the recursive `build_node_index_table`, and the test has a 1,000-term sample. `go_baselines`:
1,402 pass on base and candidate, the same names (130 fail on both). `ts_goport` lib tests
single-threaded: 398 pass on both, the same two failures (`snapshot_matches_live_bind`,
`test_format_format_checker_ts`); parallel runs fail 62 to 69 tests on base and candidate alike
(shared store state between test threads). Runtime tests 50/50.

Review record (independent read-only reviewer): `goport-encoder.diff` 04b49c8f6d912643…,
`encoder.rs` c5339877fa2f9174… ACCEPT, no blocking findings; one comment nit (the deep-sample
comment said the visitor recurses), fixed in the committed file, which changes nothing else
(committed `ts_goport` diff against `291a002` cdc264b79d4c4e17…, `encoder.rs` c768f3062dbcc55d…).

Node 22, default stack, synchronous `createLanguageService` (`/work/tmp/tsrust-ls-probes/u4/deep.mjs`):

| Case | TypeScript 6.0.3 | Candidate |
| --- | --- | --- |
| 100 and 1,000 terms (`+`, string `+`, `&&`/`\|\|`, comma) | pass | pass |
| 5,000-term `1 + …`: program, syntactic and semantic diagnostics, quick info | pass | pass |
| 5,000-term `1 + …`: `getEmitOutput` | pass | `RangeError` |
| 5,000-term logical chain | `RangeError` | `RangeError` |

Remaining stack path, the next item: emit overflows in `ast/node.rs` subtree facts
(`composite_subtree_facts` → `subtree_facts_of_data` → `propagate_node_facts`, which recurses per
child). After it, check the transformers and the printer at 5,000 terms (with a 200 MB V8
stack every step passes at 5,000 and 20,000 terms, so depth is the only problem). Each is a
`ts_goport` change and needs the review.

Portable-runtime gate, not started: the browser checks in `/work/tmp/ts-rust-wasm-pr/`
(`browser-check.mjs`, `classic-browser-check.mjs`) were written on the Mac (`~/Library/Caches/
ms-playwright` executable paths, a `./browser/node_modules/playwright` install and a
`node-candidate` copy of `npm/wasm`). On this host: install Playwright under
`/work/tmp/ts-rust-wasm-pr/browser`, drop the `executablePath` overrides, run
`/work/projects/platform/scripts/playwright-webkit-arch.sh` after a WebKit download, and build the
size profile (`WASM_PROFILE=wasm`), since Chromium refuses synchronous instantiation of the
19 MB release module on its main thread. Add the deep fixture, emit and error paths to
`test/classic-runtime-sequence.mjs` before the run. The public exports wait for this gate.

Next, in order: emit-path stack repair (above); browser matrix; then `getEditsForFileRename*`
(6), `breakpointValidationDestructuring*` (12), "Found 2 codefixes" (5), JS export-assignment
errors (4), a port of `checkSourceFileNodes`, the JSDoc `@import` reference, verbosity
diffs; then the performance gate.

## Node locals, meta properties and more checker members (r33, r34)

Injected run: **7,482 of 7,853** (fourslash 5,958, services 1,524), none lost against `r32`
or any earlier run (`r33` 7,443, `r34`). No `ts_goport` source changed.

- `ImportAttributes.elements` (Go's field is `attributes`), the global `ImportAttributes` type
  for an import attributes node, and `type.checker` on every type.
- A node reference to one of Go's reparsed JSDoc clones (a `@template` type parameter in a
  symbol's declarations) answers the parsed JSDoc node with the same kind and range.
- Index and string mapping types name their operand `type`, as classic's do.
- `getTypeAtLocation` of the `import` or `new` keyword of a meta property answers classic's
  `checkMetaPropertyKeyword` (`ImportMeta` expression and `NewTargetExpression` types); Go's
  is an unported stub.
- Symbol links carry `originatingImport` and its `target` (the port's export type links), so
  the invalid-namespace-import fixes appear.
- Parsed nodes answer `locals` from the binder, with an empty table where classic's binder
  makes one (`ContainerFlags.HasLocals`).
- New checker members over Go's functions: `symbolIsValue`, `isEmptyAnonymousObjectType`,
  `tryFindAmbientModule`, `getSuggestedSymbolForNonexistentClassMember`,
  `getSuggestedSymbolForNonexistentJSXAttribute`, `requiresAddingImplicitUndefined` (Go's
  emit resolver worker) and `typePredicateToTypePredicateNode`.

Classified in this batch (counts added to the table below): JavaScript `this.x` and
`prototype` properties cannot be renamed (5) and `convertFunctionToEs6Class1` and
`_falsePositive` (2), constructor functions; `jsObjectDefinePropertyRenameLocations` (1), JS
expando. Go reports an unused `infer` or JSDoc type parameter as TS6196 on its name where
classic reports TS6133 on the `infer` node, so classic's fix fails in `deleteNodeInList` (6
`codeFixUnusedIdentifier_*` cases; a design difference, not a removal).

Next in the requested order (`r36`, 371 failing): `getEditsForFileRename*` (13 failures;
11 post-move and two pre-move resolution cases), `breakpointValidationDestructuring*` baselines
(12 in four groups), "found 2 codefixes" (5), JS export assignment errors in modules (4),
and `getRegionSemanticDiagnostics` regions.

## Cancellation polls, classic AST views, symbol walker and hover verbosity (r27 to r32)

Injected run: **7,402 of 7,853** (fourslash 5,878, services 1,524), none lost against `r26`
or any run since (`r27` 7,322, `r28` 7,334, `r29` 7,371, `r30` 7,398, `r31` 7,402, `r32`; runs in
`/work/tmp/tsrust-ls-probes/u3/`; the roster takes 5.4 minutes and peaks at 4.3 GiB). One `ts_goport` change (cancellation polls), with an
independent read-only review: STOP on module order in `checker/mod.rs`, fixed, then ACCEPT
(`goport-cancel2.diff` and `host_cancellation.rs` hashes in the review record below).

Bridge changes (no `ts_goport` change):

- Literal nodes have classic's `isUnterminated` and `hasExtendedUnicodeEscape` fields
  (`parseLiteralLikeNode`), so string and path completions find an unterminated string.
- The port's index symbol (a transient property with `CheckFlags::INDEX_SYMBOL`) reads as
  classic's `Signature` symbol, and `getIndexInfosOfIndexSymbol` is Go's function with the
  parent's members as siblings: quick info shows `(index) T[string]: V`.
- Builder template parts leave `rawText` undefined, as classic's factory does.
- Symbol `links.nameType` comes from the port's value links (implement-interface names of
  remapped mapped-type members).
- Go's reparsed JSDoc casts (`/** @type {T} */(e)` becomes an `as`/`satisfies` node in Go) are
  transparent: classic sees the operand as the child and parent.
- A JSDoc `@template` list has classic's range (Go's parser gives it an empty one).
- `getContextualType` of a token in an array literal answers classic's element type
  (`getContextualTypeForElementExpression` at index -1, with classic's inference blocking);
  Go's `getContextualType` answers only an element.
- `modifierFlagsCache` of a parsed node answers the value classic's `getModifierFlagsWorker`
  stores; class member snippets read it directly.
- `declare global` has `GlobalAugmentation`; Go keeps only the keyword, which the encoding loses.
- The types of `implements` and of an interface's `extends` read as classic's
  `ExpressionWithTypeArguments` (dotted names as property accesses); Go parses them as type
  references.
- `program.getCachedSemanticDiagnostics` answers a file's whole-file semantic diagnostics.
- `checker.getSymbolWalker` is classic's walk (`symbolWalker.ts`) in the bridge crate over the
  port's checker functions, results in id order. `accept` runs in JavaScript: the walk reports
  symbols in visit order and walks again with each new rejection.
- Builder requests take classic's `maximumLength`, `verbosityLevel` and `out` through Go's
  `VerbosityContext`; `writeType`'s cut uses `maximumLength`. `getEmitResolver()` answers
  `symbolToDeclarations` with Go's hover expansion (`expandSymbolForHover`). Builder output
  keeps no symbol on declaration names, as classic's builder makes bare identifiers there.

Cancellation: classic's checker and node builder call `throwIfCancellationRequested()` in
`typeToTypeNodeWorker`, `createRecoveryBoundary`, `checkExpressionWorker` (class, function and
arrow expressions) and `checkSourceElementWorker` (module, class, interface and function
declarations). `ts_goport::checker::host_cancellation` adds a Rust-only poll at those four
points; nothing is armed except during a bridge request that carries a classic token. The
module cannot unwind (`panic = "abort"`), so the poll calls the token through a host operation
(`Op::PollCancellation`): the token's exception is held, the poll disarms, the request finishes
with consistent checker state, and the bridge then throws the token's own exception without
invalidating the session. Tokens come from `runWithCancellationToken`, `getDiagnostics(file,
token)` and the program's semantic, suggestion and declaration diagnostics. The services
cancellation unit passes 5/5.

Review record (independent read-only reviewer, one at a time): first candidate
(`goport-cancel.diff` f6f42366…, `host_cancellation.rs` f80c26f9…) STOP: `host_cancellation`
out of rustfmt's module order in `checker/mod.rs`; placement of all four polls confirmed
against classic, no effect when unarmed, no classic poll site missing. Revised candidate
(`goport-cancel2.diff` 7826f0c3…, `host_cancellation.rs` 47079df7…; the poll runs its closure
with no borrow held) ACCEPT, with one note that the comment overstated disarming from inside
the closure; the committed file narrows that comment and changes nothing else.

Deviations: a cancelled request finishes its Rust work before the exception reaches the caller;
`getRegionSemanticDiagnostics` returns the file's whole diagnostics for the region request (the
port has no `checkSourceFileNodes`); `symbolToDeclarations` uses Go's fixed builder flags; the
emit resolver has only `symbolToDeclarations`; display parts of reused source nodes (classic's
`serializeExistingTypeNode`) differ where Go builds fresh nodes.

Custom transformers (`program.emit` and `getEmitOutput` with `customTransformers` or a host's
`getCustomTransformers`): not implemented; the call throws. Design: `before` transformers take
and return classic `SourceFile` trees with a `TransformationContext`; `after` and
`afterDeclarations` take the transformed JavaScript and declaration trees. Running them without
the classic emitter needs (1) an encoder from arbitrary classic trees, including synthesized
nodes and their `emitNode` data (comments, emit flags, helpers, source map ranges, `original`),
into Rust syntax trees; (2) a `TransformationContext` over the Rust transformer pipeline
(hoisting, helpers, `onSubstituteNode` and `onEmitNode` hooks, the emit resolver); (3) a classic
view of the Rust pipeline's synthesized output for `after` transformers, encoded back through
(1) for the Rust printer. Printing transformed trees with classic's printer is the classic
emitter, which the no-fallback rule excludes. The design is sound but large: each part is new
ABI and code, and no case of the 7,853 depends on it (the transform unit tests,
`customTransforms.ts` and `transform.ts`, are outside the services suite).

Classified, not changed (TypeScript-Go removed semantics; owner decision), by case (`r32`):

| Group | Cases |
| --- | --- |
| Constructor functions get no `this`/`prototype` members | 36 (`convertFunctionToEs6Class*` 28, `getJavaScriptSyntacticDiagnostics24`, `jsDocFunctionSignatures7`, `jsDocFunctionSignatures8`, `renameJsPrototypeProperty01`, `02`, `renameJsThisProperty01`, `05`, `06`) |
| Closure `function(...)` JSDoc types | 12 (`getJavaScriptQuickInfo1`, `6`, `jsDocFunctionSignatures12`, `jsDocGenerics2`, `quickInfoJSDocFunctionNew`, `quickInfoJSDocFunctionThis`, `annotateWithTypeFromJSDoc4`, `16`, `23`, `getJavaScriptCompletions8`, `9`, `10`) |
| `outFile` concatenation and AMD output | 12 |
| Bare `?` JSDoc unknown type (Go reports TS1110) | 3 (`codeFixChangeJSDocSyntax1`, `18`, `19`) |
| `@enum` | 3 (`quickInfoJSExport`, `quickInfoJsdocEnum`, `codeFixInferFromUsageExistingJSDoc`) |
| CommonJS beyond `const x = require()` (`module.exports = require()`, an `exports` alias, exports in an IIFE) | 3 (`refactorConvertToEsModule_export_alias`, `refactorConvertToEsModule_export_moduleDotExportsEqualsRequire`, `javascriptModules22`) |
| JS expando forms (`Object.defineProperty`, element-access declarations) | 4 (`quickInfoOnExpandoLikePropertyWithSetterDeclarationJs1`, `2`, `quickInfoElementAccessDeclaration`, `jsObjectDefinePropertyRenameLocations`) |
| `@typedef` without a type; hyphenated JSDoc property names | 2 (`quickInfoJsdocTypedefMissingType`, `jsDocTagsWithHyphen`) |

That is 75 cases (through `r34`). TypeScript-Go design differences that are not removals, also unchanged:
Go parses an exported class in a namespace outside `AwaitContext` (8 node-flag cases); Go's
deterministic union order (`exhaustiveCaseCompletions8`, `quickinfoVerbosity2`,
`quickinfoVerbosityTuple`, `quickInfoCanBeTruncated` in part); Go reports TS6198 for an unused
array pattern (`codeFixUnusedIdentifier_parameter_all`); Go's index symbol takes the single
applicable index info (`jsDocPropertyDescription11`); duplicate object-literal members stay
separate symbols (`quickInfoTypeError`); a TS function expando gives no namespace meaning
(`quickinfoVerbosityFunction`, `quickinfoVerbosityJs`); Go's builder reuses fewer source nodes
and comments (`codeFixClassExtendAbstractMethodWithLongName`,
`codeFixClassImplementInterfaceComments`, `codeFixClassImplementInterfaceNoTruncation`,
`codeFixInferFromUsageNoTruncation`, `thisPredicateFunctionQuickInfo01`, `02`,
`quickInfoTemplateTag`, `quickinfoVerbosityLibType`). These counts cover the groups examined in
this batch, not every remaining failure.

Next by failing count (`r32`, 451 failing): code fixes not found (29) and quick info text (21)
are classified above; range text (12, 11 classified); undefined reads (12); the AwaitContext
flags (8, classified); `import foo` texts (7); fix-all ids of
`codeFixImportNonExportedMember_all*` (7); `checker.symbolIsValue` (6); bare debug failures
(6); no completions (6); rename failures (6); and `getRegionSemanticDiagnostics` regions, which
need a port of `checkSourceFileNodes`.

## Classifiable names and the current queue

Injected run: **7,260 of 7,853** (fourslash 5,749, services 1,511), none lost against `r25` or
`r16` (`r26`; 5.4 minutes, 4.3 GiB peak). `program.getClassifiableNames` is classic's set: the
escaped names of binder symbols declared with a classifiable meaning (class, enum, type alias,
interface, type parameter, module, alias), collected over each file's declaration nodes in the
bridge. The port dropped Go's `ClassifiableNames` as unused, so no `ts_goport` change.

The open items this batch listed (cancellation, custom transformers, hover verbosity) are
recorded in the section above.

## Symbol identity across checkers

Injected run: **7,247 of 7,853** (fourslash 5,736, services 1,511), none lost against `r24`
(`r25`). A binder lineage symbol (an id that is not a checker's own index) names one symbol in
every checker arena of the instance, as a classic binder symbol is one object for every program
holding its file: it is now one JavaScript object per instance (held weakly), and every checker
accepts it. Transient symbols stay private to their checker. A node a checker answers records
its file's program for `node.symbol`, so a signature declaration in another file has its
symbol; `getMergedSymbol(undefined)` is undefined, as classic's is for a script file.

This replaces the earlier deviation that a symbol of another program's checker is another object.

## Builder comments and the slow implement-interface cases

Injected run: **7,241 of 7,853** (fourslash 5,730, services 1,511), none lost against `r23`
(`r24`). Builder nodes carry the port builder's synthetic leading and trailing comments as
classic `emitNode` comments, so an elided union prints classic's `/*... N more elided ...*/`.

The two slow `codeFixClassImplementInterfaceNoTruncation*` cases spent 60 of their 71 seconds
in the fourslash harness's `highlightDifferenceBetweenStrings`, diffing the 1.3 MB expected and
actual texts after the comparison failed (CPU profile, `prof/nt`); the code fix took under a
second. With the elision comment the properties case passes and the other fails in 1.6 s on a
remaining difference (Go's builder keeps the alias in `baz`'s constraint where classic expands
it). The roster now takes 5.7 minutes with a 4.2 GiB peak (`r16`: 9.8 minutes, 5.9 GiB).

## Synthetic checker objects and program emit (unit 4 sixth batch, unit 5 start)

Injected run: **7,240 of 7,853** (fourslash 5,729, services 1,511), none lost against `r16`
or any run since (`r19` to `r23` in `/work/tmp/tsrust-ls-probes/u3/`). No `ts_goport` source
changed: each member below is bridge code over existing port checker functions.

- `getSymbolOfExpando`: classic's algorithm over classic's syntax utilities and the binder's
  symbols (`getMergedSymbol(decl.symbol)`).
- `getMemberOverrideModifierStatus` takes the member's syntax as facts computed with classic's
  utilities (effective modifiers for a parsed member, syntactic ones for a factory node), so
  code-fix members that the compiler never parsed work; the rest is Go's function.
- `createSymbol` returns a classic transient symbol that becomes a Rust transient symbol when it
  first reaches the checker, with the `links.type` and `flags` it has then, and keeps its object
  identity. `createSignature`, `createAnonymousType` and `createIndexInfo` build port objects
  from issued handles.
- `isLibType` (Go `IsLibTypeForHoverVerbosity`, the same rule), `getExactOptionalProperties`
  and `getIndexInfosAtLocation` (classic's algorithms over port functions).
- `typeToTypeNode` of an undefined type answers as classic's builder does.
- Builder nodes with positions textChanges assigned answer `getChildren`, `getChildCount`,
  `getChildAt`, `getFirstToken` and `getLastToken` with classic's own `NodeObject` methods
  (`createChildren` scanning the printed text).
- `program.emit` runs the Rust emitter for the target file or the program and replays its writes,
  in order, through the caller's `writeFile` (or the compiler host's) with classic's arguments;
  output names under a relative `outDir` or `declarationDir` keep classic's relative form.

Deviations: a created symbol's type and flags are read once, when the checker first receives it;
`writeFile` gets the one source file the port records per output, and `{ diagnostics: [] }` as
its data; custom transformers are refused with an error (they transform classic syntax trees,
which the Rust emitter never builds), so `getEmitOutput` with transformers fails; the
cancellation token passed to `emit` is not polled.

Classified, not changed (TypeScript-Go semantics): no `outFile` concatenation and no AMD
output (12 emit cases); constructor functions get no `this`/`prototype` members, so
`convertFunctionToEs6Class` finds nothing to convert (22 cases).

Not done: classic's cancellation polls sit in the node builder and checker functions
(`typeToTypeNodeWorker`, `checkSourceElement`); matching the counts the services cancellation
unit asserts needs poll sites in `ts_goport` (5 cases). Hover verbosity needs the builder's
verbosity level and `getEmitResolver().symbolToDeclarations` (11 cases).

Next by failing count (`r23`): code fixes not found (29), assertion `true` (29), quick info
text (28), range text (14), completions not found (13), node kind mismatches (13),
`getClassifiableNames` (12), `getSymbolWalker` (11), `getEmitResolver` (11).

## Builder output, signatures and JSDoc nodes (unit 4, fifth batch)

Injected run: **7,023 of 7,853** (fourslash 5,530, services 1,493), none lost against `r16` or
`r17` (`r17`, `r18` in `/work/tmp/tsrust-ls-probes/u3/`, compare with `ldiff.sh`).

- Builder nodes carry the port builder's emit flags (`SingleLine` type literals and tuples,
  `NoAsciiEscaping`), translated by name, and classic `singleQuote`: a literal the builder makes
  takes its chosen quote; a reused source literal is single-quoted only under
  `UseSingleQuotesForStringLiteralType`, as classic's clone is.
- Builder nodes get the parenthesization classic's factory constructors apply (array and
  indexed-access element types, union and intersection members, optional, tuple, conditional,
  type operator, type arguments, access expressions, computed names); their `forEachChild` is
  classic's, so it sees the same children. Reparsed nodes the builder reuses (JSDoc types in
  JS) are kept as children.
- `symbolToTypeParameterDeclarations` follows classic: class, interface and type alias targets
  give their local type parameters (an empty array when none), other symbols undefined. Go
  tests `Alias` where classic tests `TypeAlias` and also takes functions.
- Field names: `TypeParameterDeclaration.default`, `ImportTypeNode.isTypeOf`,
  `JSDocSeeTag.name`, `class` of `@augments`/`@implements`, `JSDocTypeLiteral.jsDocPropertyTags`
  (every tag; the native field answers only the first), typedef and callback `fullName` and
  `name`, `SyntaxList._children`. A JSDoc comment starts at its `/**`; an empty comment is
  undefined; typedef children follow classic's visiting order; a lone `{?}` (Go: nullable over
  a missing reference) is `JSDocUnknownType`.
- Signatures have classic `flags` (the port's `Construct` bit read as classic `Abstract`);
  `signatureToString` takes its flags and kind; type parameters answer classic's `constraint`.
- Source files: `checkJsDirective` from the pragmas, `commonJsModuleIndicator` from the Rust
  binder, and node `transformFlags` with classic's `ContainsJsx` (the only bit services read).
- A `@param` tag name answers the parameter symbol, as classic's checker does.

Deviations: `transformFlags` holds only `ContainsJsx`; a type parameter's `constraint` is the
resolved constraint at any time (classic's field is unset before resolution and holds
`noConstraintType` for an unconstrained parameter).

Classified, not changed (the port follows TypeScript-Go at its pin): no `@enum` tag, no
closure-style `function(...)` JSDoc types or JS constructor functions; an untyped `@typedef` is
not an alias; a hyphenated `@property` name reparses to a string-literal name, so hovering it
finds no symbol; Go's builder builds predicate and qualified-chain types fresh where classic
reuses the source node (`this is (A & B)` prints without parentheses); which duplicate
object-literal member a name resolves to.

Remaining in the two groups (`s1i`): 8 range-text and 29 quick-info cases, of which the index
signature display needs `getIndexInfosAtLocation` (item 8), truncation needs the builder's
maximum length, and the rest are the classified port semantics above plus copied comments on
builder output (`codeFixClassImplementInterfaceComments`), mapped-type key remapping and
JSDoc closure types.

Next by failing count (`r18`): `getSymbolOfExpando` (47), unbacked nodes (42), `program.emit`
(36), types of another checker (36), `createSymbol` (31), quick info text (29), builder-node
`getChildren` (21), `getIndexInfosAtLocation` (20), `createSignature` (19),
`getExactOptionalProperties` (15), range text (12), `isLibType` (12),
`getClassifiableNames` (12), `getSymbolWalker` (11).

## Options, pragmas and parameter info (unit 4, fourth batch)

Injected run: **6,793 of 7,853** (fourslash 5,305, services 1,488), none lost against the
previous batch (`r15`, `r16` in `/work/tmp/tsrust-ls-probes/u3/`, WASM e15765c821633ceb).

- Classic's internal `allowNonTsExtensions` reaches the Rust program (the tsconfig converter
  does not declare it), so the fourslash harness's `.js` roots without `allowJs` load.
- Source files have classic `pragmas` (a Map by lowercase name, an array for a repeated name,
  `{ arguments, range }` with classic's captured spans for `reference` `types`, `lib` and
  `path`); checked name for name against 6.0.3.
- Symbols of kinds that classic's binder always gives tables (class, enum, module and variable
  `exports`; class, interface, type literal and object literal `members`) have an empty table
  where the port's binder made none.
- `getParameterIdentifierInfoAtPosition` (the `classic_parameters` module, previously in the
  tree but not compiled); `getModuleResolutionCache` is undefined (the Rust resolver keeps its
  own cache).

Deviations: classic answers no parameter info for a JSDoc function type's signature; the port
has no JSDoc function type nodes, so that case is not distinguished. A pragma's
`hasTrailingNewLine` is whether a line break directly follows the comment.

Cost: two fourslash cases (`codeFixClassImplementInterfaceNoTruncation*`, whose expected text is
1.3 MB) now run the implement-interface fix to the end and take 76 s and 189 s with a 5.8 GiB
peak; the roster takes about 10 minutes. They still fail on the produced text.

Next by failing count (`r16`): range text (63), quick info text (58), `getSymbolOfExpando` (46),
unbacked nodes (42, synthesized members passed to `getMemberOverrideModifierStatus`), `program.emit`
(36, unit 5), types of another checker (36), `createSymbol` (31), code fixes not found (30),
`getIndexInfosAtLocation` (28), `getChildren` of builder nodes (21, needs a port of classic
`createChildren` over assigned positions), `createSignature` (19). `getSymbolOfExpando`,
`getIndexInfosAtLocation`, `getExactOptionalProperties` and `isLibType` have no Rust
counterpart yet, so they need `ts_goport` additions with the independent review AGENTS.md
requires.

## Symbols, nodes and formatting objects (unit 4, third batch)

Injected run: **6,546 of 7,853** (fourslash 5,058, services 1,488), none lost against the
previous batch (`r10` to `r14` in `/work/tmp/tsrust-ls-probes/u3/`, WASM 82d1925a6e2a6381, peak
RSS 2.8 GiB).

- Parsed nodes answer `symbol` and `localSymbol` with the binder's symbols, interned by the
  checker of the program that last returned the node's file. Tokens that `getChildren` makes
  reach the checker as the file's token cache entries (Go `GetOrCreateToken`).
- Source files have `identifiers` (Go's collected names) and `getNamedDeclarations` (ported).
- Symbols have classic `members` and `exports` tables (Maps by escaped name, read once) and,
  for transient symbols, `links` with classic `checkFlags` (translated by name) and `target`.
- Node position methods (`getStart`, `getEnd`, `getText`, ...) are classic NodeObject's over the
  node's own `pos` and `end`; an object derived with `Object.create(node)` gets its own
  properties, so textChanges' position-assigned copies format correctly.
- Program: `getFileIncludeReasons` (classic kinds) and `getModeForResolutionAtIndex`.
- Checker: module export walks, export symbols, destructuring members, symbol suggestions,
  predicates, accessibility chains, contextual types, constant values, literal types, and the
  rest listed in the commits of this batch.

Deviations: a symbol's binder identity is per checker (a symbol from another program's checker is
another object; replaced by "Symbol identity across checkers"); `identifiers` holds every literal text as Go collects them (classic interns only
property-name literals); `links` carries only `checkFlags` and `target`.

Next by failing count (`r14`): per-case undefined reads (117), `getModuleResolutionCache` (104),
`Could not find source file` (75), quick info text (51), range text (48), unbacked nodes (42),
`program.emit` (36, unit 5), types of another checker (36), `createSymbol`,
`getIndexInfosAtLocation`, `getSymbolOfExpando`, `getParameterIdentifierInfoAtPosition`.

## Node builder, display parts and program host members (unit 4, second batch)

Injected run: **3,685 of 7,853** (fourslash 2,460, services 1,225), none lost against the
previous batch (`r9` in `/work/tmp/tsrust-ls-probes/u3/`, WASM f32d1cd33302f227, peak RSS
2.5 GiB).

- Rust's node builder answers classic `typeToTypeNode`, `typeParameterToDeclaration`,
  `symbolToEntityName`, `symbolToExpression`, `symbolToNode`, `symbolToParameterDeclaration`,
  `symbolToTypeParameterDeclarations`, `signatureToSignatureDeclaration` and
  `indexInfoToIndexSignatureDeclaration`. Its nodes cross as binary AST data
  (`encode_node`) and decode as classic synthesized nodes: positions -1, no parent,
  `NodeFlags.Synthesized`, and each identifier's `symbol` the builder recorded. `writeSymbol`,
  `writeType` and `writeSignature` are classic's `symbolToString`, `typeToString` and
  `signatureToString` with a writer: the builder's node printed by the classic printer, so
  display parts carry classic kinds.
- Symbols and signatures have classic's documentation members (`getDocumentationComment`,
  `getContextualDocumentationComment`, `getJsDocTags`, `getContextualJsDocTags`), ported from
  `services.ts` into `classic-symbol-docs.js` over the classic JSDoc utilities.
- Checker members: `isImplementationOfOverload`, `isValidPropertyAccess`,
  `isValidPropertyAccessForCompletions`, `isPropertyAccessible`, `getJsxNamespace`,
  `getTypeArgumentConstraint`, `getExportSpecifierLocalTargetSymbol`,
  `getSuggestedSymbolForNonexistentProperty`, `getCandidateSignaturesForStringLiteralCompletions`,
  `getExportsAndPropertiesOfModule`, `resolveExternalModuleSymbol`, `getParameterType`,
  `getPromiseType`, `createPromiseType`, `getIndexType`, `getUnionType`, `isTypeAssignableTo`,
  `getDiagnostics`, `getGlobalDiagnostics`; node arguments go through classic's
  `getParseTreeNode` with its node tests and defaults.
- Program members from the compiler host and program-wide facts: see the commit "Add classic
  program host members"; `getMissingFilePaths` leaves out files with extensions classic never
  looks for, so `isProgramUptoDate` holds.

Deviations: the node builder takes no symbol tracker, maximum length or verbosity level
(`typeToTypeNode`'s `tracker`, hover verbosity); `symbolToTypeParameterDeclarations` is
undefined when there are none; `getSuggestedSymbolForNonexistentProperty` takes a name node, not
a string; `runWithCancellationToken` and `getDiagnostics` do not poll the token.

Next by failing count (`r9`): `Cannot read properties of undefined` (1,085, per case), symbols
of another checker (556), unbacked nodes (498), `position cannot precede the beginning of the
file` (222), `getExpandedParameters`, `getTypePredicateOfSignature`, `isDeclarationVisible`,
`getJsxFragmentFactory`, `getAccessibleSymbolChain`, `isTypeInvalidDueToUnionDiscriminant`.

## Checker members (unit 4, first batch)

Injected run: **2,773 of 7,853** (fourslash 1,792, services 981), none lost against the
previous batch (`r5` in `/work/tmp/tsrust-ls-probes/u3/`, WASM 158de632aace2541).

Added in Rust's checker bridge with classic arguments and answers: `isUnknownSymbol`,
`isUndefinedSymbol`, `isArgumentsSymbol` (false for a symbol of another checker),
`getSymbolsInScope` (`[]` for a missing location), `getAmbientModules` (one array per checker),
`tryGetThisTypeAt` (with `includeGlobalThis` and `container`), `resolveName` (with classic's
`isUse` false, so no symbol is marked referenced), `getResolvedSignatureForSignatureHelp` (fills
`candidatesOutArray`), `containsArgumentsReference`, `getPromisedTypeOfPromise`,
`createArrayType`, `getElementTypeOfArrayType`, `getIndexInfoOfType` and `getIndexInfosOfType`
(classic `IndexInfo` records, one object per index info) and `getUnmatchedProperties`. Symbol
`meaning` flags translate from classic bits by name. `tryGetThisTypeAt` uses the port's exported
form, which maps JSDoc nodes to their reparsed nodes.

Deviation: `getUnmatchedProperties` returns an iterator over an eager list; classic's generator
computes lazily.

Next by failing count (`r5`): `runWithCancellationToken` (840, unit 5's cancellation),
`program.useCaseSensitiveFileNames` (576), symbols another checker owns (512, per-case),
`isValidPropertyAccessForCompletions`, `typeToTypeNode`, `getUnionType`, `getDiagnostics`,
`createPromiseType`, `isDeclarationVisible`, `isImplementationOfOverload`.

## Program members and host libraries (unit 3, first batch)

Injected upstream run after this batch: **2,506 of 7,853** (fourslash 1,525, services 981),
no case lost against the 2,453 baseline by name (runs `r1` to `r4` in
`/work/tmp/tsrust-ls-probes/u3/`, `r4-passes.txt`, WASM sha256 prefix 7768ee814edb3f70).
The 538 server-project services units now pass the harness's program-structure check against a
classic program and stop at `getAmbientModules` (unit 4).

- Library files come from the host, as classic: `createProgram` passes classic
  `defaultLibraryPath` (`getDefaultLibLocation()` or the directory of
  `getDefaultLibFileName(options)`), and the compiler host supplies its files through the
  document registry like any other file. Bundled libraries serve only hosts without it (the
  private host bridge).
- A file the host parses during a build keeps the program's canonical path (the registry parse
  runs under `withRequestedPath`), so `isSourceFileDefaultLibrary` and path lookups hold on
  case-insensitive hosts.
- `resolvedModules`, `resolvedTypeReferenceDirectiveNames`, `resolvedLibReferences`,
  `getAutomaticTypeDirectiveResolutions`, `getAutomaticTypeDirectiveNames`, `getResolvedModule`,
  `getResolvedModuleFromModuleSpecifier`, `getResolvedTypeReferenceDirective`,
  `forEachResolvedModule` and `forEachResolvedTypeReferenceDirective` read Rust's resolutions
  once per program (`getResolutions`) into classic `ModeAwareCache`s (`classic-resolutions.js`, a
  port of `createModeAwareCache`); a resolution shared by several names is one object.
- `SourceFile.hasNoDefaultLib` is false, as TypeScript 6.0.3's parser sets it; checker symbols
  have classic `name` (`symbolName`); the checker answers a missing node as classic's
  `getParseTreeNode` does for the symbol, signature and optional-parameter queries; the decoder
  maps the native unknown JSDoc tag to classic `JSDocTag`.

Deviations:

- An unset `target` builds with classic 6.0.3's computed default, ES2025 (LatestStandard); the
  port's own default is ES2026. Classic's other defaults follow from the target as in the port.
- The default library is the port's name for the target in the host's library directory; a
  host whose `getDefaultLibFileName` names another file gets the port's name.
- Classic resolution responses omit `failedLookupLocations`, `affectingLocations` and
  `resolutionDiagnostics`. Native module/type-reference results already retain diagnostics;
  the wrapper drops them. Native state still lacks the two ordered lookup arrays. Library resolution order puts `lib`
  entries first and the rest in program file order, where classic records discovery order.
  Automatic type directives follow `types` order, then name.
- Server units now hold about 5.4 GiB RSS at their peak in the roster (2.8 before): libraries are
  bound per program rather than read from the prebuilt blobs.

## Upstream baseline and next work (units 3 and 4)

First complete injected run of the unchanged upstream suites against the candidate
(`classic.js`, head after "Release programs whose service holds them", WASM sha256 prefix
782080b622cc4c56, runner `/work/tmp/tsrust-ls-probes/u2/run-classic-candidate-v2.cjs` with the
json-stream reporter, via `watch-run.sh`): **2,453 of 7,853** pass (fourslash 1,472 of 6,322;
services units 981 of 1,531), against the reference's 7,853. Two runs on the same source match
name for name (`full5-passes.txt`, `full6-passes.txt` in that directory). The roster takes about
three minutes; memory stays flat (RSS about 2.8 GiB, WASM memory 463 MiB) with ordinary GC.
The runner routes the pinned test bundle's `createLanguageService`, `createDocumentRegistry`,
`createDocumentRegistryInternal` (the server `ProjectService` registry, with its external
cache) and `OperationCanceledException` to the candidate, each seam asserted to occur once;
its counters for the last run were 6,874 services, 6,332 registries and 538 internal registries.
With the internal-registry seam the result is the same 2,453 by name (`full7-passes.txt`); the
538 server-project units that had received classic-parser files now reach the candidate.

Largest failure groups, the queue for units 3 and 4 (counts are failing tests by first error):

| Count | First error | Owner |
| --- | --- | --- |
| 538 | `program.getAutomaticTypeDirectiveResolutions` | Program members (unit 3); all server-project services units |
| 490 | `Cannot read properties of undefined` | per-case diagnosis |
| 461, 145 | `isUnknownSymbol`, `isUndefinedSymbol` | checker identity members |
| 426 | `getSymbolsInScope` | completions family |
| 327, 86 | `getAmbientModules` | completions and imports |
| 163 | `tryGetThisTypeAt` | completions |
| 149 | `resolveName` | checker |
| 136 | `runWithCancellationToken` | cancellation (unit 5) |
| 135 | Node is not backed by this compiler | synthetic or foreign nodes passed to the checker |
| 133 | `getResolvedSignatureForSignatureHelp` | signature help |
| 126 | `name must be a string` | per-case diagnosis |
| 115, 108, 104, 94, 91, 54 | `getPromisedTypeOfPromise`, `typeToTypeNode`, `containsArgumentsReference`, `getDiagnostics`, `getIndexInfoOfType`, `createArrayType` | checker internals by family |
| 80 | `program.getResolvedModuleFromModuleSpecifier` | Program members (unit 3) |
| 71 | native AST kind `FirstJSDocTagNode` has no classic kind | decoder |
| 64, 63 | `Debug Failure` (token end, false expression) | per-case diagnosis |

## Classic dispatch on Rust (unit 2, second part)

`scripts/generate-classic-services.mjs` turns the published `typescript@6.0.3`
`lib/typescript.js` (checked by version, gitHead and recorded sha256) into
`classic-services.js`, a factory for the whole `ts` namespace. It redirects `createProgram`,
`createSourceFile`, `createLanguageServiceSourceFile`, `updateLanguageServiceSourceFile` and
`getSetExternalModuleIndicator` to the Rust-backed functions, and makes the classic parser,
incremental parser, binder, checker and emitter throw if reached. Each patched header must occur
exactly once. `createLanguageService`, the document registry, every service algorithm and the
utilities are the published code. `classic.js` loads the module, builds the namespace and
exports it; the generated file stays out of git like the WASM module.

Classic compiler hosts read the old program while a build asks them for files, so a host
callback may now send requests to other sessions; only a running session cannot be reentered,
and Rust borrows each session on its own.

Program members added for the dispatch: `getImpliedNodeFormatForEmit`,
`getEmitModuleFormatOfFile`, `getDefaultResolutionModeForFile` and `getModeForUsageLocation`
(Rust's answers, `None` as `undefined`), `getMissingFilePaths` (Rust's missing files),
`getSourceFileByPath`, `getProjectReferences` (from `createProgram`), `getResolvedProjectReferences`
and `resolvedLibReferences` (none yet). A bundled library's `version` is `undefined`, as a
classic host's version is for a file it does not own, so `isProgramUptoDate` holds.

Checks: `test/classic-dispatch.test.mjs` (skipped with its reason when the bundle is not
generated): semantic diagnostics through the unchanged dispatch with `file` identical to the
program's source file, program reuse while the host is unchanged, a version change, the old
source file kept, syntactic diagnostics and the navigation tree, and the guards. Injected
upstream run (`/work/tmp/tsrust-ls-probes/u2/run-classic-candidate-v2.cjs`, which also routes
`createDocumentRegistry` and `OperationCanceledException` to the candidate): navigation bar,
outlining and brace slice 73/77.

## Rust `createProgram` over a classic compiler host (unit 2, first part)

`createProgram(rootNames, options, host, oldProgram)` and its options-object form open a
documents session whose host callbacks go to the classic `CompilerHost`: `fileExists`,
`directoryExists`, `getDirectories`, `readDirectory`, `realpath`, `readFile`, and
`getSourceFileByPath` (or `getSourceFile`) for each non-bundled file, with
`shouldCreateNewSourceFile` when a source-file-affecting option changed. The returned objects
become the program's source files, with `fileName`, `path`, `resolvedPath` and
`originalFileName` set as `findSourceFile` sets them. After the build, `onReleaseOldSourceFile`
runs for the old program's files under classic's condition.

Options travel as tsconfig `compilerOptions`: `classic-compiler-options.js` names enum values
(`lib` entries too) from the declarations that `scripts/generate-classic-options.mjs` writes
from `typescript@6.0.3` into `classic-options.js`, and drops non-option fields
(`configFilePath`, `pathsBasePath`, `configFile`). Rust converts them with the tsconfig
converter (`configureProgram`) against the current directory and builds from the roots. 136 of
the 141 enum values build cleanly; ES3, module `None` and `importsNotUsedAsValues`, which the Go
pin removed, build with a TS6046 or TS5023 configuration diagnostic.

Checks: `test/classic-create-program.test.mjs` (option names; a compiler host shaped like
`synchronizeHostDataWorker`'s: registry documents become the program's files, diagnostics carry
them, an unchanged version keeps its file, an edit updates without release, a removed root
releases with classic's arguments, an old program's file keeps its text). 45/45 runtime tests,
controls as in unit 1.

Deviations: classic reports removed options with its own codes (for example TS5108 for ES3).
Bundled libraries are never offered to `onReleaseOldSourceFile`. `onError` is not passed to
the host. A missing host (classic's default `createCompilerHost`) is a `TypeError`, since
standalone `createProgram` is outside this contract.

## Shared instance and document registry (unit 1, done)

The instance holds any number of sessions. Each session keeps its own current directory, case
sensitivity, arguments and programs; the host file system is installed once, and each host
callback reaches the session whose request is running. Source leases and parsed documents belong
to the instance, so one parse has one lease and one `SourceFile` object wherever it appears.

`classic-registry.js` is the pinned `documentRegistry.ts` with its bookkeeping unchanged
(buckets, keys, script-kind maps, reference counts, `reportStats`, `getBuckets`, the internal
external cache). Its `createLanguageServiceSourceFile` and `updateLanguageServiceSourceFile` parse
in Rust (`parseDocument`), each call a new parse with its own lease. A program build asks its
compiler host for every non-bundled file (`GetSourceFile`); the host bridge then follows
`getOrCreateSourceFileByPath`: read the snapshot, update the old program's document or release it
on a script-kind change, otherwise acquire. A finished build releases the old program's documents
as `createProgram` does (all of them when a source-file-affecting option changed), a type-roots
change drops the old program without releases, and `dispose` releases the current program's
documents. The registry parse runs inside the build's host callback; only that nested call may
reenter the instance. The file-system async service keeps reading files (`documents: false`).

Checks: `test/classic-registry.test.mjs` (two services on one registry share source files, nodes
and checker answers; separate registries do not; edits, version races and root removal keep
classic reference counts; a wrapper serving another registry's cached file, as the fourslash
harness does; direct acquire, update, release and `Debug Failure` paths). 43/43 runtime tests,
16/17 prior controls (the 17th, `lifetime`, uses a snapshot without `getChangeRange`; TypeScript
6.0.3 throws the same `TypeError` there, and a conforming copy passes), async edit growth 6.9 MiB
over 500 edits (5.5 before), and 600 alternating classic edits plateau after 200.

Deviations:

- The plan said each registry owns an instance. The fourslash harness caches lib `SourceFile`
  objects across registries (`libSourceFileCache`), so all registries share one instance per
  compiled module instead. A trap ends that instance for every service and registry in it; the
  next call gets a new instance, and objects from the old one stop working (no adoption yet).
- Documents a Rust build asks for have no `impliedNodeFormat`, because the Rust loader computes
  file metadata after the parse, so their registry buckets carry no mode.
- `updateLanguageServiceSourceFile` parses the new text in full: the Rust parser has no
  incremental mode, so unchanged nodes are new objects.
- The Rust parser ignores `jsDocParsingMode`. A `setExternalModuleIndicator` callback that did not
  come from `getSetExternalModuleIndicator` or a build parses with the legacy rule and is not called.
- A relative file name parses at the root; the object keeps the classic name.
- `getImpliedNodeFormatForFile` with a host reads the nearest `package.json` `type` through the
  host, without the module-resolution cache.
- A file's `stat` size is 0, so existence checks read no snapshot.
- Released documents are freed when their `SourceFile` objects are collected, which needs the
  event loop to turn.
- Bundled libraries still bypass the registry.
- `createDocumentRegistry` is not yet a public package export: the public entry gets it with the
  classic factory, since both need the module ready at load.

Remaining units, in order. Each ends with its narrow checks and then the injected upstream run
(`run-classic-candidate.cjs`: the reference passes 6,322 fourslash and 1,531 services tests):

1. [x] Per-service host state in one instance; registry-backed documents; classic `createDocumentRegistry`
   (public export moves to unit 2 with the factory).
2. Classic dispatch bundle with guarded compiler entries and the Rust `createProgram` bridge.
   - [x] `createProgram` over a classic `CompilerHost` (`classic-create-program.js`), below.
   - [x] The guarded dispatch bundle and its Rust injection (`classic.js`, Node), below.
   - [ ] Public `createLanguageService` and `createDocumentRegistry` exports with the module
     ready at load in every supported runtime (unit 6 decides browser loading).
3. Classic `Program` members the dispatch reads (`getSourceFileByPath`, `getMissingFilePaths`,
   resolved modules and references, `structureIsReused`, emit). Done for the dispatch's
   resolution members and host libraries (above); `structureIsReused` and emit remain.
4. `TypeChecker` members and symbol/type internals each service family reads, by family.
   Started: the four batches above (6,793 of 7,853 after the fourth); the last batch's "Next"
   list orders the rest.
5. `getEmitOutput` through Rust emit, including custom transformers; cancellation tokens;
   host module and type-reference resolution; project references.
6. Node 22, Chromium and WebKit main-thread and worker runs; before/after timing and reads.

