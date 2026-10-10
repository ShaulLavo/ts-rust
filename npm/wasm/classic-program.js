import { materializeSourceFile, resolveSourceNode } from "./classic-source-files.js";
import { createTypeChecker } from "./classic-checker.js";

const programs = new WeakMap();
const leases = new WeakMap();
const releases = new FinalizationRegistry(({ channel, handle, token }) => {
    const cache = leases.get(channel);
    if (cache?.get(handle)?.token !== token) return;
    cache.delete(handle);
    programs.get(channel)?.delete(handle);
    channel.releaseProgram(handle);
});

/** Private retained program bridge. The classic facade owns host synchronization. */
export function createProgramGraph(channel, handle, settings = {}) {
    let cache = programs.get(channel);
    if (!cache) {
        cache = new Map();
        programs.set(channel, cache);
    }
    const retained = cache.get(handle)?.deref();
    if (retained) return retained;
    let leaseCache = leases.get(channel);
    if (!leaseCache) {
        leaseCache = new Map();
        leases.set(channel, leaseCache);
    }
    let lease = leaseCache.get(handle)?.reference.deref();
    if (!lease) {
        lease = { channel, handle, settings, files: new Map(), metadata: new WeakMap() };
        const token = {};
        leaseCache.set(handle, { reference: new WeakRef(lease), token });
        releases.register(lease, { channel, handle, token });
    }
    settings = lease.settings;
    const files = lease.files;
    const metadata = lease.metadata;
    const graph = (method, params) => lease.channel.graph(lease.handle, method, params);
    graph("setParseTarget", { target: settings.target ?? 1 });

    function resolveNode(handle) {
        return resolveSourceNode(channel.instance, handle);
    }

    function getSourceFile(fileName) {
        let file = files.get(fileName);
        if (file) return file;
        const response = graph("getSourceFile", { fileName });
        if (!response) return undefined;
        file = files.get(response.fileName);
        if (file) return file;
        file = materializeSourceFile(channel.instance, response);
        // A bundled library has no host version, as a classic host has none for a file it does not own.
        if (file.resolvedPath === undefined) file.version = undefined;
        files.set(response.fileName, file);
        metadata.set(file, response);
        return file;
    }

    function diagnostic(response) {
        const result = { ...response, file: response.fileName ? getSourceFile(response.fileName) : undefined };
        delete result.fileName;
        if (response.relatedInformation) result.relatedInformation = response.relatedInformation.map(diagnostic);
        return result;
    }

    function diagnostics(method, file) {
        return graph(method, { fileName: typeof file === "string" ? file : file?.fileName }).map(diagnostic);
    }

    const program = {
        getRootFileNames: () => graph("getRootFileNames"),
        getSourceFile,
        getSourceFiles: () => graph("getSourceFileNames").map(getSourceFile),
        getCompilerOptions: () => settings,
        getTypeChecker: () => lease.checker ??= createTypeChecker(lease, resolveNode),
        getCurrentDirectory: () => graph("getCurrentDirectory"),
        getSourceFileByPath: path => program.getSourceFiles().find(file => (file.resolvedPath ?? file.fileName) === path),
        getMissingFilePaths: () => new Map(graph("getMissingFilePaths")),
        getProjectReferences: () => undefined,
        getResolvedProjectReferences: () => undefined,
        resolvedLibReferences: undefined,
        isSourceFileDefaultLibrary: file => metadata.get(file)?.defaultLibrary ?? false,
        isSourceFileFromExternalLibrary: file => metadata.get(file)?.externalLibrary ?? false,
        getSyntacticDiagnostics: file => diagnostics("getSyntacticDiagnostics", file),
        getSemanticDiagnostics: file => diagnostics("getSemanticDiagnostics", file),
        getSuggestionDiagnostics: file => diagnostics("getSuggestionDiagnostics", file),
        getGlobalDiagnostics: () => diagnostics("getGlobalDiagnostics"),
        getOptionsDiagnostics: () => diagnostics("getOptionsDiagnostics"),
        getConfigFileParsingDiagnostics: () => diagnostics("getConfigFileParsingDiagnostics"),
        getDeclarationDiagnostics: file => diagnostics("getDeclarationDiagnostics", file),
    };
    cache.set(handle, new WeakRef(program));
    return program;
}
