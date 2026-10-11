import { classicNamespace, compiledModule } from "./classic-module.js";
import { createServiceChannel } from "./service-channel.js";
import { createProgramGraph, programInternals } from "./classic-program.js";
import { sourceFileLease } from "./classic-source-files.js";
import { compilerOptionsToJson } from "./classic-compiler-options.js";
import { createGetCanonicalFileName, getDirectoryPath } from "./classic-paths.js";
import { ScriptTarget } from "./classic-enums.js";
import { fixedExternalModuleIndicator, getEmitScriptTarget, sourceFileOptionsChanged, withRequestedPath } from "./classic-registry.js";

/**
 * TypeScript 6.0.3 `createProgram` over a classic `CompilerHost`, built by the Rust compiler.
 * The host supplies every non-bundled source file through `getSourceFile` or
 * `getSourceFileByPath`; those objects become the program's source files.
 */
export function createProgram(rootNamesOrOptions, options, host, oldProgram, configFileParsingDiagnostics) {
    const createProgramOptions = Array.isArray(rootNamesOrOptions)
        ? { rootNames: rootNamesOrOptions, options, host, oldProgram, configFileParsingDiagnostics }
        : rootNamesOrOptions;
    ({ options, host, oldProgram } = createProgramOptions);
    const rootNames = Array.from(createProgramOptions.rootNames);
    if (!host) throw new TypeError("createProgram needs a compiler host");
    const shouldCreateNewSourceFile = oldProgram !== undefined && sourceFileOptionsChanged(oldProgram.getCompilerOptions(), options);
    const requested = new Map();
    const fs = {
        readFile: path => host.readFile(path),
        stat(path) {
            if (host.fileExists(path)) return { isDirectory: false, size: 0 };
            return !host.directoryExists || host.directoryExists(path) ? { isDirectory: true, size: 0 } : undefined;
        },
        readDirectory(path) {
            if (host.directoryExists && !host.directoryExists(path)) return undefined;
            const prefix = path.endsWith("/") ? path : `${path}/`;
            const entries = new Map();
            for (const directory of host.getDirectories?.(path) ?? []) {
                const name = directory.startsWith(prefix) ? directory.slice(prefix.length) : directory;
                entries.set(name, { name, kind: "directory" });
            }
            for (const file of host.readDirectory?.(path, undefined, undefined, undefined, 1) ?? []) {
                if (!file.startsWith(prefix) || file.includes("/", prefix.length)) continue;
                const name = file.slice(prefix.length);
                entries.set(name, { name, kind: "file" });
            }
            return Array.from(entries.values());
        },
        realpath: host.realpath && (path => host.realpath(path)),
        getSourceFile(request) {
            const sourceFileOptions = {
                languageVersion: getEmitScriptTarget(options),
                impliedNodeFormat: undefined,
                setExternalModuleIndicator: fixedExternalModuleIndicator(request.jsx, request.force),
                jsDocParsingMode: host.jsDocParsingMode,
            };
            // A document the host parses now keeps the program's path for the file.
            const file = withRequestedPath(request.fileName, request.path, () => host.getSourceFileByPath
                ? host.getSourceFileByPath(request.fileName, request.path, sourceFileOptions, undefined, shouldCreateNewSourceFile)
                : host.getSourceFile(request.fileName, sourceFileOptions, undefined, shouldCreateNewSourceFile));
            if (!file) return undefined;
            const lease = sourceFileLease(file, channel.instance);
            if (lease === undefined) throw new TypeError("the compiler host returned a source file this compiler does not own");
            file.fileName = request.fileName;
            file.path = request.path;
            file.resolvedPath = request.path;
            file.originalFileName = request.fileName;
            requested.set(request.path, file);
            return lease;
        },
    };
    const channel = createServiceChannel(compiledModule(), {
        fs, cwd: host.getCurrentDirectory(), caseInsensitive: !host.useCaseSensitiveFileNames(), documents: true,
    });
    let handle;
    try {
        // Classic `defaultLibraryPath`: the host supplies library files like any other file.
        const defaultLibraryPath = host.getDefaultLibLocation ? host.getDefaultLibLocation() : getDirectoryPath(host.getDefaultLibFileName(options));
        const settings = compilerOptionsToJson(options);
        // Classic 6.0.3 computes an unset target as LatestStandard, ES2025; the port's is ES2026.
        if (options.target === undefined) settings.target = compilerOptionsToJson({ target: ScriptTarget.ES2025 }).target;
        channel.call({ action: "configureProgram", rootNames, options: settings, defaultLibraryPath });
        handle = channel.call({ action: "getProgram" });
    } catch (error) {
        channel.dispose();
        throw error;
    }
    const graphChannel = {
        instance: channel.instance,
        graph: (program, method, params = {}) => channel.call({ action: "graph", program, method, ...params }),
        releaseProgram(program) {
            if (!channel.isAlive()) return;
            channel.call({ action: "releaseProgram", program });
            channel.dispose();
        },
        releaser: program => channel.closingReleaser(program),
    };
    const program = createProgramGraph(graphChannel, handle, options);
    const projectReferences = createProgramOptions.projectReferences;
    program.getProjectReferences = () => projectReferences;
    addHostMembers(program, host, options);
    releaseOldSourceFiles(oldProgram, host, shouldCreateNewSourceFile, requested);
    return program;
}

