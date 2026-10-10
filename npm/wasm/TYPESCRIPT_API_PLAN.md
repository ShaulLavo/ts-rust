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

The synchronous stack gate fails on Node 22: classic TypeScript handles a 5,000-term addition
expression, while this Rust channel raises `RangeError: Maximum call stack size exceeded` in both
release and size profiles. Both handle the 100- and 1,000-term controls. The existing asynchronous
Node service's large-stack worker passes the 5,000-term case. The synchronous replacement needs
a verified stack solution before this gate can pass; a worker promise would change the contract.

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

## Upstream baseline and next work (units 3 and 4)

First complete injected run of the unchanged upstream suites against the candidate
(`classic.js`, head after "Release programs whose service holds them", WASM sha256 prefix
782080b622cc4c56, runner `/work/tmp/tsrust-ls-probes/u2/run-classic-candidate-v2.cjs` with the
json-stream reporter, via `watch-run.sh`): **2,453 of 7,853** pass (fourslash 1,472 of 6,322;
services units 981 of 1,531), against the reference's 7,853. Two runs on the same source match
name for name (`full5-passes.txt`, `full6-passes.txt` in that directory). The roster takes about
three minutes; memory stays flat (RSS about 2.8 GiB, WASM memory 463 MiB) with ordinary GC.

Largest failure groups, the queue for units 3 and 4 (counts are failing tests by first error):

| Count | First error | Owner |
| --- | --- | --- |
| 538 | compiler host returned a source file this compiler does not own | foreign `SourceFile` adoption (registry objects from classic `createSourceFile` callers, harness caches across a trap) |
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
   resolved modules and references, `structureIsReused`, emit). Started: the members above;
   the baseline table orders the rest.
4. `TypeChecker` members and symbol/type internals each service family reads, by family.
5. `getEmitOutput` through Rust emit, including custom transformers; cancellation tokens;
   host module and type-reference resolution; project references.
6. Node 22, Chromium and WebKit main-thread and worker runs; before/after timing and reads.

