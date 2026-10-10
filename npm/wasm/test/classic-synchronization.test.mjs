import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "../node.js";
import { createHostServiceChannel } from "../classic-host.js";
import { fixture, argumentsForSettings } from "./classic-runtime-sequence.mjs";

const codes = (service, path = "/a.ts") => service.request("textDocument/diagnostic", { textDocument: { uri: `file://${path}` } }).items.map(item => item.code);

test("a host exception inside a build reaches the caller and the next call recovers", async () => {
    const project = fixture();
    const failure = new Error("snapshot of a dependency failed");
    const read = project.host.getScriptSnapshot;
    let fail = true;
    project.host.getScriptSnapshot = path => {
        if (fail && path === "/b.ts") throw failure;
        return read(path);
    };
    const service = createHostServiceChannel(await loadModule(), project.host, argumentsForSettings);
    try {
        assert.throws(() => codes(service), error => error === failure);
        fail = false;
        assert.deepEqual(codes(service), []);
    } finally { service.dispose(); }
});

test("a rebuild reads every loaded snapshot, so a deleted file with an unchanged version goes missing", async () => {
    const project = fixture();
    const service = createHostServiceChannel(await loadModule(), project.host, argumentsForSettings);
    try {
        assert.deepEqual(codes(service), []);
        project.text.delete("/b.ts");
        project.text.set("/a.ts", 'import { value } from "./b"; export const result: number = value; ');
        project.versions.set("/a.ts", "2");
        assert.ok(codes(service).includes(2307));
    } finally { service.dispose(); }
});

test("a missing root that appears with an unchanged version is picked up", async () => {
    const project = fixture();
    project.setRoots(["/a.ts", "/c.ts"]);
    const service = createHostServiceChannel(await loadModule(), project.host, argumentsForSettings);
    try {
        assert.throws(() => codes(service, "/c.ts"), /not part of the program/);
        project.text.set("/c.ts", "export const c: number = 'text';");
        assert.ok(codes(service, "/c.ts").includes(2322));
    } finally { service.dispose(); }
});

test("hasInvalidatedResolutions and hasChangedAutomaticTypeDirectiveNames force a rebuild", async () => {
    const project = fixture();
    project.setProjectVersion("1");
    let invalidated = false;
    project.host.hasInvalidatedResolutions = path => invalidated && path === "/a.ts";
    const service = createHostServiceChannel(await loadModule(), project.host, argumentsForSettings);
    try {
        project.text.delete("/b.ts");
        assert.ok(codes(service).includes(2307));
        project.text.set("/b.ts", "export const value = 'text';");
        project.setProjectVersion("2");
        assert.ok(codes(service).includes(2307), "an unchanged importer keeps its failed resolution");
        invalidated = true;
        project.setProjectVersion("3");
        assert.ok(codes(service).includes(2322));
        invalidated = false;
        project.text.set("/b.ts", "export const value = 1;");
        project.host.hasChangedAutomaticTypeDirectiveNames = () => true;
        project.setProjectVersion("4");
        assert.ok(codes(service).includes(2322), "a rebuild keeps the snapshot of an unchanged version");
    } finally { service.dispose(); }
});

test("a host without directoryExists treats directories as present, as TypeScript does", async () => {
    const project = fixture();
    project.text.set("/a.ts", 'import { value } from "pkg"; export const result: number = value;');
    project.text.set("/node_modules/pkg/index.d.ts", "export declare const value: string;");
    const service = createHostServiceChannel(await loadModule(), project.host, argumentsForSettings);
    try {
        assert.ok(codes(service).includes(2322));
    } finally { service.dispose(); }
});

test("a program build interrupted by a host exception keeps no program", async () => {
    const project = fixture();
    const failure = new Error("dependency snapshot failed");
    const read = project.host.getScriptSnapshot;
    let fail = false;
    project.host.getScriptSnapshot = path => {
        if (fail && path === "/b.ts") throw failure;
        return read(path);
    };
    const service = createHostServiceChannel(await loadModule(), project.host, argumentsForSettings);
    try {
        const first = service.getProgram();
        fail = true;
        project.versions.set("/a.ts", "2");
        project.versions.set("/b.ts", "2");
        assert.throws(() => service.getProgram(), error => error === failure);
        fail = false;
        const second = service.getProgram();
        assert.equal(second, first + 1, "the interrupted build issued no program handle");
    } finally { service.dispose(); }
});
