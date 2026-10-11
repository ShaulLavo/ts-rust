import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "../node.js";
import { useCompiledModule } from "../classic-module.js";
import { createProgram } from "../classic-create-program.js";
import { compilerOptionsToJson } from "../classic-compiler-options.js";
import { createDocumentRegistry } from "../classic-registry.js";
import { ScriptSnapshot } from "../classic-utilities.js";

/** A compiler host shaped like the one `synchronizeHostDataWorker` builds over a language-service host. */
function compilerHost(files, registry, settings, released) {
    const key = registry.getKeyForCompilationSettings(settings);
    let old;
    const host = {
        getSourceFileByPath(fileName, path, options, _onError, shouldCreateNewSourceFile) {
            const file = files.get(fileName);
            if (!file) return undefined;
            const previous = !shouldCreateNewSourceFile && old?.getSourceFile(fileName);
            const snapshot = ScriptSnapshot.fromString(file.text);
            return previous
                ? registry.updateDocumentWithKey(fileName, path, settings, key, snapshot, file.version, 3, options)
                : registry.acquireDocumentWithKey(fileName, path, settings, key, snapshot, file.version, 3, options);
        },
        getSourceFile: () => assert.fail("getSourceFileByPath is preferred"),
        getCurrentDirectory: () => "/",
        useCaseSensitiveFileNames: () => true,
        getCanonicalFileName: name => name,
        getNewLine: () => "\n",
        getDefaultLibFileName: () => "/lib.d.ts",
        writeFile() {},
        fileExists: path => files.has(path),
        readFile: path => files.get(path)?.text,
        onReleaseOldSourceFile(file, options, hasSourceFileByPath, newFile) {
            released.push({ fileName: file.fileName, hasSourceFileByPath, replaced: newFile !== undefined });
            registry.releaseDocumentWithKey(file.resolvedPath, registry.getKeyForCompilationSettings(options), file.scriptKind, file.impliedNodeFormat);
        },
    };
    return { host, setOld: program => old = program };
}

test("classic compiler options translate to their tsconfig names", () => {
    assert.deepEqual(compilerOptionsToJson({ target: 99, module: 199, moduleResolution: 100, lib: ["lib.es2022.d.ts"], strict: true,
        jsx: 4, paths: { "@/*": ["src/*"] }, configFilePath: "/tsconfig.json", pathsBasePath: "/" }),
    { target: "esnext", module: "nodenext", moduleResolution: "bundler", lib: ["es2022"], strict: true, jsx: "react-jsx", paths: { "@/*": ["src/*"] } });
});

test("createProgram builds in Rust from the host's registry documents", async () => {
    useCompiledModule(await loadModule());
    const files = new Map([
        ["/a.ts", { text: 'import { value } from "./b"; export const result: number = value;', version: "1" }],
        ["/b.ts", { text: "export const value = 1;", version: "1" }],
    ]);
    const settings = { noLib: true, strict: true, target: 99 };
    const registry = createDocumentRegistry(true, "/");
    const released = [];
    const { host, setOld } = compilerHost(files, registry, settings, released);
    const first = createProgram({ rootNames: ["/a.ts"], options: settings, host });
    assert.deepEqual(first.getRootFileNames(), ["/a.ts"]);
    const a = first.getSourceFile("/a.ts");
    const b = first.getSourceFile("/b.ts");
    assert.equal(b, registry.acquireDocument("/b.ts", settings, ScriptSnapshot.fromString("ignored"), "1"));
    registry.releaseDocument("/b.ts", settings);
    assert.equal(b.path, "/b.ts");
    assert.deepEqual(first.getSemanticDiagnostics(a), []);
    files.set("/b.ts", { text: 'export const value = "edited";', version: "2" });
    setOld(first);
    const second = createProgram(["/a.ts"], settings, host, first);
    const diagnostics = second.getSemanticDiagnostics(second.getSourceFile("/a.ts"));
    assert.deepEqual(diagnostics.map(diagnostic => diagnostic.code), [2322]);
    assert.equal(diagnostics[0].file, second.getSourceFile("/a.ts"));
    assert.equal(second.getSourceFile("/a.ts"), a, "an unchanged version keeps its source file");
    assert.notEqual(second.getSourceFile("/b.ts"), b);
    assert.deepEqual(released, [], "updated documents are not released");
    setOld(second);
    const third = createProgram(["/b.ts"], settings, host, second);
    assert.deepEqual(third.getRootFileNames(), ["/b.ts"]);
    assert.deepEqual(released, [{ fileName: "/a.ts", hasSourceFileByPath: false, replaced: false }]);
    assert.equal(b.text, "export const value = 1;", "an old program's source file keeps its text");
});

test("createProgram binds typed existence callbacks and treats an omitted directory callback as true", async () => {
    useCompiledModule(await loadModule());
    for (const hasDirectoryCallback of [false, true]) {
        const files = new Map([
            ["/a.ts", { text: 'import { value } from "./b"; export const result = value;', version: "1" }],
            ["/b.ts", { text: "export const value = 1;", version: "1" }],
        ]);
        const settings = { noLib: true, strict: true, target: 99 };
        const registry = createDocumentRegistry(true, "/");
        const { host } = compilerHost(files, registry, settings, []);
        const fileProbes = [];
        const directoryProbes = [];
        host.fileExists = function (path) {
            assert.equal(this, host);
            fileProbes.push(path);
            return files.has(path);
        };
        if (hasDirectoryCallback) {
            host.directoryExists = function (path) {
                assert.equal(this, host);
                directoryProbes.push(path);
                return path === "/";
            };
        }
        const program = createProgram(["/a.ts"], settings, host);
        assert.ok(program.getSourceFile("/b.ts"));
        assert.deepEqual(program.getSemanticDiagnostics(program.getSourceFile("/a.ts")), []);
        assert.ok(!fileProbes.includes("/"), "directory probes must bypass fileExists");
        assert.ok(!fileProbes.includes("/node_modules/@types"), "type-root directory probes must bypass fileExists");
        if (hasDirectoryCallback) assert.ok(directoryProbes.length > 0);
    }
});
