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
A root with a snapshot exists even when `fileExists` denies it, so an import of such a root
resolves. A rebuild resolves every import again, while the reference reuses resolutions of
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

A `DocumentRegistry` owns one WASM instance, and every service created with that registry lives
in it. A shared registry therefore shares Rust parses, so `SourceFile` and node identity hold
across services. The runtime currently allows one service per instance (`Service::new` rejects a
second OS override), so the host override must become per-service state first.

Remaining units, in order. Each ends with its narrow checks and then the injected upstream run
(`run-classic-candidate.cjs`: the reference passes 6,322 fourslash and 1,531 services tests):

1. Per-service host state in one instance; registry-owned instances; public `createDocumentRegistry`.
2. Classic dispatch bundle with guarded compiler entries and the Rust `createProgram` bridge.
3. Classic `Program` members the dispatch reads (`getSourceFileByPath`, `getMissingFilePaths`,
   resolved modules and references, `structureIsReused`, emit).
4. `TypeChecker` members and symbol/type internals each service family reads, by family.
5. `getEmitOutput` through Rust emit, including custom transformers; cancellation tokens;
   host module and type-reference resolution; project references.
6. Node 22, Chromium and WebKit main-thread and worker runs; before/after timing and reads.

