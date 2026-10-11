import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRun } from "../runtime.js";
import { sharedInstance } from "../classic-instance.js";
import { createHostServiceChannel } from "../classic-host.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// A module exporting one memory page; host imports can be called directly.
const module = new WebAssembly.Module(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    5, 3, 1, 0, 1,
    7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0,
]));

function fixture(fs, holdHostExceptions = false) {
    const run = prepareRun(module, { fs, holdHostExceptions });
    const exports = run.attach(new WebAssembly.Instance(module, run.imports));
    return {
        run,
        call(op, path) {
            const request = encoder.encode(path);
            new Uint8Array(exports.memory.buffer).set(request);
            const status = run.imports.ts_host.fs(op, 0, request.length);
            if (status === -1) return { status };
            const length = status < -1 ? -2 - status : status;
            run.imports.ts_host.fs_take(1024);
            const text = decoder.decode(new Uint8Array(exports.memory.buffer, 1024, length));
            return { status, text };
        },
    };
}

function unsigned(value) {
    const bytes = [];
    do {
        const byte = value & 0x7f;
        value >>>= 7;
        bytes.push(value ? byte | 0x80 : byte);
    } while (value);
    return bytes;
}

const string = value => unsigned(encoder.encode(value).length).concat(Array.from(encoder.encode(value)));
const section = (id, bytes) => [id].concat(unsigned(bytes.length), bytes);
const constant = value => [0x41].concat(unsigned(value));
const body = instructions => unsigned(instructions.length + 2).concat([0], instructions, [0x0b]);

// Each service call probes the same paths and returns the six existence results.
// This exercises the live JS host adapters without a compiler build.
function serviceModule() {
    const paths = ["/both", "/missing", "/root.ts"];
    const response = encoder.encode('{"result":[0,0,0,0,0,0]}');
    const instructions = [];
    const data = [[128, response]];
    for (const [index, path] of paths.entries()) {
        const address = 256 + index * 32;
        data.push([address, encoder.encode(path)]);
        for (const [offset, op] of [11, 12].entries()) {
            instructions.push(...constant(128 + 11 + 4 * index + 2 * offset));
            instructions.push(...constant(op), ...constant(address), ...constant(path.length));
            // call fs; eqz turns its 0/-1 status into 1/0; add the ASCII digit base.
            instructions.push(0x10, 0, 0x45, 0x41, 48, 0x6a, 0x3a, 0, 0);
        }
    }
    const types = [4,
        0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f,
        0x60, 1, 0x7f, 1, 0x7f,
        0x60, 0, 0,
        0x60, 0, 1, 0x7f,
    ];
    const imports = [1].concat(string("ts_host"), string("fs"), [0, 0]);
    const exports = [5].concat(string("memory"), [2, 0],
        string("ts_input"), [0, 1], string("ts_service"), [0, 2],
        string("ts_output"), [0, 3], string("ts_output_len"), [0, 4]);
    const code = [4].concat(body(constant(0)), body(instructions), body(constant(128)), body(constant(response.length)));
    const segments = unsigned(data.length).concat(data.flatMap(([address, bytes]) =>
        [0].concat(constant(address), [0x0b], unsigned(bytes.length), Array.from(bytes))));
    return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, types), section(2, imports), section(3, [4, 1, 2, 3, 3]),
        section(5, [1, 0, 1]), section(7, exports), section(10, code), section(11, segments),
    )));
}

test("typed existence requests dispatch only their own callback and preserve stat independently", () => {
    const calls = [];
    const host = fixture({
        fileExists(path) { calls.push(["file", path]); return path === "/both"; },
        directoryExists(path) { calls.push(["directory", path]); return path === "/both" || path === "/directory"; },
        stat(path) { calls.push(["stat", path]); return { isDirectory: false, size: 7, mtimeNs: 9n }; },
    });
    try {
        assert.deepEqual(host.call(11, "/both"), { status: 0, text: "" });
        assert.deepEqual(host.call(12, "/both"), { status: 0, text: "" });
        assert.deepEqual(host.call(11, "/directory"), { status: -1 });
        assert.deepEqual(host.call(12, "/directory"), { status: 0, text: "" });
        assert.deepEqual(host.call(11, "/missing"), { status: -1 });
        assert.deepEqual(host.call(12, "/missing"), { status: -1 });
        assert.deepEqual(calls, [
            ["file", "/both"], ["directory", "/both"],
            ["file", "/directory"], ["directory", "/directory"],
            ["file", "/missing"], ["directory", "/missing"],
        ]);
        assert.deepEqual(host.call(1, "/both"), { status: 5, text: "f 7 9" });
        assert.deepEqual(calls.at(-1), ["stat", "/both"]);
    } finally { host.run.detach(); }
});

