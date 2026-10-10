import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "../node.js";
import { useCompiledModule } from "../classic-module.js";
import { createHostServiceChannel } from "../classic-host.js";
import { createProgramGraph } from "../classic-program.js";
import { createDocumentRegistry, createLanguageServiceSourceFile } from "../classic-registry.js";
import { ScriptSnapshot } from "../classic-utilities.js";

const settings = { noLib: true, strict: true };
const args = (_, names) => ["--noLib", "--strict"].concat(names);

function project(files) {
    const text = new Map(Object.entries(files));
    const versions = new Map(Array.from(text.keys(), path => [path, "1"]));
    const snapshots = [];
    let roots = ["/a.ts"];
    const host = {
        getCompilationSettings: () => settings,
        getScriptFileNames: () => roots,
        getScriptVersion: path => versions.get(path) ?? "1",
        getScriptSnapshot(path) {
            if (!text.has(path)) return undefined;
            const snapshot = ScriptSnapshot.fromString(text.get(path));
            snapshots.push(snapshot);
            return snapshot;
        },
        getCurrentDirectory: () => "/",
        getDefaultLibFileName: () => "/lib.d.ts",
        useCaseSensitiveFileNames: () => true,
        readFile: path => text.get(path),
        fileExists: path => text.has(path),
    };
    return { host, text, versions, snapshots, setRoots: value => roots = value };
}

function edit(target, path, contents) {
    target.text.set(path, contents);
    target.versions.set(path, String(Number(target.versions.get(path)) + 1));
}

const files = { "/a.ts": 'import { value } from "./b"; export const result: number = value;', "/b.ts": "export const value = 1;" };

function programOf(service) {
    return createProgramGraph(service, service.getProgram(), settings);
}

function refCounts(registry) {
    const counts = {};
    for (const bucket of registry.getBuckets().values()) {
        for (const [path, entry] of bucket) counts[path] = entry.languageServiceRefCount;
    }
    return counts;
}

function diagnosticCodes(service) {
    return service.request("textDocument/diagnostic", { textDocument: { uri: "file:///a.ts" } }).items.map(item => item.code);
}

test("services sharing a registry share one instance, their source files and their nodes", async () => {
    const module = await loadModule();
    useCompiledModule(module);
    const registry = createDocumentRegistry(true, "/");
    const first = project(files);
    const second = project(files);
    const one = createHostServiceChannel(module, first.host, args, registry);
    const two = createHostServiceChannel(module, second.host, args, registry);
    try {
        assert.equal(one.instance, two.instance);
        const programOne = programOf(one);
        const programTwo = programOf(two);
        const fileOne = programOne.getSourceFile("/b.ts");
        assert.equal(programTwo.getSourceFile("/b.ts"), fileOne);
        assert.equal(programTwo.getSourceFile("/a.ts"), programOne.getSourceFile("/a.ts"));
        assert.equal(programTwo.getSourceFile("/b.ts").statements[0], fileOne.statements[0]);
        assert.equal(fileOne.version, "1");
        assert.equal(fileOne.path, "/b.ts");
        assert.equal(fileOne.resolvedPath, "/b.ts");
        assert.ok(fileOne.scriptSnapshot);
        assert.deepEqual(refCounts(registry), { "/a.ts": 2, "/b.ts": 2 });
        const declaration = fileOne.statements[0].declarationList.declarations[0];
        const symbol = programTwo.getTypeChecker().getSymbolAtLocation(declaration.name);
        assert.equal(symbol.getDeclarations()[0], declaration, "the other service's checker answers with the shared node");
        assert.deepEqual(diagnosticCodes(one), []);
        assert.deepEqual(diagnosticCodes(two), []);
    } finally {
        one.dispose();
        two.dispose();
    }
    assert.deepEqual(refCounts(registry), {});
});

test("separate registries keep separate source files in the shared instance", async () => {
    const module = await loadModule();
    useCompiledModule(module);
    const one = createHostServiceChannel(module, project(files).host, args, createDocumentRegistry(true, "/"));
    const two = createHostServiceChannel(module, project(files).host, args);
    try {
        assert.equal(one.instance, two.instance);
        assert.notEqual(programOf(one).getSourceFile("/b.ts"), programOf(two).getSourceFile("/b.ts"));
    } finally {
        one.dispose();
        two.dispose();
    }
});

