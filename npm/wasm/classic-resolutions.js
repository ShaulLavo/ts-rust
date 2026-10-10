// Apache-2.0. Ported unchanged from Microsoft TypeScript 6.0.3 (050880ce)
// src/compiler/moduleNameResolver.ts.

export function createModeAwareCacheKey(specifier, mode) {
    return mode === undefined ? specifier : `${mode}|${specifier}`;
}

export function createModeAwareCache() {
    const underlying = new Map();
    const memoizedReverseKeys = new Map();

    const cache = {
        get(specifier, mode) {
            return underlying.get(getUnderlyingCacheKey(specifier, mode));
        },
        set(specifier, mode, value) {
            underlying.set(getUnderlyingCacheKey(specifier, mode), value);
            return cache;
        },
        delete(specifier, mode) {
            underlying.delete(getUnderlyingCacheKey(specifier, mode));
            return cache;
        },
        has(specifier, mode) {
            return underlying.has(getUnderlyingCacheKey(specifier, mode));
        },
        forEach(cb) {
            return underlying.forEach((elem, key) => {
                const [specifier, mode] = memoizedReverseKeys.get(key);
                return cb(elem, specifier, mode);
            });
        },
        size() {
            return underlying.size;
        },
    };
    return cache;

    function getUnderlyingCacheKey(specifier, mode) {
        const result = createModeAwareCacheKey(specifier, mode);
        memoizedReverseKeys.set(result, [specifier, mode]);
        return result;
    }
}