/** Program members classic `createProgram` takes from its compiler host. */
function addHostMembers(program, host, options) {
    const currentDirectory = host.getCurrentDirectory();
    const getCanonicalFileName = createGetCanonicalFileName(host.useCaseSensitiveFileNames());
    let symlinks;
    Object.assign(program, {
        // Classic `Program.emit` on the Rust emitter. Custom transformers work on classic syntax
        // trees, which the Rust emitter never builds, so a call with any is refused.
        emit(targetSourceFile, writeFile, _cancellationToken, emitOnlyDtsFiles, customTransformers, forceDtsEmit) {
            if (customTransformers && ["before", "after", "afterDeclarations"].some(phase => customTransformers[phase]?.length)) {
                throw new Error("Custom transformers are not supported: the Rust emitter does not build classic syntax trees for them to transform.");
            }
            const { graph, diagnostic } = programInternals.get(program);
            const result = graph("emit", { fileName: targetSourceFile?.fileName, emitOnlyDts: !!emitOnlyDtsFiles, forceDtsEmit: !!forceDtsEmit });
            const write = writeFile ?? host.writeFile?.bind(host);
            const diagnostics = result.diagnostics.map(diagnostic);
            // Classic combines a relative `outDir` or `declarationDir` with the output's path as
            // written; the port resolves them against the current directory first.
            const ts = classicNamespace();
            const relativeDirectories = [options.outDir, options.declarationDir].filter(directory => directory && !ts.isRootedDiskPath(directory))
                .map(directory => [ts.ensureTrailingDirectorySeparator(ts.getNormalizedAbsolutePath(directory, currentDirectory)), directory]);
            const classicName = fileName => {
                const match = relativeDirectories.find(([absolute]) => fileName.startsWith(absolute));
                return match ? ts.combinePaths(match[1], fileName.slice(match[0].length)) : fileName;
            };
            for (const [outputName, text, sourceFileName] of result.writes) {
                const fileName = classicName(outputName);
                const sourceFiles = sourceFileName === null ? [] : [program.getSourceFile(sourceFileName)].filter(file => file !== undefined);
                write?.(fileName, text, !!options.emitBOM, message => {
                    diagnostics.push(classicNamespace().createCompilerDiagnostic(classicNamespace().Diagnostics.Could_not_write_file_0_Colon_1, fileName, message));
                }, sourceFiles, { diagnostics: [] });
            }
            return { emitSkipped: result.emitSkipped, diagnostics, emittedFiles: options.listEmittedFiles ? result.emittedFiles.map(classicName) : undefined };
        },
        useCaseSensitiveFileNames: () => host.useCaseSensitiveFileNames(),
        getCanonicalFileName,
        // Classic's `fileExists` without project references; it then has no `directoryExists`.
        fileExists: fileName => host.fileExists(fileName),
        readFile: host.readFile.bind(host),
        directoryExists: undefined,
        realpath: host.realpath?.bind(host),
        getGlobalTypingsCacheLocation: host.getGlobalTypingsCacheLocation?.bind(host),
        getSymlinkCache() {
            if (host.getSymlinkCache) return host.getSymlinkCache();
            const ts = classicNamespace();
            symlinks ??= ts.createSymlinkCache(currentDirectory, getCanonicalFileName);
            if (!symlinks.hasProcessedResolutions()) {
                symlinks.setSymlinksFromResolutions(program.forEachResolvedModule, program.forEachResolvedTypeReferenceDirective, program.getAutomaticTypeDirectiveResolutions());
            }
            return symlinks;
        },
        isEmittedFile(file) {
            if (options.noEmit) return false;
            const ts = classicNamespace();
            const filePath = ts.toPath(file, currentDirectory, getCanonicalFileName);
            if (program.getSourceFileByPath(filePath)) return false;
            const ignoreCase = !host.useCaseSensitiveFileNames();
            const isSameFile = (file1, file2) => ts.comparePaths(file1, file2, currentDirectory, ignoreCase) === 0;
            const out = options.outFile;
            if (out) return isSameFile(filePath, out) || isSameFile(filePath, ts.removeFileExtension(out) + ".d.ts");
            if (options.declarationDir && ts.containsPath(options.declarationDir, filePath, currentDirectory, ignoreCase)) return true;
            if (options.outDir) return ts.containsPath(options.outDir, filePath, currentDirectory, ignoreCase);
            if (ts.fileExtensionIsOneOf(filePath, ts.supportedJSExtensionsFlat) || ts.isDeclarationFileName(filePath)) {
                const filePathWithoutExtension = ts.removeFileExtension(filePath);
                return !!program.getSourceFileByPath(filePathWithoutExtension + ".ts") || !!program.getSourceFileByPath(filePathWithoutExtension + ".tsx");
            }
            return false;
        },
    });
}

/** `createProgram` releases the old program's files that the new program does not reuse. */
function releaseOldSourceFiles(oldProgram, host, shouldCreateNewSourceFile, files) {
    if (!oldProgram || !host.onReleaseOldSourceFile) return;
    for (const oldSourceFile of oldProgram.getSourceFiles()) {
        // Bundled libraries never came from the host.
        if (oldSourceFile.resolvedPath === undefined) continue;
        const newFile = files.get(oldSourceFile.resolvedPath);
        if (shouldCreateNewSourceFile || !newFile || newFile.impliedNodeFormat !== oldSourceFile.impliedNodeFormat
            || (oldSourceFile.resolvedPath === oldSourceFile.path && newFile.resolvedPath !== oldSourceFile.path)) {
            host.onReleaseOldSourceFile(oldSourceFile, oldProgram.getCompilerOptions(), files.has(oldSourceFile.path), newFile);
        }
    }
}
