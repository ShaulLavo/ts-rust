import { compiledModule } from "./classic-module.js";
import { createServiceChannel } from "./service-channel.js";
import { createProgramGraph } from "./classic-program.js";
import { sourceFileLease } from "./classic-source-files.js";
import { compilerOptionsToJson } from "./classic-compiler-options.js";
import { fixedExternalModuleIndicator, getEmitScriptTarget, sourceFileOptionsChanged } from "./classic-registry.js";

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
            const file = host.getSourceFileByPath
                ? host.getSourceFileByPath(request.fileName, request.path, sourceFileOptions, undefined, shouldCreateNewSourceFile)
                : host.getSourceFile(request.fileName, sourceFileOptions, undefined, shouldCreateNewSourceFile);
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
        channel.call({ action: "configureProgram", rootNames, options: compilerOptionsToJson(options) });
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
    };
    const program = createProgramGraph(graphChannel, handle, options);
    const projectReferences = createProgramOptions.projectReferences;
    program.getProjectReferences = () => projectReferences;
    releaseOldSourceFiles(oldProgram, host, shouldCreateNewSourceFile, requested);
    return program;
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
