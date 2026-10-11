import assert from "node:assert/strict";
import { test } from "node:test";
import { createLanguageService as createCoreLanguageService } from "../core.js";
import { loadModule } from "../node.js";

const uri = path => `file://${path}`;

async function create(files, lib = ["es2022"]) {
    const module = await loadModule();
    return createCoreLanguageService(module, {
        cwd: "/p",
        args: ["-p", "/p"],
        files: {
            "/p/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", lib, types: [] }, include: ["*.ts"] }),
            ...files,
        },
    });
}

async function diagnostics(service, path) {
    const result = await service.request("textDocument/diagnostic", { textDocument: { uri: uri(path) } });
    return result.items.map(item => ({ code: item.code, line: item.range.start.line, character: item.range.start.character }));
}

test("an edit updates diagnostics and UTF-16 positions", async () => {
    const base = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
    const service = await create({ "/p/a.ts": base });
    try {
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
        await service.updateFiles({ "/p/a.ts": `// one\n// two\n${base.replace("b = 2", 'b: number = "2"')}` });
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), [{ code: 2322, line: 3, character: 13 }]);
        const hover = await service.request("textDocument/hover", { textDocument: { uri: uri("/p/a.ts") }, position: { line: 4, character: 13 } });
        assert.match(JSON.stringify(hover), /const c: 3/);
        await service.updateFiles({ "/p/a.ts": base });
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
    } finally {
        await service.dispose();
    }
});

test("an edit that adds an import rebuilds the program", async () => {
    const service = await create({
        "/p/a.ts": "export const a = 1;\n",
        "/p/c.ts": "export const c: string = 'c';\n",
    });
    try {
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
        await service.updateFiles({ "/p/a.ts": 'import { c } from "./c";\nexport const a: number = c;\n' });
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), [{ code: 2322, line: 1, character: 13 }]);
        await service.updateFiles({ "/p/c.ts": "export const c: number = 3;\n" });
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
    } finally {
        await service.dispose();
    }
});

test("a long edit session keeps the memory of one program", async () => {
    let text = 'export const element: HTMLElement | null = document.querySelector("div");\n';
    const service = await create({ "/p/a.ts": text }, ["es2022", "dom"]);
    try {
        for (let i = 0; i < 300; i++) {
            text += i % 40 === 39 ? "\n" : i % 40 === 0 ? "// " : "x";
            await service.updateFiles({ "/p/a.ts": text });
            assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
        }
    } finally {
        await service.dispose();
    }
});

test("a configuration warning does not stop the setup", async () => {
    const module = await loadModule();
    const service = await createCoreLanguageService(module, {
        cwd: "/p",
        args: ["-p", "/p"],
        files: {
            "/p/tsconfig.json": JSON.stringify({
                compilerOptions: { strict: true, types: [], plugins: [{ name: "@effect/language-service", diagnosticSeverity: { noSuchRule: "error" } }] },
                include: ["*.ts"],
            }),
            "/p/a.ts": 'export const a: number = "a";\n',
        },
    });
    try {
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), [{ code: 2322, line: 0, character: 13 }]);
    } finally {
        await service.dispose();
    }
});

test("unchanged large root, extended and reference configurations retain bounded memory", async () => {
    const original = WebAssembly.instantiate;
    let memory;
    WebAssembly.instantiate = async (module, imports) => {
        const instance = await original(module, imports);
        memory = instance.exports.memory;
        return instance;
    };
    let service;
    try {
        service = await create({
            "/p/a.ts": "export const value = 1;",
            "/p/tsconfig.json": JSON.stringify({ extends: "./base.json", include: ["*.ts"], references: [{ path: "./ref" }] }) + `\n/*${"x".repeat(100_000)}*/`,
            "/p/base.json": JSON.stringify({ compilerOptions: { strict: true, lib: ["es2022", "dom"], types: [] } }) + `\n/*${"y".repeat(100_000)}*/`,
            "/p/ref/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true, types: [] }, files: ["ref.ts"] }) + `\n/*${"z".repeat(100_000)}*/`,
            "/p/ref/ref.ts": "export const referenced = 1;",
        });
    } finally { WebAssembly.instantiate = original; }
    try {
        let warm;
        for (let i = 0; i < 300; i++) {
            await service.updateFiles({ "/p/a.ts": `export const value = 1; // ${i}` });
            assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
            if (i === 49) warm = memory.buffer.byteLength;
        }
        assert.ok(memory.buffer.byteLength - warm < 8 * 1024 * 1024);
    } finally { await service.dispose(); }
});