test("an edit in one service updates the shared entry and the other service follows its own host", async () => {
    const module = await loadModule();
    useCompiledModule(module);
    const registry = createDocumentRegistry(true, "/");
    const first = project(files);
    const second = project(files);
    const one = createHostServiceChannel(module, first.host, args, registry);
    const two = createHostServiceChannel(module, second.host, args, registry);
    try {
        const shared = programOf(one).getSourceFile("/b.ts");
        assert.equal(programOf(two).getSourceFile("/b.ts"), shared);
        edit(first, "/b.ts", 'export const value = "edited";');
        assert.deepEqual(diagnosticCodes(one), [2322]);
        const edited = programOf(one).getSourceFile("/b.ts");
        assert.notEqual(edited, shared);
        assert.equal(edited.version, "2");
        assert.deepEqual(refCounts(registry), { "/a.ts": 2, "/b.ts": 2 });
        // The second host still says version 1, so the registry entry goes back to it, as in TypeScript.
        second.versions.set("/a.ts", "2");
        assert.deepEqual(diagnosticCodes(two), []);
        assert.equal(programOf(two).getSourceFile("/b.ts").version, "1");
        first.setRoots(["/b.ts"]);
        first.versions.set("/b.ts", "3");
        programOf(one);
        assert.deepEqual(refCounts(registry), { "/a.ts": 1, "/b.ts": 2 });
    } finally {
        one.dispose();
        two.dispose();
    }
    assert.deepEqual(refCounts(registry), {});
});

test("a registry wrapper can serve a source file another registry parsed, as the fourslash harness does", async () => {
    const module = await loadModule();
    useCompiledModule(module);
    const parsed = createDocumentRegistry(true, "/");
    const cached = parsed.acquireDocument("/b.ts", settings, ScriptSnapshot.fromString(files["/b.ts"]), "1");
    const local = createDocumentRegistry(true, "/");
    const wrapper = Object.assign({}, local, {
        acquireDocumentWithKey: (fileName, ...rest) => fileName === "/b.ts" ? cached : local.acquireDocumentWithKey(fileName, ...rest),
        updateDocumentWithKey: (fileName, ...rest) => fileName === "/b.ts" ? cached : local.updateDocumentWithKey(fileName, ...rest),
        releaseDocumentWithKey(path, ...rest) {
            if (path !== "/b.ts") local.releaseDocumentWithKey(path, ...rest);
        },
    });
    const service = createHostServiceChannel(module, project(files).host, args, wrapper);
    try {
        const program = programOf(service);
        assert.equal(program.getSourceFile("/b.ts"), cached);
        assert.deepEqual(diagnosticCodes(service), []);
        const declaration = cached.statements[0].declarationList.declarations[0];
        assert.equal(program.getTypeChecker().getSymbolAtLocation(declaration.name).getDeclarations()[0], declaration);
    } finally { service.dispose(); }
});

test("registry documents follow classic acquire, update and release", async () => {
    useCompiledModule(await loadModule());
    const registry = createDocumentRegistry(false, "/root");
    const snapshot = ScriptSnapshot.fromString("export const a = 1;");
    const file = registry.acquireDocument("Src/A.ts", settings, snapshot, "1");
    assert.equal(file.text, "export const a = 1;");
    assert.equal(file.fileName, "Src/A.ts");
    assert.equal(file.version, "1");
    assert.equal(file.scriptSnapshot, snapshot);
    assert.equal(file.statements.length, 1);
    assert.equal(registry.acquireDocument("Src/A.ts", settings, ScriptSnapshot.fromString("ignored"), "1"), file, "an unchanged version keeps the parse");
    const key = registry.getKeyForCompilationSettings(settings);
    assert.deepEqual(Array.from(registry.getBuckets().keys()), [key]);
    assert.deepEqual(Array.from(registry.getBuckets().get(key).keys()), ["/root/src/a.ts"]);
    let disposed = false;
    snapshot.dispose = () => disposed = true;
    const next = ScriptSnapshot.fromString("export const a = 1, b = 2;");
    next.getChangeRange = () => ({ span: { start: 18, length: 0 }, newLength: 7 });
    const updated = registry.updateDocument("Src/A.ts", settings, next, "2");
    assert.notEqual(updated, file);
    assert.equal(updated.text, "export const a = 1, b = 2;");
    assert.equal(updated.version, "2");
    assert.ok(disposed, "an incremental update disposes the old snapshot");
    assert.equal(file.scriptSnapshot, undefined);
    registry.releaseDocument("Src/A.ts", settings);
    assert.match(registry.reportStats(), /\[\]/);
    registry.releaseDocument("Src/A.ts", settings);
    assert.equal(registry.getBuckets().get(key).size, 0);
    assert.throws(() => registry.releaseDocument("Src/A.ts", { target: 1 }), /Debug Failure/);
    const json = createLanguageServiceSourceFile("/x.json", ScriptSnapshot.fromString('{"a": 1}'), 1, "1");
    assert.equal(json.languageVersion, 2);
    assert.equal(json.scriptKind, 6);
});
