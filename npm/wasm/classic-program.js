import { nodeHandle } from "./classic-ast.js";
import { materializeSourceFile, resolveSourceNode } from "./classic-source-files.js";
import { createTypeChecker, nodeSymbolKey } from "./classic-checker.js";
import { useNodeSymbols } from "./classic-ast.js";
import { createModeAwareCache } from "./classic-resolutions.js";
import { SyntaxKind } from "./classic-enums.js";
import { classicNamespace } from "./classic-module.js";

const programs = new WeakMap();
// The program that last answered each source file: its checker interns the file's binder symbols.
const filePrograms = new WeakMap();
useNodeSymbols((node, property) => {
    const program = filePrograms.get(node.getSourceFile())?.deref();
    return program?.getTypeChecker()[nodeSymbolKey](node, property === "localSymbol");
});
const leases = new WeakMap();
// A held value must not reach its lease, or the lease never collects: it holds the
// caches and a release function, never the channel, whose host callbacks can reach
// the service that holds the program.
const releases = new FinalizationRegistry(({ leaseCache, programCache, release, handle, token }) => {
    if (leaseCache.get(handle)?.token !== token) return;
    leaseCache.delete(handle);
    programCache.delete(handle);
    release();
});

/** The graph call and diagnostic projection of each program, kept off the public object. */
export const programInternals = new WeakMap();

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
        const release = channel.releaser ? channel.releaser(handle) : programReleaser(channel, handle);
        releases.register(lease, { leaseCache, programCache: cache, release, handle, token });
    }
    settings = lease.settings;
    const files = lease.files;
    const metadata = lease.metadata;
    const graph = (method, params) => lease.channel.graph(lease.handle, method, params);
    graph("setParseTarget", { target: settings.target ?? 1 });

    function resolveNode(handle) {
        const node = resolveSourceNode(channel.instance, handle);
        // A node the checker answers names its file's binder symbols too.
        const file = node.getSourceFile();
        if (!filePrograms.get(file)?.deref()) filePrograms.set(file, programReference);
        return node;
    }

    function getSourceFile(fileName) {
        let file = files.get(fileName);
        if (file) {
            filePrograms.set(file, programReference);
            return file;
        }
        const response = graph("getSourceFile", { fileName });
        if (!response) return undefined;
        file = files.get(response.fileName);
        if (file) {
            filePrograms.set(file, programReference);
            return file;
        }
        file = materializeSourceFile(channel.instance, response);
        // A bundled library has no host version, as a classic host has none for a file it does not own.
        if (file.resolvedPath === undefined) file.version = undefined;
        files.set(response.fileName, file);
        metadata.set(file, response);
        filePrograms.set(file, programReference);
        return file;
    }

    // Classic `resolvedModules`, `resolvedTypeReferenceDirectiveNames`,
    // `getAutomaticTypeDirectiveResolutions` and `resolvedLibReferences`, read once.
    function resolutions() {
        if (lease.resolutions) return lease.resolutions;
        const response = graph("getResolutions");
        const objects = response.resolutions;
        const caches = entries => {
            const cache = createModeAwareCache();
            for (const [name, mode, index] of entries) cache.set(name, mode ?? undefined, objects[index]);
            return cache;
        };
        const libraries = new Map(response.libraries.map(([libFileName, actual, replaced]) => [libFileName, {
            resolution: { resolvedModule: replaced ? { resolvedFileName: actual, extension: ".d.ts", isExternalLibraryImport: true, resolvedUsingTsExtension: false } : undefined },
            actual,
        }]));
        return lease.resolutions = {
            modules: response.modules.length ? new Map(response.modules.map(([path, entries]) => [path, caches(entries)])) : undefined,
            typeReferences: response.typeReferences.length ? new Map(response.typeReferences.map(([path, entries]) => [path, caches(entries)])) : undefined,
            automatic: caches(response.automatic),
            libraries: libraries.size ? libraries : undefined,
        };
    }

    function forEachResolution(resolutionCache, callback, file) {
        if (file) resolutionCache?.get(file.path)?.forEach((resolution, name, mode) => callback(resolution, name, mode, file.path));
        else resolutionCache?.forEach((resolutions, filePath) => resolutions.forEach((resolution, name, mode) => callback(resolution, name, mode, filePath)));
    }

    function getResolvedModule(file, moduleName, mode) {
        return resolutions().modules?.get(file.path)?.get(moduleName, mode);
    }

    function getResolvedTypeReferenceDirective(file, typeDirectiveName, mode) {
        return resolutions().typeReferences?.get(file.path)?.get(typeDirectiveName, mode);
    }

    function facts() {
        return lease.facts ??= graph("getProgramFacts");
    }

    // Classic `getPackagesMap`: a package maps to true when a resolution found its declarations.
    function getPackagesMap() {
        if (lease.packages) return lease.packages;
        const packages = new Map();
        program.forEachResolvedModule(({ resolvedModule }) => {
            if (resolvedModule?.packageId) packages.set(resolvedModule.packageId.name, resolvedModule.extension === ".d.ts" || !!packages.get(resolvedModule.packageId.name));
        });
        return lease.packages = packages;
    }

    function hasUnsupportedExtension(fileName) {
        const ts = classicNamespace();
        if (settings.allowNonTsExtensions || !ts.hasExtension(fileName)) return false;
        const canonicalFileName = program.getCanonicalFileName?.(fileName) ?? fileName;
        const extensions = ts.getSupportedExtensionsWithJsonIfResolveJsonModule(settings, ts.getSupportedExtensions(settings)).flat();
        return !extensions.some(extension => ts.fileExtensionIs(canonicalFileName, extension));
    }

    /** Classic `getSourceFileFromReferenceWorker` without diagnostics. */
    function getSourceFileFromReferenceWorker(fileName) {
        const ts = classicNamespace();
        const supportedExtensions = ts.getSupportedExtensions(settings);
        if (ts.hasExtension(fileName)) return hasUnsupportedExtension(fileName) ? undefined : getSourceFile(fileName);
        const sourceFileNoExtension = settings.allowNonTsExtensions && getSourceFile(fileName);
        if (sourceFileNoExtension) return sourceFileNoExtension;
        for (const extension of supportedExtensions[0]) {
            const file = getSourceFile(fileName + extension);
            if (file) return file;
        }
        return undefined;
    }

    function diagnostic(response) {
        const result = { ...response, file: response.fileName ? getSourceFile(response.fileName) : undefined };
        delete result.fileName;
        if (response.relatedInformation) result.relatedInformation = response.relatedInformation.map(diagnostic);
        return result;
    }

    lease.diagnostic = diagnostic;

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
        // Classic never looks for a file whose extension the options do not support, so it is not missing.
        getMissingFilePaths: () => new Map(graph("getMissingFilePaths").filter(([, fileName]) => !hasUnsupportedExtension(fileName))),
        getImpliedNodeFormatForEmit: file => graph("getImpliedNodeFormatForEmit", { fileName: file.fileName }) ?? undefined,
        getEmitModuleFormatOfFile: file => graph("getEmitModuleFormatOfFile", { fileName: file.fileName }) ?? undefined,
        getDefaultResolutionModeForFile: file => graph("getDefaultResolutionModeForFile", { fileName: file.fileName }) ?? undefined,
        getModeForUsageLocation: (file, usage) => graph("getModeForUsageLocation", { fileName: file.fileName, location: nodeHandle(usage) }) ?? undefined,
        getProjectReferences: () => undefined,
        getResolvedProjectReferences: () => undefined,
        get resolvedModules() { return resolutions().modules; },
        get resolvedTypeReferenceDirectiveNames() { return resolutions().typeReferences; },
        get resolvedLibReferences() { return resolutions().libraries; },
        getAutomaticTypeDirectiveResolutions: () => resolutions().automatic,
        getAutomaticTypeDirectiveNames: () => {
            const names = [];
            resolutions().automatic.forEach((_, name) => names.push(name));
            return names;
        },
        getResolvedModule,
        getResolvedModuleFromModuleSpecifier(moduleSpecifier, sourceFile) {
            sourceFile ??= getSourceFileOfNode(moduleSpecifier);
            if (!sourceFile) throw new Error("Debug Failure. `moduleSpecifier` must have a `SourceFile` ancestor. Use `program.getResolvedModule` instead to provide the containing file and resolution mode.");
            return getResolvedModule(sourceFile, moduleSpecifier.text, program.getModeForUsageLocation(sourceFile, moduleSpecifier));
        },
        getResolvedTypeReferenceDirective,
        getResolvedTypeReferenceDirectiveFromTypeReferenceDirective: (typeRef, sourceFile) => getResolvedTypeReferenceDirective(
            sourceFile, typeRef.fileName, typeRef.resolutionMode || program.getDefaultResolutionModeForFile(sourceFile)),
        getCurrentPackagesMap: getPackagesMap,
        typesPackageExists: packageName => getPackagesMap().has(classicNamespace().getTypesPackageName(packageName)),
        packageBundlesTypes: packageName => !!getPackagesMap().get(packageName),
        getCommonSourceDirectory: () => facts().commonSourceDirectory,
        // Classic makes a module resolution cache only for its own resolver; the Rust resolver keeps its own.
        getModuleResolutionCache: () => undefined,
        getFileIncludeReasons() {
            if (lease.includeReasons) return lease.includeReasons;
            const reasons = classicNamespace().createMultiMap();
            for (const [path, values] of graph("getFileIncludeReasons")) reasons.set(path, values);
            return lease.includeReasons = reasons;
        },
        getModeForResolutionAtIndex: (file, index) => graph("getModeForResolutionAtIndex", { fileName: file.fileName, index }) ?? undefined,
        get usesUriStyleNodeCoreModules() { return facts().usesUriStyleNodeCoreModules ?? undefined; },
        get redirectTargetsMap() {
            if (lease.redirectTargets) return lease.redirectTargets;
            const map = classicNamespace().createMultiMap();
            for (const [path, names] of facts().redirectTargets) for (const name of names) map.add(path, name);
            return lease.redirectTargets = map;
        },
        get sourceFileToPackageName() { return lease.sourceFileToPackageName ??= new Map(); },
        // Programs build without project references, so these have classic's answers for none.
        getCompilerOptionsForFile: () => settings,
        getRedirectFromSourceFile: () => undefined,
        getRedirectFromOutput: () => undefined,
        getResolvedProjectReferenceByPath: () => undefined,
        forEachResolvedProjectReference: () => undefined,
        isSourceOfProjectReferenceRedirect: () => false,
        getLibFileFromReference(ref) {
            const libFileName = classicNamespace().getLibFileNameFromLibReference(ref);
            const actualFileName = libFileName && resolutions().libraries?.get(libFileName)?.actual;
            return actualFileName !== undefined ? getSourceFile(actualFileName) : undefined;
        },
        getSourceFileFromReference: (referencingFile, ref) => getSourceFileFromReferenceWorker(classicNamespace().resolveTripleslashReference(ref.fileName, referencingFile.fileName)),
        forEachResolvedModule: (callback, file) => forEachResolution(resolutions().modules, callback, file),
        forEachResolvedTypeReferenceDirective: (callback, file) => forEachResolution(resolutions().typeReferences, callback, file),
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
    programInternals.set(program, { graph, diagnostic });
    const programReference = new WeakRef(program);
    cache.set(handle, programReference);
    return program;
}

/**
 * Releases a program of a channel without a releaser of its own (the private host bridge,
 * whose host does not reach its programs). Module scope keeps the program's context out.
 */
/** Classic `getSourceFileOfNode`. */
function getSourceFileOfNode(node) {
    while (node && node.kind !== SyntaxKind.SourceFile) node = node.parent;
    return node;
}

function programReleaser(channel, handle) {
    return () => channel.releaseProgram(handle);
}
