import { decodeSourceFile, nodeLease, resolveNodeHandle } from "./classic-ast.js";

const sources = new WeakMap();
const release = new FinalizationRegistry(({ instance, source, token }) => {
    const cache = sources.get(instance);
    if (cache?.get(source)?.token !== token) return;
    cache.delete(source);
    instance.releaseSource(source);
});

function sourceLease(instance, source) {
    let cache = sources.get(instance);
    if (!cache) {
        cache = new Map();
        sources.set(instance, cache);
    }
    let lease = cache.get(source)?.reference.deref();
    if (!lease) {
        lease = { instance, source };
        const token = {};
        cache.set(source, { reference: new WeakRef(lease), token });
        release.register(lease, { instance, source, token });
    }
    return lease;
}

/** One source object per Rust file version and classic parse target, shared by every user of the instance. */
export function materializeSourceFile(instance, response) {
    const lease = sourceLease(instance, response.source);
    const target = response.languageVersion;
    let file = lease.file?.deref();
    if (!file) {
        file = decodeSourceFile(response.data, { languageVersion: target, version: response.version }, lease);
        file.parseDiagnostics = (response.parseDiagnostics ?? []).map(diagnostic => withFile(diagnostic, file));
        // TypeScript 6.0.3 ignores `no-default-lib` references; its parser sets this false.
        file.hasNoDefaultLib = false;
        lease.file = new WeakRef(file);
    }
    return file;
}

/** A classic `DiagnosticWithLocation` of `file`. */
function withFile(response, file) {
    const result = { file, ...response };
    delete result.fileName;
    if (response.relatedInformation) result.relatedInformation = response.relatedInformation.map(related => withFile(related, file));
    return result;
}

export function resolveSourceNode(instance, handle) {
    const lease = sourceLease(instance, handle.source);
    const retained = lease.file?.deref();
    if (retained) return resolveNodeHandle(retained, handle);
    const response = instance.source(handle.source);
    const file = materializeSourceFile(instance, response);
    return resolveNodeHandle(file, handle);
}

/** The lease of a source file this compiler decoded, when `instance` owns it. */
export function sourceFileLease(file, instance) {
    const lease = file && nodeLease(file);
    return lease?.instance === instance ? lease.source : undefined;
}
