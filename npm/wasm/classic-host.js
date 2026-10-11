import { memoryFileSystem } from "./core.js";
import { createServiceChannel } from "./service-channel.js";
import { ScriptKind } from "./classic-enums.js";
import { sourceFileLease } from "./classic-source-files.js";
import { createGetCanonicalFileName, toPath } from "./classic-paths.js";
import { compiledModuleOrUndefined, useCompiledModule } from "./classic-module.js";
import { createDocumentRegistry, ensureScriptKind, sourceFileOptionsChanged, fixedExternalModuleIndicator, getEmitScriptTarget, withRequestedPath } from "./classic-registry.js";

/**
 * Private host bridge; the classic facade supplies compiler-option translation.
 * Source files come from `documentRegistry` as classic `getOrCreateSourceFileByPath`
 * acquires them, so services sharing a registry share their source files.
 */
export function createHostServiceChannel(module, host, argumentsForSettings, documentRegistry) {
    if (!compiledModuleOrUndefined()) useCompiledModule(module);
    const useCaseSensitiveFileNames = host.useCaseSensitiveFileNames?.() ?? false;
    const currentDirectory = host.getCurrentDirectory();
    const getCanonicalFileName = createGetCanonicalFileName(useCaseSensitiveFileNames);
    documentRegistry ??= createDocumentRegistry(host.useCaseSensitiveFileNames && host.useCaseSensitiveFileNames(), currentDirectory, host.jsDocParsingMode);
    let roots = new Set();
    // The files of the current program: path -> { fileName, version, scriptKind, sourceFile } or { missing }.
    let loaded = new Map();
    let settings;
    let settingsKey;
    let building;
    let argsKey;
    let currentArgs;
    let lastTypeRootsVersion = 0;
    let absentFiles = new Set();
    let projectVersion;
    let disposed = false;
    let synchronizing = false;
    let channel;
    let selectedGeneration;
    const generations = new Map();
    let filesystemFacts = { stats: new Map(), fileExists: new Map(), directoryExists: new Map(), directories: new Map(), realpaths: new Map(), reads: new Map() };

    function metadata(path) {
        const version = host.getScriptVersion(path);
        const scriptKind = host.getScriptKind?.(path) ?? ScriptKind.Unknown;
        if (typeof version !== "string" || typeof ScriptKind[scriptKind] !== "string") throw new TypeError("script metadata must have a version string and a known script kind");
        return { version, scriptKind };
    }

    function unchanged(record, current) {
        return record.version === current.version && record.scriptKind === current.scriptKind;
    }

    /** `getOrCreateSourceFileByPath` of `synchronizeHostDataWorker`. */
    function getSourceFile(request) {
        const fileName = request.fileName;
        const path = toPath(fileName, currentDirectory, getCanonicalFileName);
        const cached = building.files.get(path);
        if (cached) return sourceFileLease(cached.sourceFile, channel.instance);
        const scriptSnapshot = host.getScriptSnapshot(fileName);
        if (!scriptSnapshot) {
            building.files.set(path, { fileName, missing: true });
            return undefined;
        }
        const { version } = metadata(fileName);
        const scriptKind = ensureScriptKind(fileName, host.getScriptKind?.(fileName));
        const options = {
            languageVersion: getEmitScriptTarget(settings),
            impliedNodeFormat: undefined,
            setExternalModuleIndicator: fixedExternalModuleIndicator(request.jsx, request.force),
            jsDocParsingMode: host.jsDocParsingMode,
        };
        const sourceFile = withRequestedPath(fileName, request.path, () => {
            const old = building.reuse ? loaded.get(path)?.sourceFile : undefined;
            if (old) {
                if (scriptKind === old.scriptKind || building.releasedScriptKinds.has(old.resolvedPath)) {
                    return documentRegistry.updateDocumentWithKey(fileName, path, host, settingsKey, scriptSnapshot, version, scriptKind, options);
                }
                documentRegistry.releaseDocumentWithKey(old.resolvedPath, building.oldKey, old.scriptKind, old.impliedNodeFormat);
                building.releasedScriptKinds.add(old.resolvedPath);
            }
            return documentRegistry.acquireDocumentWithKey(fileName, path, host, settingsKey, scriptSnapshot, version, scriptKind, options);
        });
        sourceFile.path = path;
        sourceFile.resolvedPath = path;
        sourceFile.originalFileName = fileName;
        building.files.set(path, Object.assign(metadata(fileName), { fileName, sourceFile }));
        const lease = sourceFileLease(sourceFile, channel.instance);
        if (lease === undefined) throw new TypeError("the document registry returned a source file this compiler does not own");
        return lease;
    }

    function readFile(path) {
        if (selectedGeneration) return selectedGeneration.facts.reads.get(path);
        const result = host.readFile?.(path);
        filesystemFacts.reads.set(path, result);
        return result;
    }

    const fs = {
        readFile,
        getSourceFile(request) {
            // Rust also rebuilds on its own after a host exception left it without a program.
            building ??= newBuild(settings, true);
            building.started = true;
            return getSourceFile(request);
        },
        fileExists(path) {
            if (selectedGeneration) return selectedGeneration.facts.fileExists.get(path) ?? false;
            const result = roots.has(path) || host.fileExists(path);
            filesystemFacts.fileExists.set(path, result);
            if (!result) absentFiles.add(path);
            return result;
        },
        directoryExists(path) {
            if (selectedGeneration) return selectedGeneration.facts.directoryExists.get(path) ?? !host.directoryExists;
            const result = directoryProbablyExists(path);
            filesystemFacts.directoryExists.set(path, result);
            return result;
        },
        stat(path) {
            if (selectedGeneration) return selectedGeneration.facts.stats.get(path) ?? selectedGeneration.memory.stat(path);
            const result = stat(path);
            filesystemFacts.stats.set(path, result);
            return result;
        },
        realpath: host.realpath && (path => {
            if (selectedGeneration) return selectedGeneration.facts.realpaths.get(path) ?? selectedGeneration.memory.realpath(path);
            const result = host.realpath(path);
            filesystemFacts.realpaths.set(path, result);
            return result;
        }),
        readDirectory(path) {
            if (selectedGeneration) return selectedGeneration.facts.directories.get(path) ?? selectedGeneration.memory.readDirectory(path);
            const result = readDirectory(path);
            filesystemFacts.directories.set(path, result);
            return result;
        },
    };
    const empty = memoryFileSystem(new Map());

    function stat(path) {
        if (roots.has(path) || host.fileExists(path)) return { isDirectory: false, size: 0 };
        absentFiles.add(path);
        return directoryProbablyExists(path) ? { isDirectory: true, size: 0 } : undefined;
    }

    function directoryProbablyExists(path) {
        return !host.directoryExists || host.directoryExists(path);
    }

    function readDirectory(path) {
        const files = host.readDirectory?.(path);
        const directories = host.getDirectories?.(path);
        if (!files && !directories && !directoryProbablyExists(path)) return undefined;
        const entries = new Map();
        const prefix = path.endsWith("/") ? path : `${path}/`;
        for (const file of files ?? []) {
            if (!file.startsWith(prefix)) continue;
            const relative = file.slice(prefix.length);
            const slash = relative.indexOf("/");
            const name = slash < 0 ? relative : relative.slice(0, slash);
            entries.set(name, { name, kind: slash < 0 ? "file" : "directory" });
        }
        for (const directory of directories ?? []) {
            const name = directory.startsWith(prefix) ? directory.slice(prefix.length) : directory;
            entries.set(name, { name, kind: "directory" });
        }
        return Array.from(entries.values());
    }

    function synchronize() {
        if (synchronizing) throw new Error("language service cannot reenter host synchronization");
        synchronizing = true;
        try { return collectChanges(); }
        finally { synchronizing = false; }
    }

    function collectChanges() {
        if (host.getProjectVersion) {
            const hostProjectVersion = host.getProjectVersion();
            if (hostProjectVersion && hostProjectVersion === projectVersion && !host.hasChangedAutomaticTypeDirectiveNames?.()) return currentArgs;
            if (hostProjectVersion) projectVersion = hostProjectVersion;
        }
        const typeRootsVersion = host.getTypeRootsVersion?.() ?? 0;
        // A new type-roots version drops the old program, so its files are neither updated nor released.
        const dropped = typeRootsVersion !== lastTypeRootsVersion;
        let changed = dropped;
        lastTypeRootsVersion = typeRootsVersion;
        const names = host.getScriptFileNames();
        const nextSettings = host.getCompilationSettings();
        const args = argumentsForSettings(nextSettings, names);
        const nextKey = JSON.stringify(args);
        changed ||= nextKey !== argsKey || names.some(name => !loaded.has(toPath(name, currentDirectory, getCanonicalFileName))) || host.hasChangedAutomaticTypeDirectiveNames?.() === true;
        if (!changed && absentFiles.size) {
            for (const path of channel.call({ action: "missingFiles", paths: Array.from(absentFiles) })) {
                if (changed) break;
                changed = host.fileExists(path);
            }
        }
        for (const found of loaded.values()) {
            if (changed) break;
            if (found.missing) changed = host.fileExists(found.fileName);
            else changed = !unchanged(found, metadata(found.fileName)) || host.hasInvalidatedResolutions?.(found.sourceFile.path) === true;
        }
        if (!changed) return currentArgs = args;
        channel?.call({ action: "configure", args });
        roots = new Set(names);
        absentFiles = new Set();
        argsKey = nextKey;
        currentArgs = args;
        building = newBuild(nextSettings, !dropped);
        settings = nextSettings;
        settingsKey = documentRegistry.getKeyForCompilationSettings(settings);
        filesystemFacts = { stats: new Map(), fileExists: new Map(), directoryExists: new Map(), directories: new Map(), realpaths: new Map(), reads: new Map() };
        return args;
    }

    /** The build of `nextSettings`; `oldProgram` says whether the current program is its old program. */
    function newBuild(nextSettings, oldProgram) {
        const reuse = oldProgram && loaded.size > 0;
        return { files: new Map(), releasedScriptKinds: new Set(), oldKey: settingsKey, oldProgram: reuse,
            reuse: reuse && !sourceFileOptionsChanged(settings, nextSettings) };
    }

    /** A build ran: release the old program's documents the new one does not use, as `createProgram` does. */
    function finishBuild() {
        const previous = loaded;
        loaded = building.files;
        if (building.oldProgram) {
            for (const found of previous.values()) {
                if (found.missing) continue;
                const next = loaded.get(found.sourceFile.resolvedPath);
                if (building.reuse && next?.sourceFile && next.sourceFile.impliedNodeFormat === found.sourceFile.impliedNodeFormat) continue;
                documentRegistry.releaseDocumentWithKey(found.sourceFile.resolvedPath, building.oldKey, found.sourceFile.scriptKind, found.sourceFile.impliedNodeFormat);
            }
        }
        building = undefined;
    }

    /**
     * Runs a request that may build. A request that returns or fails in the
     * compiler has finished its build, so its documents replace the old ones.
     * After a host exception the next request builds again with them.
     */
    function build(request) {
        let finished = false;
        try {
            const result = channel.call(request);
            finished = true;
            return result;
        }
        catch (error) {
            finished = error.code !== undefined;
            throw error;
        }
        finally { if (finished && building?.started) finishBuild(); }
    }

    const args = synchronize();
    channel = createServiceChannel(module, {
        args, fs, cwd: currentDirectory, caseInsensitive: !useCaseSensitiveFileNames, documents: true,
    });
    return {
        instance: channel.instance,
        documentRegistry,
        getProgram() {
            if (disposed) throw new Error("language service is disposed");
            synchronize();
            const program = build({ action: "getProgram" });
            if (!generations.has(program)) {
                generations.set(program, { memory: empty, facts: filesystemFacts });
            }
            return program;
        },
        graph(program, method, params = {}) {
            if (!generations.has(program)) throw new Error("program handle has been released");
            const previous = selectedGeneration;
            selectedGeneration = generations.get(program);
            try { return channel.call({ action: "graph", program, method, ...params }); }
            finally { selectedGeneration = previous; }
        },
        releaseProgram(program) {
            if (!generations.has(program)) return;
            if (channel.isAlive()) channel.call({ action: "releaseProgram", program });
            generations.delete(program);
            closeUnreferencedChannel();
        },
        request(method, params) {
            if (disposed) throw new Error("language service is disposed");
            synchronize();
            return build({ action: "request", method, params });
        },
        dispose() {
            if (synchronizing) throw new Error("language service cannot dispose during host synchronization");
            if (disposed) return;
            if (channel.isAlive()) channel.call({ action: "retire" });
            else {
                generations.clear();
                channel.dispose();
            }
            disposed = true;
            for (const found of loaded.values()) {
                if (found.missing) continue;
                documentRegistry.releaseDocumentWithKey(found.sourceFile.resolvedPath, settingsKey, found.sourceFile.scriptKind, found.sourceFile.impliedNodeFormat);
            }
            loaded.clear();
            building = undefined;
            absentFiles.clear();
            closeUnreferencedChannel();
        },
    };

    function closeUnreferencedChannel() {
        if (disposed && generations.size === 0) channel.dispose();
    }
}