test("filesystem adapters without typed callbacks use one stat per existence request", () => {
    const calls = [];
    const host = fixture({ stat(path) {
        calls.push(path);
        if (path === "/file") return { isDirectory: false };
        if (path === "/directory") return { isDirectory: true };
        if (path === "/other") return { isFile: false, isDirectory: false };
        return undefined;
    } });
    try {
        for (const [path, file, directory] of [
            ["/file", true, false], ["/directory", false, true],
            ["/other", true, false], ["/missing", false, false],
        ]) {
            assert.equal(host.call(11, path).status, file ? 0 : -1);
            assert.equal(host.call(12, path).status, directory ? 0 : -1);
        }
        assert.deepEqual(calls, ["/file", "/file", "/directory", "/directory", "/other", "/other", "/missing", "/missing"]);
    } finally { host.run.detach(); }
});

test("existence callback exceptions retain identity and cancellation stays operation 10", () => {
    const failure = new Error("existence callback failed");
    let cancellations = 0;
    const host = fixture({
        fileExists() { throw failure; },
        directoryExists() { throw failure; },
        pollCancellation() { cancellations++; },
    }, true);
    try {
        for (const op of [11, 12]) {
            const result = host.call(op, "/failure");
            assert.ok(result.status < -1);
            assert.equal(result.text, "host callback failed");
            assert.equal(host.run.takeHostException().error, failure);
        }
        assert.deepEqual(host.call(10, ""), { status: 0, text: "" });
        assert.equal(cancellations, 1);
    } finally { host.run.detach(); }
});

test("shared classic instance forwards typed callbacks and keeps stat-only adapters working", () => {
    const instance = sharedInstance(serviceModule());
    const calls = [];
    assert.deepEqual(instance.call({}, {
        fileExists(path) { calls.push(["file", path]); return path === "/both"; },
        directoryExists(path) { calls.push(["directory", path]); return path === "/both"; },
        stat() { assert.fail("typed existence must bypass stat"); },
    }), [1, 1, 0, 0, 0, 0]);
    assert.deepEqual(calls, [
        ["file", "/both"], ["directory", "/both"],
        ["file", "/missing"], ["directory", "/missing"],
        ["file", "/root.ts"], ["directory", "/root.ts"],
    ]);
    assert.deepEqual(instance.call({}, {
        stat: path => path === "/both" ? { isDirectory: true } : undefined,
    }), [0, 1, 0, 0, 0, 0]);
});

test("classic host records file and directory existence separately for retained generations", () => {
    const calls = [];
    let present = true;
    const host = {
        getCurrentDirectory: () => "/",
        getCompilationSettings: () => ({}),
        getScriptFileNames: () => ["/root.ts"],
        getScriptVersion: () => "1",
        fileExists(path) { calls.push(["file", path]); return present && path === "/both"; },
        directoryExists(path) { calls.push(["directory", path]); return present && (path === "/both" || path === "/missing"); },
    };
    const service = createHostServiceChannel(serviceModule(), host, (_, names) => names);
    try {
        const program = service.getProgram();
        assert.deepEqual(program, [1, 1, 0, 1, 1, 0]);
        assert.ok(!calls.some(([kind, path]) => kind === "file" && path === "/root.ts"));
        calls.length = 0;
        present = false;
        assert.deepEqual(service.graph(program, "probe"), [1, 1, 0, 1, 1, 0]);
        assert.deepEqual(calls, [], "retained generations use saved true and false facts without polling the host");
    } finally { service.dispose(); }
});

test("classic hosts without directoryExists report every directory present", () => {
    const host = {
        getCurrentDirectory: () => "/",
        getCompilationSettings: () => ({}),
        getScriptFileNames: () => [],
        getScriptVersion: () => "1",
        fileExists: () => false,
    };
    const service = createHostServiceChannel(serviceModule(), host, () => []);
    try {
        const program = service.getProgram();
        assert.deepEqual(program, [0, 1, 0, 1, 0, 1]);
        assert.deepEqual(service.graph(program, "probe"), [0, 1, 0, 1, 0, 1]);
    } finally { service.dispose(); }
});
