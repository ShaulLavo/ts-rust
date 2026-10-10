import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRun } from "../runtime.js";

function unsigned(value) {
    const bytes = [];
    do {
        const byte = value & 0x7f;
        value >>>= 7;
        bytes.push(value ? byte | 0x80 : byte);
    } while (value);
    return bytes;
}

const encoder = new TextEncoder();
const string = value => unsigned(encoder.encode(value).length).concat(Array.from(encoder.encode(value)));
const section = (id, bytes) => [id].concat(unsigned(bytes.length), bytes);

function fixtureModule() {
    const imports = [
        { module: "ts_host", name: "fs", parameters: [0x7f, 0x7f, 0x7f], results: [0x7f] },
        { module: "ts_host", name: "fs_take", parameters: [0x7f], results: [] },
        { module: "wasi_snapshot_preview1", name: "fd_write", parameters: [0x7f, 0x7f, 0x7f, 0x7f], results: [0x7f] },
        { module: "wasi_snapshot_preview1", name: "clock_time_get", parameters: [0x7f, 0x7e, 0x7f], results: [0x7f] },
        { module: "wasi_snapshot_preview1", name: "args_sizes_get", parameters: [0x7f, 0x7f], results: [0x7f] },
        { module: "wasi_snapshot_preview1", name: "fd_fdstat_get", parameters: [0x7f, 0x7f], results: [0x7f] },
    ];
    const types = unsigned(imports.length).concat(imports.flatMap(entry =>
        [0x60].concat(unsigned(entry.parameters.length), entry.parameters, unsigned(entry.results.length), entry.results)));
    const functions = unsigned(imports.length).concat(imports.flatMap((entry, index) =>
        string(entry.module).concat(string(entry.name), [0], unsigned(index))));
    const memory = [1, 1].concat(unsigned(32_769), unsigned(65_536));
    const exports = [1].concat(string("memory"), [2, 0]);
    return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, types), section(2, functions), section(5, memory), section(7, exports),
    )));
}

test("WASI and host imports interpret signed wasm32 pointers as unsigned addresses", t => {
    const module = fixtureModule();
    let output = "";
    const run = prepareRun(module, { fs: {
        readFile(path) { assert.equal(path, "/high.ts"); return "high"; },
    }, stdout: bytes => output += new TextDecoder().decode(bytes) });
    let instance;
    try { instance = new WebAssembly.Instance(module, run.imports); }
    catch (error) { t.skip(`large virtual WASM memory unavailable: ${error.message}`); return; }
    const exports = run.attach(instance);
    const address = 0x8000_0010;
    const signed = address | 0;
    const path = encoder.encode("/high.ts");
    new Uint8Array(exports.memory.buffer, address, path.length).set(path);
    assert.equal(run.imports.ts_host.fs(0, signed, path.length), 4);
    run.imports.ts_host.fs_take((address + 64) | 0);
    assert.equal(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, address + 64, 4)), "high");
    const view = new DataView(exports.memory.buffer);
    view.setUint32(address + 128, address + 64, true);
    view.setUint32(address + 132, 4, true);
    assert.equal(run.imports.wasi_snapshot_preview1.fd_write(1, (address + 128) | 0, 1, (address + 160) | 0), 0);
    assert.equal(output, "high");
    assert.equal(view.getUint32(address + 160, true), 4);
    assert.equal(run.imports.wasi_snapshot_preview1.clock_time_get(0, 0n, (address + 192) | 0), 0);
    assert.ok(view.getBigUint64(address + 192, true) > 0n);
    assert.equal(run.imports.wasi_snapshot_preview1.args_sizes_get((address + 224) | 0, (address + 228) | 0), 0);
    assert.equal(view.getUint32(address + 224, true), 0);
    assert.equal(run.imports.wasi_snapshot_preview1.fd_fdstat_get(1, (address + 256) | 0), 0);
    run.detach();
});
