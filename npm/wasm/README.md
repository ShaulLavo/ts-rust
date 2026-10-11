# ts-rust-wasm

The ts-rust TypeScript compiler (`crates/ts_goport`, a Rust port of typescript-go) as one
WebAssembly module. It type-checks and emits like the native `tsgo`, in Node, Deno, Bun and
browsers. Nothing here publishes.

## Build

```sh
rustup target add wasm32-wasip1
brew install binaryen          # or a binaryen 132+ release: wasm-opt
scripts/wasm/build.sh          # writes npm/wasm/ts_rust.wasm (needs Node)
cd npm/wasm && npm test
```

`WASM_PROFILE=release scripts/wasm/build.sh` builds faster and larger.

## Use

Node, on the real file system:

```sh
npx tsc-wasm -p tsconfig.json
```

```js
import { tsc } from "ts-rust-wasm";

const { exitCode, stdout } = await tsc(["-p", "tsconfig.json"]);
```

In memory (Node, browsers and Deno). `files` maps absolute paths to text. The result has every
file after the run, emitted ones included:

```js
import { tsc } from "ts-rust-wasm";

const { exitCode, diagnostics, files } = await tsc(["-p", "/app"], {
    files: {
        "/app/tsconfig.json": '{ "compilerOptions": { "strict": true, "outDir": "out" } }',
        "/app/index.ts": "export const n: number = 'one';",
    },
    diagnostics: "json",
});
// diagnostics: [{ fileName: "/app/index.ts", code: 2322, category: 1, text: "...", ... }]
// files.get("/app/out/index.js")
```

`diagnostics: "json"` returns the diagnostics as objects (the TypeScript API's
`DiagnosticResponse`, with UTF-16 positions) and does not print them. Without it, `stdout` has
tsc's usual text.

In a browser, call `tsc` from a module Web Worker, as `examples/browser` does, so that a run does not
block the page. It also works on the page's main thread. Type checking (`--noEmit`) of arithmetic
and comma chains with 5,000 operators, including unreachable code, is tested in Chromium and
WebKit on the main thread and in module workers. Emit and other deeply nested syntax still recurse
and can exhaust the stack. For example, emitting a 2,500-operator arithmetic chain overflowed
Node 26's main-thread stack in this build. Type checking 5,000-term logical or coalescing chains
such as `&&` and `??` can also exhaust Node's calling-thread stack.
Serve `ts_rust.wasm` as `application/wasm`, so that it compiles while it downloads.
To try the example, run `python3 -m http.server -d npm/wasm` and open
`http://localhost:8000/examples/browser/`.

`runTsc` (on the calling thread) and `runTscAsync` (a promise) from `ts-rust-wasm/core` take any
`HostFileSystem` and a compiled module, for hosts that keep files elsewhere.

## Editor language service

`createLanguageService` exposes the language service used by native `tsgo --lsp`, with an
in-memory project in its own WebAssembly instance. In browsers,
call it in a module Web Worker so requests do not block the page. The Node entry owns a persistent
worker with a 256 MB stack, configurable through `stackSizeMb`. The core entry runs on its caller's
thread. Bun uses that calling-thread path because its workers ignore the stack-size setting.

```js
import { createLanguageService } from "ts-rust-wasm";

const service = await createLanguageService({
    cwd: "/app",
    args: ["-p", "/app"],
    files: {
        "/app/tsconfig.json": '{ "compilerOptions": { "strict": true }, "files": ["index.ts"] }',
        "/app/index.ts": "export const answer = 42;",
    },
});
const hover = await service.request("textDocument/hover", {
    textDocument: { uri: "file:///app/index.ts" },
    position: { line: 0, character: 14 },
});
await service.updateFiles({ "/app/index.ts": 'export const answer = "forty-two";' });
await service.dispose();
```

