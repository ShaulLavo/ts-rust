import { prepareRun } from "./runtime.js";
import { decodeProtocolString } from "./wtf8.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Internal synchronous transport for the classic TypeScript facade. */
export function createServiceChannel(module, options) {
    const run = prepareRun(module, { ...options, holdHostExceptions: true });
    let exports = run.attach(new WebAssembly.Instance(module, run.imports));
    let busy = false;
    let failure;

    function call(request) {
        if (!exports) throw new Error("language service is disposed");
        if (failure) throw failure;
        if (busy) throw new Error("language service cannot reenter a host callback");
        const input = encoder.encode(JSON.stringify(request));
        let response;
        busy = true;
        try {
            const ptr = exports.ts_input(input.length) >>> 0;
            new Uint8Array(exports.memory.buffer).set(input, ptr);
            exports.ts_service();
            response = JSON.parse(decoder.decode(new Uint8Array(
                exports.memory.buffer, exports.ts_output() >>> 0, exports.ts_output_len() >>> 0,
            )), (_, value) => decodeProtocolString(value));
        } catch (error) {
            failure = Object.assign(error, { stderr: run.stderrText() });
            throw failure;
        } finally { busy = false; }
        const held = run.takeHostException();
        if (held) {
            if (request.action !== "invalidate") call({ action: "invalidate" });
            throw held.error;
        }
        if (response.error) throw Object.assign(new Error(response.error.message), {
            code: response.error.code, data: response.error.data,
        });
        return response.result;
    }

    function dispose() {
        if (!exports) return;
        if (busy) throw new Error("language service cannot dispose during a host callback");
        try {
            if (!failure) call({ action: "dispose" });
        } finally {
            exports = undefined;
            failure = undefined;
            run.detach();
        }
    }

    try {
        call({ action: "initialize", cwd: options.cwd ?? "/", args: options.args ?? [],
            caseInsensitive: options.caseInsensitive ?? false, capabilities: options.capabilities ?? {} });
    } catch (error) {
        exports = undefined;
        run.detach();
        throw error;
    }
    return { call, dispose, isAlive: () => exports !== undefined && failure === undefined };
}
