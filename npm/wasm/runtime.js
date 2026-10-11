// The runtime-independent part of the package: a small WASI preview1 shim,
// the host file system bridge (crates/ts_wasm/src/host.rs) and one tsc run.
// It needs only WebAssembly, TextEncoder, TextDecoder, crypto and
// performance, so it runs in Node, Deno, Bun and browsers.

import { encodeWtf8, decodeWtf8 } from "./wtf8.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// crates/ts_wasm FLAG_* bits.
const FLAG_DIAGNOSTICS_JSON = 1;
const FLAG_CASE_INSENSITIVE = 2;

// WASI errno values.
const SUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

/** Thrown by the WASI `proc_exit` import to end a run. */
export class WasiExit extends Error {
    constructor(code) {
        super(`exit ${code}`);
        this.code = code;
    }
}

// crates/ts_wasm/src/host.rs `Op`.
const OP_READ = 0;
const OP_STAT = 1;
const OP_READ_DIR = 2;
const OP_REALPATH = 3;
const OP_WRITE = 4;
const OP_APPEND = 5;
const OP_REMOVE = 6;
const OP_CHTIMES = 7;
const OP_SOURCE_METADATA = 8;
const OP_GET_SOURCE_FILE = 9;
const OP_POLL_CANCELLATION = 10;

const KIND_CHAR = { file: "f", directory: "d", symlink: "l", other: "o" };

/**
 * The result of a host write method: undefined or true when it worked,
 * false when it failed, or a string with Go's text of its error (for
 * example `open /a.js: permission denied`), which tsc then reports.
 */
function writeResult(result) {
    if (result === false) return undefined;
    if (typeof result === "string") return { error: result };
    return new Uint8Array();
}

/**
 * Runs one host file operation of crates/ts_wasm/src/host.rs on `fs`. It
 * returns the result bytes, undefined when the operation fails, or
 * `{ error }` when it fails with an error text.
 */
function fsCall(fs, op, request) {
    const text = decodeWtf8(request);
    switch (op) {
        case OP_READ: {
            const data = fs.readFile(text);
            if (data === undefined) return undefined;
            return typeof data === "string" ? encodeWtf8(data) : data;
        }
        case OP_STAT: {
            const stat = fs.stat(text);
            if (!stat) return undefined;
            const kind = stat.isDirectory ? "d" : stat.isFile === false ? "o" : "f";
            const ns = stat.mtimeNs ?? BigInt(Math.round((stat.mtimeMs ?? 0) * 1e6));
            return encoder.encode(`${kind} ${stat.size ?? 0} ${ns}`);
        }
        case OP_READ_DIR: {
            const entries = fs.readDirectory(text);
            if (!entries) return undefined;
            return encodeWtf8(entries.map(e => `${KIND_CHAR[e.kind] ?? "o"}${e.name}\0`).join(""));
        }
        case OP_REALPATH: {
            const real = fs.realpath ? fs.realpath(text) : undefined;
            return real === undefined ? undefined : encodeWtf8(real);
        }
        case OP_WRITE:
        case OP_APPEND: {
            const nul = request.indexOf(0);
            const path = decodeWtf8(request.subarray(0, nul));
            const data = request.subarray(nul + 1);
            if (!fs.writeFile) return undefined;
            return writeResult(fs.writeFile(path, data, op === OP_APPEND));
        }
        case OP_REMOVE:
            if (!fs.remove) return undefined;
            return writeResult(fs.remove(text));
        case OP_CHTIMES: {
            const [path, atime, mtime] = text.split("\0");
            if (!fs.chtimes) return new Uint8Array();
            return writeResult(fs.chtimes(path, atime ? BigInt(atime) : undefined, mtime ? BigInt(mtime) : undefined));
        }
        case OP_SOURCE_METADATA: {
            const metadata = fs.sourceMetadata?.(text);
            return metadata === undefined ? undefined : encoder.encode(JSON.stringify(metadata));
        }
        case OP_POLL_CANCELLATION:
            fs.pollCancellation?.();
            return new Uint8Array();
        case OP_GET_SOURCE_FILE: {
            const lease = fs.getSourceFile?.(JSON.parse(text));
            return lease === undefined ? undefined : encoder.encode(String(lease));
        }
    }
    return undefined;
}

