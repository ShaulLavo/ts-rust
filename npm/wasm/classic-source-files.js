import { decodeSourceFile, resolveNodeHandle } from "./classic-ast.js";

const sources = new WeakMap();
const release = new FinalizationRegistry(({ channel, source, token }) => {
    const cache = sources.get(channel);
    if (cache?.get(source)?.token !== token) return;
    cache.delete(source);
    channel.releaseSource(source);
});

function sourceLease(channel, source) {
    let cache = sources.get(channel);
    if (!cache) {
        cache = new Map();
        sources.set(channel, cache);
    }
    let lease = cache.get(source)?.reference.deref();
    if (!lease) {
        lease = { channel, source };
        const token = {};
        cache.set(source, { reference: new WeakRef(lease), token });
        release.register(lease, { channel, source, token });
    }
    return lease;
}

/** One source object per Rust file version and classic parse target. */
export function materializeSourceFile(channel, response) {
    const lease = sourceLease(channel, response.source);
    const target = response.languageVersion;
    let file = lease.file?.deref();
    if (!file) {
        file = decodeSourceFile(response.data, { languageVersion: target, version: response.version }, lease);
        lease.file = new WeakRef(file);
    }
    return file;
}

export function resolveSourceNode(channel, handle) {
    const lease = sourceLease(channel, handle.source);
    const retained = lease.file?.deref();
    if (retained) return resolveNodeHandle(retained, handle);
    const response = channel.source(handle.source);
    const file = materializeSourceFile(channel, response);
    return resolveNodeHandle(file, handle);
}
