import assert from "node:assert/strict";
import { test } from "node:test";
import { createLanguageService } from "../core.js";
import { loadModule } from "../node.js";

const document = { textDocument: { uri: "file:///p/a.ts" } };
const padding = `\n/*${"x".repeat(100_000)}*/`;
const root = extendsPath => JSON.stringify({ extends: extendsPath, compilerOptions: { types: [] }, files: ["a.ts"] }) + padding;
const base = extendsPath => JSON.stringify({ extends: extendsPath }) + padding;
const repaired = '{"compilerOptions":{"types":[]},"files":["a.ts"]}';

async function trackedService(files) {
    const module = await loadModule();
    const original = WebAssembly.instantiate;
    let memory;
    WebAssembly.instantiate = async (module, imports) => {
        const instance = await original(module, imports);
        memory = instance.exports.memory;
        return instance;
    };
    try {
        const service = await createLanguageService(module, { cwd: "/p", args: ["-p", "/p"], files });
        return { service, memory };
    } finally { WebAssembly.instantiate = original; }
}

function circularityError(error) {
    assert.equal(error.code, -32602);
    assert.deepEqual(error.data.diagnostics.map(diagnostic => diagnostic.code), [18000]);
    return true;
}

async function rejectCycle(service) {
    await assert.rejects(service.request("textDocument/diagnostic", document), circularityError);
}

async function verifyCycle(files, repairPath) {
    const { service, memory } = await trackedService({ "/p/a.ts": "export const value = 1;", ...files });
    try {
        for (let i = 0; i < 30; i++) await rejectCycle(service);
        const warm = memory.buffer.byteLength;
        for (let i = 0; i < 120; i++) await rejectCycle(service);
        assert.ok(memory.buffer.byteLength - warm < 2 * 1024 * 1024, "failed requests must retain bounded configuration memory");
        for (let i = 0; i < 120; i++) {
            await service.updateFiles({ "/p/a.ts": `export const value = ${i};` });
            await rejectCycle(service);
        }
        assert.ok(memory.buffer.byteLength - warm < 2 * 1024 * 1024, "edits with a cyclic configuration must retain bounded memory");
        await service.updateFiles({ [repairPath]: repaired });
        assert.deepEqual((await service.request("textDocument/diagnostic", document)).items, []);
        await service.updateFiles({ [repairPath]: files[repairPath] });
        await rejectCycle(service);
        await service.updateFiles({ [repairPath]: repaired });
        assert.deepEqual((await service.request("textDocument/diagnostic", document)).items, []);
    } finally { await service.dispose(); }
}

function malformedConfigError(error, cyclic) {
    const diagnostics = error.data.diagnostics;
    const expected = cyclic ? [1005, 1005, 1328, 1328, 5024] : [1005, 1328, 5024];
    assert.deepEqual(diagnostics.map(diagnostic => diagnostic.code).sort((a, b) => a - b), expected);
    return true;
}

test("a root self-cycle has bounded memory and recovers after repair", async () => {
    await verifyCycle({ "/p/tsconfig.json": root("./tsconfig.json") }, "/p/tsconfig.json");
});

test("an extended self-cycle has bounded memory and recovers after repair", async () => {
    await verifyCycle({ "/p/tsconfig.json": root("./base.json"), "/p/base.json": base("./base.json") }, "/p/base.json");
});

test("a mutual configuration cycle has bounded memory and recovers after repair", async () => {
    await verifyCycle({ "/p/tsconfig.json": root("./base.json"), "/p/base.json": base("./tsconfig.json") }, "/p/base.json");
});

test("a shared configuration ancestor is accepted and updates both branches", async () => {
    const service = await createLanguageService(await loadModule(), {
        cwd: "/p", args: ["-p", "/p"], files: {
            "/p/tsconfig.json": '{"extends":["./left.json","./right.json"],"files":["a.ts"]}',
            "/p/left.json": '{"extends":"./shared.json"}',
            "/p/right.json": '{"extends":"./shared.json"}',
            "/p/shared.json": '{"compilerOptions":{"strictNullChecks":false,"types":[]}}',
            "/p/a.ts": "export const value: number = null;",
        },
    });
    try {
        assert.deepEqual((await service.request("textDocument/diagnostic", document)).items, []);
        await service.updateFiles({ "/p/shared.json": '{"compilerOptions":{"strictNullChecks":true,"types":[]}}' });
        assert.deepEqual((await service.request("textDocument/diagnostic", document)).items.map(item => item.code), [2322]);
    } finally { await service.dispose(); }
});

test("a malformed cyclic root preserves the config parser's diagnostics", async () => {
    const service = await createLanguageService(await loadModule(), {
        cwd: "/p", args: ["-p", "/p"], files: {
            "/p/tsconfig.json": '{"extends":"./base.json","compilerOptions":{"strict":tru',
            "/p/base.json": '{"extends":"./tsconfig.json"}',
            "/p/a.ts": "export const value = 1;",
        },
    });
    try {
        await assert.rejects(service.request("textDocument/diagnostic", document), error => malformedConfigError(error, true));
        await assert.rejects(service.request("textDocument/diagnostic", document), error => malformedConfigError(error, true));
        await service.updateFiles({ "/p/base.json": "{}" });
        await assert.rejects(service.request("textDocument/diagnostic", document), error => malformedConfigError(error, false));
        await service.updateFiles({ "/p/tsconfig.json": repaired });
        assert.deepEqual((await service.request("textDocument/diagnostic", document)).items, []);
    } finally { await service.dispose(); }
});
