import { decodeSourceFile, nodeLease, resolveNodeHandle } from "./classic-ast.js";
import { getNamedDeclarations } from "./classic-source-file-members.js";

const namedDeclarations = new WeakMap();

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
    let file = lease.file?.deref();
    if (!file) {
        const source = response.data === undefined ? instance.source(response.source) : response;
        file = decodeSourceFile(source.data, { languageVersion: source.languageVersion, version: source.version }, lease);
        file.parseDiagnostics = (source.parseDiagnostics ?? []).map(diagnostic => withFile(diagnostic, file));
        // TypeScript 6.0.3 ignores `no-default-lib` references; its parser sets this false.
        file.hasNoDefaultLib = false;
        addSourceFileMembers(file, instance, response.source);
        file.pragmas = pragmaMap(source.pragmas ?? []);
        file.checkJsDirective = checkJsDirective(file.pragmas);
        lease.file = new WeakRef(file);
    }
    return file;
}

/** Classic `processCommentPragmas`: one entry per name, an array when the name repeats. */
function pragmaMap(pragmas) {
    const result = new Map();
    for (const [name, values, kind, pos, end, hasTrailingNewLine] of pragmas) {
        const args = {
            arguments: Object.fromEntries(values.map(([argument, value, start, stop]) => [argument, start === undefined ? value : { value, pos: start, end: stop }])),
            range: { kind, pos, end, hasTrailingNewLine },
        };
        if (result.has(name)) {
            const current = result.get(name);
            if (current instanceof Array) current.push(args);
            else result.set(name, [current, args]);
            continue;
        }
        result.set(name, args);
    }
    return result;
}

/** Classic `processPragmasIntoFields`: the last `ts-check` or `ts-nocheck` comment decides. */
function checkJsDirective(pragmas) {
    let directive;
    for (const key of ["ts-check", "ts-nocheck"]) {
        for (const entry of [].concat(pragmas.get(key) ?? [])) {
            if (!directive || entry.range.pos > directive.pos) directive = { enabled: key === "ts-check", end: entry.range.end, pos: entry.range.pos };
        }
    }
    return directive;
}

/** SourceFileObject's `identifiers` (read once from Rust) and `getNamedDeclarations`. */
function addSourceFileMembers(file, instance, source) {
    Object.defineProperty(file, "identifiers", {
        configurable: true, enumerable: true,
        get() {
            const identifiers = new Map(instance.call({ action: "sourceIdentifiers", source }).map(name => [name, name]));
            Object.defineProperty(file, "identifiers", { configurable: true, enumerable: true, writable: true, value: identifiers });
            return identifiers;
        },
    });
    file.getNamedDeclarations = () => getNamedDeclarations(file, namedDeclarations);
    // Classic's binder sets `commonJsModuleIndicator`; read it from the Rust binder's file info.
    Object.defineProperty(file, "commonJsModuleIndicator", {
        configurable: true, enumerable: true,
        get() {
            const handle = instance.call({ action: "sourceCommonJsModuleIndicator", source });
            return handle ? resolveNodeHandle(file, handle) : undefined;
        },
        set(value) {
            Object.defineProperty(file, "commonJsModuleIndicator", { configurable: true, enumerable: true, writable: true, value });
        },
    });
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
