import { prepareRun } from "./runtime.js";
import { decodeProtocolString, encodeWtf8 } from "./wtf8.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const instances = new WeakMap();

/**
 * The WebAssembly instance every classic service and document registry of a
 * compiled module shares, so that a document parsed for one registry can
 * serve every service that receives it, as classic source files do. A trap
 * ends the instance; the next caller gets a new one.
 */
export function sharedInstance(module) {
    let instance = instances.get(module);
    if (!instance?.isAlive()) {
        instance = createInstance(module);
        instances.set(module, instance);
    }
    return instance;
}

function createInstance(module) {
    let active;
    let depth = 0;
    // Sessions whose requests are running, outermost first.
    const running = [];
    let failure;
    // Host file operations reach the session whose request is running.
    const fs = {
        readFile: path => active.readFile(path),
        stat: path => active.stat(path),
        readDirectory: path => active.readDirectory(path),
        realpath: path => active.realpath?.(path),
        getSourceFile: request => active.getSourceFile(request),
        // Classic's checker polls; the exception the token throws ends the request.
        pollCancellation() {
            try { cancellation?.throwIfCancellationRequested(); }
            catch (error) {
                if (typeof error === "object" && error !== null) cancellations.add(error);
                throw error;
            }
        },
    };
    // Exceptions a cancellation poll threw: they end a request without invalidating its session.
    const cancellations = new WeakSet();
    // The classic cancellation token of the running request, if it has one.
    let cancellation;
    const run = prepareRun(module, { fs, holdHostExceptions: true });
    let exports = run.attach(new WebAssembly.Instance(module, run.imports));

    /**
     * Sends one request and returns its response with the first exception a
     * host callback threw during it. A host callback may send requests for
     * documents and for other sessions, as a classic compiler host parses
     * files and reads the old program; a running session cannot be reentered.
     */
    function send(request, files, payload) {
        if (failure) throw failure;
        if (request.session !== undefined && running.includes(request.session)) {
            throw new Error("language service cannot reenter a host callback");
        }
        const json = encoder.encode(JSON.stringify(request));
        let input = json;
        if (payload !== undefined) {
            const text = encodeWtf8(payload);
            input = new Uint8Array(json.length + 1 + text.length);
            input.set(json);
            input.set(text, json.length + 1);
        }
        const previous = active;
        if (files) active = files;
        if (request.session !== undefined) running.push(request.session);
        depth++;
        let response;
        try {
            const ptr = exports.ts_input(input.length) >>> 0;
            new Uint8Array(exports.memory.buffer).set(input, ptr);
            exports.ts_service();
            response = decodeResponse(new Uint8Array(exports.memory.buffer, exports.ts_output() >>> 0, exports.ts_output_len() >>> 0));
        } catch (error) {
            failure = Object.assign(error, { stderr: run.stderrText() });
            exports = undefined;
            run.detach();
            throw failure;
        } finally {
            depth--;
            if (request.session !== undefined) running.pop();
            active = previous;
        }
        return { response, held: depth === 0 ? run.takeHostException() : undefined };
    }

    function call(request, files, payload) {
        const { response, held } = send(request, files, payload);
        if (held) throw held.error;
        return result(response);
    }

    return {
        send,
        call,
        isAlive: () => failure === undefined,
        /** The size of the instance's linear memory, for diagnostics. */
        memoryBytes: () => exports?.memory.buffer.byteLength,
        inCallback: () => depth > 0,
        isRunning: session => running.includes(session),
        failure: () => failure,
        source: source => call({ action: "source", source }),
        releaseSource(source) {
            if (failure === undefined && depth === 0) call({ action: "releaseSource", source });
        },
        parseDocument: (request, text) => call(Object.assign({ action: "parseDocument" }, request), undefined, text),
        isCancellation: error => typeof error === "object" && error !== null && cancellations.has(error),
        /** Runs `callback` with `token` as the running requests' cancellation token. */
        withCancellation(token, callback) {
            const previous = cancellation;
            cancellation = token;
            try { return callback(); }
            finally { cancellation = previous; }
        },
    };
}

/** A reply: JSON, then optionally NUL and the binary payload its `$payload` ranges point into. */
function decodeResponse(output) {
    const end = output.indexOf(0);
    const payload = end < 0 ? undefined : output.slice(end + 1);
    return JSON.parse(decoder.decode(end < 0 ? output : output.subarray(0, end)), (_, value) => {
        if (payload && Array.isArray(value?.$payload)) return payload.slice(value.$payload[0], value.$payload[0] + value.$payload[1]);
        return decodeProtocolString(value);
    });
}

/** The result of a response, or its compiler error. */
export function result(response) {
    if (response.error) throw Object.assign(new Error(response.error.message), {
        code: response.error.code, data: response.error.data,
    });
    return response.result;
}