Requests take LSP parameter objects and return LSP result objects. Document URIs are `file://`
URIs and positions count UTF-16 code units. Pass `capabilities` with the client's LSP capabilities
to select supported response shapes and the semantic-token legend. This is a callable language
service API; it does not start the native `--lsp` transport or its file watchers.

The Node entry accepts an explicit `wasm` source as a compiled module, bytes, a response or a URL,
including a file URL. File inputs accept structural readonly maps and records. Setup errors carry
TypeScript diagnostics in `error.data.diagnostics`. Request errors use JSON-RPC error codes.
Nonnegative character positions beyond a line's content clamp to its end, as LSP specifies.

Supported methods:

- `textDocument/hover`, `textDocument/completion`, `textDocument/signatureHelp`
- `textDocument/definition`, `textDocument/typeDefinition`, `textDocument/implementation`
- `textDocument/references`, `textDocument/rename`, `textDocument/documentHighlight`
- `textDocument/diagnostic`, `textDocument/documentSymbol`, `textDocument/codeAction`
- `textDocument/formatting`, `textDocument/rangeFormatting`
- `textDocument/semanticTokens/full`, `textDocument/semanticTokens/range`

`files` is copied on creation. `updateFiles` adds or replaces files; `deleteFiles` removes them.
Calls are serialized per service. The next request after a change rebuilds the program, including
its imports and configuration, while reusing unchanged parsed files through the native parse cache.
The old program is released after the replacement acquires those files; superseded parses are freed.
Repeated reads share the current program. Auto-import completions and completion/code-action item
resolution need additional host integration. Circular `extends` chains report configuration errors;
requests recover after the configuration is repaired.

See [examples/language-service/](examples/language-service/) for a browser-worker example.

## How it works

- `crates/ts_wasm` is the module: `tsc` and editor services from `ts_goport` for `wasm32-wasip1`.
  The default build with Rust 1.98.1 is 6.21 MB (2.60 MB gzip, 2.07 MB brotli), including the
  language service. The previous compiler-only module measured 4.2 MB (1.8 MB gzip, 1.5 MB
  brotli). The libs are in it as one
  LZMA stream (0.31 MB), and the diagnostic message texts are packed too.
  `scripts/wasm/order-functions.mjs` puts similar functions next to each other, so gzip and
  brotli find more matches. `scripts/wasm/build.sh` tells how to build a module that checks 13
  to 18% faster at 5.2 MB.
- The host (`core.js`) gives the file system through two imports (`ts_host.fs`, `fs_take`), and a
  small WASI shim gives clocks, random bytes, stdout and stderr. There is no WASI file system and
  no `node:wasi`.
- wasm has one thread. The checkers run their jobs on the calling thread
  (`program.rs` `send_thread_job`), as Go's `--singleThreaded` runs its work groups inline. Each
  checker keeps its own node and symbol ids, as a native checker thread does.
- Each run uses a new instance of the compiled module, because the compiler keeps one program per
  process. The module is compiled once. Memory goes back when a run ends.
- The checker recurses deeply, so very deep nesting can run out of stack. Node runs each call in a
  worker thread with a 256 MB stack. Bun ignores that
  setting, so under Bun a call runs on the calling thread. In a browser worker, `tsc` runs through
  JSPI where the engine has it, which gives about 2 times the stack in Chrome.
- `scripts/wasm/diff.mjs` compares the module with the native tsgo on Query core, Hono, the
  multiprog fixtures and more, and `scripts/wasm/corpus.mjs` on the TypeScript compiler test cases.
  Exit codes, output and emitted files are byte-identical.
- The native language service API is exposed through `createLanguageService` above.
- Not supported: `--watch`, `--pprofDir`, `--api`, diagnostics as JSON with `--build`, and
  plugins or content mappers that start processes. `--locale` gives English: the module has no
  message catalogs, to keep it small. With `--generateTrace`, a panic in the trace's type display
  ends the run (native recovers from it).
- `tsc -b` keeps the synthetic nodes of each built project until the run ends (native frees them
  when a project is done), so a very large build uses more memory.
