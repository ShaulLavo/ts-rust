import { result, sharedInstance } from "./classic-instance.js";

/** Internal synchronous transport for the classic TypeScript facade: one session of the shared instance. */
export function createServiceChannel(module, options) {
    const instance = sharedInstance(module);
    const files = options.fs;
    let session = instance.call({ action: "open", cwd: options.cwd ?? "/", args: options.args ?? [],
        caseInsensitive: options.caseInsensitive ?? false, capabilities: options.capabilities ?? {},
        documents: options.documents ?? false }, files);

    function call(request) {
        if (session === undefined) throw new Error("language service is disposed");
        if (!instance.isAlive()) throw instance.failure();
        if (instance.isRunning(session)) throw new Error("language service cannot reenter a host callback");
        const { response, held } = instance.send(Object.assign({ session }, request), files);
        if (held) {
            if (request.action !== "invalidate") call({ action: "invalidate" });
            throw held.error;
        }
        return result(response);
    }

    function dispose() {
        if (session === undefined) return;
        if (instance.isRunning(session)) throw new Error("language service cannot dispose during a host callback");
        try {
            if (instance.isAlive()) instance.call({ action: "close", session });
        } finally {
            session = undefined;
        }
    }

    return { call, dispose, instance, isAlive: () => session !== undefined && instance.isAlive() };
}