/** The state and imports of one run (`runTsc`, `runTscAsync`). */
export function prepareRun(module, options) {
    const {
        args = [],
        cwd = "/",
        fs,
        env = {},
        stdout = () => {},
        stderr = () => {},
        diagnosticsJson = false,
        caseInsensitive = false,
        tty = false,
        holdHostExceptions = false,
    } = options;
    let memory;
    let staged;
    let hostException;
    let stderrText = "";
    const u8 = () => new Uint8Array(memory.buffer);
    const dv = () => new DataView(memory.buffer);

    const envBytes = Object.entries(env).map(([k, v]) => encoder.encode(`${k}=${v}\0`));
    const writeStrings = (list, ptrs, buf) => {
        ptrs >>>= 0;
        buf >>>= 0;
        const view = dv();
        let at = buf;
        list.forEach((bytes, i) => {
            view.setUint32(ptrs + i * 4, at, true);
            u8().set(bytes, at);
            at += bytes.length;
        });
        return SUCCESS;
    };
    const sizes = (list, countPtr, sizePtr) => {
        countPtr >>>= 0;
        sizePtr >>>= 0;
        dv().setUint32(countPtr, list.length, true);
        dv().setUint32(sizePtr, list.reduce((n, b) => n + b.length, 0), true);
        return SUCCESS;
    };

    const wasi = {
        args_sizes_get: (countPtr, sizePtr) => sizes([], countPtr, sizePtr),
        args_get: () => SUCCESS,
        environ_sizes_get: (countPtr, sizePtr) => sizes(envBytes, countPtr, sizePtr),
        environ_get: (ptrs, buf) => writeStrings(envBytes, ptrs, buf),
        clock_time_get: (id, _precision, out) => {
            out >>>= 0;
            // Wall time with sub-millisecond steps (not Date.now): tsc leaves
            // out a statistics row whose time is zero.
            const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
            const ns = BigInt(Math.round(ms * 1e6));
            dv().setBigUint64(out, ns, true);
            return SUCCESS;
        },
        clock_res_get: (_id, out) => {
            out >>>= 0;
            dv().setBigUint64(out, 1000n, true);
            return SUCCESS;
        },
        random_get: (buf, len) => {
            buf >>>= 0;
            len >>>= 0;
            for (let at = 0; at < len; at += 65536) {
                crypto.getRandomValues(u8().subarray(buf + at, buf + Math.min(len, at + 65536)));
            }
            return SUCCESS;
        },
        fd_write: (fd, iovs, iovsLen, nwritten) => {
            if (fd !== 1 && fd !== 2) return EBADF;
            iovs >>>= 0;
            iovsLen >>>= 0;
            nwritten >>>= 0;
            const view = dv();
            let total = 0;
            for (let i = 0; i < iovsLen; i++) {
                const ptr = view.getUint32(iovs + i * 8, true);
                const len = view.getUint32(iovs + i * 8 + 4, true);
                const chunk = u8().slice(ptr, ptr + len);
                if (fd === 1) stdout(chunk);
                else {
                    stderrText += decoder.decode(chunk);
                    stderr(chunk);
                }
                total += len;
            }
            view.setUint32(nwritten, total, true);
            return SUCCESS;
        },
        fd_fdstat_get: (fd, out) => {
            if (fd > 2) return EBADF;
            out >>>= 0;
            // A character device without seek rights is a terminal for Rust's
            // `IsTerminal`.
            u8().fill(0, out, out + 24);
            dv().setUint8(out, fd === 1 && tty ? 2 : 0);
            return SUCCESS;
        },
        fd_prestat_get: () => EBADF,
        proc_exit: code => {
            throw new WasiExit(code);
        },
        sched_yield: () => SUCCESS,
        poll_oneoff: (_in, _out, _n, nevents) => {
            nevents >>>= 0;
            dv().setUint32(nevents, 0, true);
            return SUCCESS;
        },
    };
    const imports = { wasi_snapshot_preview1: {}, ts_host: {} };
    for (const { module: name, name: field } of WebAssembly.Module.imports(module)) {
        if (name === "wasi_snapshot_preview1") imports[name][field] = wasi[field] ?? (() => ENOSYS);
    }
    imports.ts_host.fs = (op, ptr, len) => {
        ptr >>>= 0;
        len >>>= 0;
        let result;
        try { result = fsCall(fs, op, u8().slice(ptr, ptr + len)); }
        catch (error) {
            if (!holdHostExceptions) throw error;
            hostException ??= { error };
            result = { error: "host callback failed" };
        }
        if (result === undefined) return -1;
        if (result.error !== undefined) {
            staged = encoder.encode(result.error);
            return -2 - staged.length;
        }
        staged = result;
        return staged.length;
    };
    imports.ts_host.fs_take = ptr => {
        ptr >>>= 0;
        u8().set(staged, ptr);
        staged = undefined;
    };

    let exports;
    return {
        imports,
        attach(instance) {
            exports = instance.exports;
            memory = exports.memory;
            return exports;
        },
        detach() {
            exports = undefined;
            memory = undefined;
        },
        stderrText: () => stderrText,
        /** The first exception a host callback threw since the last call, held by `holdHostExceptions`. */
        takeHostException() {
            const held = hostException;
            hostException = undefined;
            return held;
        },
        /** Writes the request into `instance` and returns its `ts_run`. */
        start(instance) {
            exports = instance.exports;
            memory = exports.memory;
            let flags = 0;
            if (diagnosticsJson) flags |= FLAG_DIAGNOSTICS_JSON;
            if (caseInsensitive) flags |= FLAG_CASE_INSENSITIVE;
            const request = encoder.encode([cwd, String(flags)].concat(args).join("\0"));
            u8().set(request, exports.ts_input(request.length) >>> 0);
            return exports.ts_run;
        },
        /** The result of a `ts_run` call that returned `exitCode` or threw `error`. */
        result(exitCode, error) {
            if (error !== undefined) {
                if (!(error instanceof WasiExit)) {
                    error.stderr = stderrText;
                    throw error;
                }
                exitCode = error.code;
            }
            let diagnostics;
            if (diagnosticsJson) {
                const ptr = exports.ts_output() >>> 0;
                const len = exports.ts_output_len() >>> 0;
                diagnostics = len ? JSON.parse(decoder.decode(u8().subarray(ptr, ptr + len))) : [];
            }
            return { exitCode, diagnostics };
        },
    };
}
