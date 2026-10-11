import assert from "node:assert/strict";
import { test } from "node:test";
import { createLanguageService, runTsc } from "../core.js";

function unsigned(value) {
    const bytes = [];
    do {
        const byte = value & 0x7f;
        value >>>= 7;
        bytes.push(value ? byte | 0x80 : byte);
    } while (value);
    return bytes;
}

function signed(value) {
    const bytes = [];
    let more;
    do {
        const byte = value & 0x7f;
        value >>= 7;
        more = !((value === 0 && !(byte & 0x40)) || (value === -1 && (byte & 0x40)));
        bytes.push(more ? byte | 0x80 : byte);
    } while (more);
    return bytes;
}

const encoder = new TextEncoder();
const string = value => unsigned(encoder.encode(value).length).concat(Array.from(encoder.encode(value)));
const section = (id, bytes) => [id].concat(unsigned(bytes.length), bytes);
const address = 0x8000_0010;

function fixtureModule(response) {
    const imports = [
        { module: "ts_host", name: "fs", parameters: [0x7f, 0x7f, 0x7f], results: [0x7f] },
        { module: "ts_host", name: "fs_take", parameters: [0x7f], results: [] },
        { module: "wasi_snapshot_preview1", name: "fd_write", parameters: [0x7f, 0x7f, 0x7f, 0x7f], results: [0x7f] },
        { module: "wasi_snapshot_preview1", name: "clock_time_get", parameters: [0x7f, 0x7e, 0x7f], results: [0x7f] },
        { module: "wasi_snapshot_preview1", name: "args_sizes_get", parameters: [0x7f, 0x7f], results: [0x7f] },
        { module: "wasi_snapshot_preview1", name: "fd_fdstat_get", parameters: [0x7f, 0x7f], results: [0x7f] },
    ];
    const functions = [
        { name: "ts_input", parameters: [0x7f], results: [0x7f], value: address | 0 },
        { name: "ts_run", parameters: [], results: [0x7f], value: 0 },
        { name: "ts_output", parameters: [], results: [0x7f], value: (address + 1024) | 0 },
        { name: "ts_output_len", parameters: [], results: [0x7f], value: encoder.encode(response).length },
        { name: "ts_service", parameters: [], results: [] },
    ];
    const types = unsigned(imports.length + functions.length).concat(imports.concat(functions).flatMap(entry =>
        [0x60].concat(unsigned(entry.parameters.length), entry.parameters, unsigned(entry.results.length), entry.results)));
    const imported = unsigned(imports.length).concat(imports.flatMap((entry, index) =>
        string(entry.module).concat(string(entry.name), [0], unsigned(index))));
    const bodies = functions.map(entry => {
        const body = entry.value === undefined ? [0, 0x0b] : [0, 0x41].concat(signed(entry.value), [0x0b]);
        return unsigned(body.length).concat(body);
    });
    const exports = unsigned(functions.length + 1).concat(string("memory"), [2, 0], functions.flatMap((entry, index) =>
        string(entry.name).concat([0], unsigned(imports.length + index))));
    const data = [1, 0, 0x41].concat(signed((address + 1024) | 0), [0x0b], string(response));
    return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, types), section(2, imported),
        section(3, unsigned(functions.length).concat(functions.flatMap((_, index) => unsigned(imports.length + index)))),
        section(5, [1, 1].concat(unsigned(32_769), unsigned(65_536))),
        section(7, exports), section(10, unsigned(bodies.length).concat(bodies.flat())), section(11, data),
    )));
}

test("WASI and host imports interpret signed wasm32 pointers as unsigned addresses", t => {
    const module = fixtureModule("[]");
    const OriginalInstance = WebAssembly.Instance;
    let instance;
    let imports;
    let output = "";
    WebAssembly.Instance = function (module, supplied) {
        imports = supplied;
        instance = new OriginalInstance(module, supplied);
        return instance;
    };
    try {
        assert.deepEqual(runTsc(module, { args: ["/high.ts"], diagnosticsJson: true, fs: {
            readFile(path) { assert.equal(path, "/high.ts"); return "high"; },
        }, stdout: bytes => output += new TextDecoder().decode(bytes) }), { exitCode: 0, diagnostics: [] });
        const signedAddress = address | 0;
        const path = encoder.encode("/high.ts");
        new Uint8Array(instance.exports.memory.buffer, address, path.length).set(path);
        assert.equal(imports.ts_host.fs(0, signedAddress, path.length), 4);
        imports.ts_host.fs_take((address + 64) | 0);
        assert.equal(new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, address + 64, 4)), "high");
        const view = new DataView(instance.exports.memory.buffer);
        view.setUint32(address + 128, address + 64, true);
        view.setUint32(address + 132, 4, true);
        assert.equal(imports.wasi_snapshot_preview1.fd_write(1, (address + 128) | 0, 1, (address + 160) | 0), 0);
        assert.equal(output, "high");
        assert.equal(view.getUint32(address + 160, true), 4);
        assert.equal(imports.wasi_snapshot_preview1.clock_time_get(0, 0n, (address + 192) | 0), 0);
        assert.ok(view.getBigUint64(address + 192, true) > 0n);
        assert.equal(imports.wasi_snapshot_preview1.args_sizes_get((address + 224) | 0, (address + 228) | 0), 0);
        assert.equal(view.getUint32(address + 224, true), 0);
        assert.equal(imports.wasi_snapshot_preview1.fd_fdstat_get(1, (address + 256) | 0), 0);
    } catch (error) {
        if (!instance && error instanceof RangeError) { t.skip(`large virtual WASM memory unavailable: ${error.message}`); return; }
        throw error;
    } finally { WebAssembly.Instance = OriginalInstance; }
});

test("service input and output pointers above 2 GiB are unsigned", async () => {
    const service = await createLanguageService(fixtureModule('{"result":null}'));
    try { assert.equal(await service.request("textDocument/hover", {}), null); }
    finally { await service.dispose(); }
});