test("configuration changes rediscover roots and recover after errors", async () => {
    const service = await create({ "/p/a.ts": "export const a = 1;" });
    try {
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
        await service.updateFiles({ "/p/new.ts": 'export const value: number = "wrong";' });
        assert.deepEqual(await diagnostics(service, "/p/new.ts"), [{ code: 2322, line: 0, character: 13 }]);
        await service.updateFiles({ "/p/tsconfig.json": '{ "extends": "./base.json", "include": ["*.ts"] }', "/p/base.json": '{ "compilerOptions": { "strict": true, "types": [] } }' });
        assert.deepEqual(await diagnostics(service, "/p/new.ts"), [{ code: 2322, line: 0, character: 13 }]);
        await service.updateFiles({ "/p/base.json": '{ "compilerOptions": { "strict": tru' });
        await assert.rejects(diagnostics(service, "/p/new.ts"), error => Array.isArray(error.data?.diagnostics));
        await service.updateFiles({ "/p/tsconfig.json": '{ "compilerOptions": { "strict": true, "types": [] }, "files": ["a.ts"] }' });
        await assert.rejects(diagnostics(service, "/p/new.ts"), /document is not part of the program/);
        await service.updateFiles({ "/p/tsconfig.json": '{ "compilerOptions": { "strict": true, "types": [] }, "include": ["*.ts"] }' });
        assert.deepEqual(await diagnostics(service, "/p/new.ts"), [{ code: 2322, line: 0, character: 13 }]);
    } finally { await service.dispose(); }
});

test("a project configuration with a custom extension parses as JSON", async () => {
    const service = await createCoreLanguageService(await loadModule(), {
        cwd: "/p",
        args: ["-p", "/p/project.conf"],
        files: {
            "/p/project.conf": '{ "compilerOptions": { "strict": true, "types": [] }, "files": ["a.ts"] }',
            "/p/a.ts": 'export const value: number = "wrong";',
        },
    });
    try {
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), [{ code: 2322, line: 0, character: 13 }]);
        await service.updateFiles({ "/p/a.ts": "export const value: number = 1;" });
        assert.deepEqual(await diagnostics(service, "/p/a.ts"), []);
    } finally { await service.dispose(); }
});

test("configuration syntax diagnostics are reported once on static and freeable parses", async () => {
    const files = { "/p/tsconfig.json": '{ "compilerOptions": { "strict": true, "types": [] }, "files": ["a.ts"] }', "/p/a.ts": "export const value = 1;" };
    const service = await createCoreLanguageService(await loadModule(), { cwd: "/p", args: ["-p", "/p"], files });
    try {
        await diagnostics(service, "/p/a.ts");
        await service.updateFiles({ "/p/tsconfig.json": '{ "compilerOptions": { "strict": tru' });
        await assert.rejects(diagnostics(service, "/p/a.ts"), error => {
            const diagnostics = error.data?.diagnostics;
            const keys = diagnostics.map(d => `${d.code}:${d.pos}:${d.end}`);
            assert.equal(new Set(keys).size, keys.length);
            return true;
        });
    } finally { await service.dispose(); }
    const invalid = await createCoreLanguageService(await loadModule(), {
        cwd: "/p", args: ["-p", "/p"], files: { ...files, "/p/tsconfig.json": '{ "compilerOptions": { "strict": tru' },
    });
    try {
        await assert.rejects(diagnostics(invalid, "/p/a.ts"), error => {
            const diagnostics = error.data?.diagnostics;
            const keys = diagnostics.map(d => `${d.code}:${d.pos}:${d.end}`);
            assert.equal(new Set(keys).size, keys.length);
            return true;
        });
    } finally { await invalid.dispose(); }
});
