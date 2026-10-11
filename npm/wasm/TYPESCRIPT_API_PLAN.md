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
Rust-backed checker. The classic parser, binder, checker and emitter stay guarded and throw if
reached. Each classic service algorithm then works exactly as far as the Rust-backed program,
source-file, symbol, type and signature objects satisfy its dependencies. A dependency that
cannot be bridged moves its algorithm into Rust.

Every classic service and registry of a compiled module lives in one shared WASM instance
(`classic-instance.js`). A shared registry therefore shares Rust parses, so `SourceFile` and node
identity hold across services.

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

Next by failing count (`r34`, 371 failing): `getEditsForFileRename*` triple-slash edits (6),
`breakpointValidationDestructuring*` baselines (12 in four groups), "found 2 codefixes" (5),
JS export assignment errors in modules (4), and `getRegionSemanticDiagnostics` regions.

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
- Resolutions carry no `failedLookupLocations`, `affectingLocations` or
  `resolutionDiagnostics`: the port does not keep them. Library resolution order puts `lib`
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

