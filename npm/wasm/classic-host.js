import { memoryFileSystem } from "./core.js";
import { createServiceChannel } from "./service-channel.js";
import { encodeWtf8 } from "./wtf8.js";
import { ScriptKind } from "./classic-enums.js";

/** Private host bridge; the classic facade supplies compiler-option translation. */
export function createHostServiceChannel(module, host, argumentsForSettings) {
    let roots = new Set();
    let snapshots = new Map();
    const files = new Map();
    const memory = memoryFileSystem(files);
    let argsKey;
    let currentArgs;
    let lastTypeRootsVersion = 0;
    let previousSnapshots = new Map();
    let absentFiles = new Set();
    let projectVersion;
    let disposed = false;
    let synchronizing = false;
    let channel;
    let selectedGeneration;
    let nextSnapshot = 0;
    const generations = new Map();
    const sources = new Set();
    let filesystemFacts = { stats: new Map(), directories: new Map(), realpaths: new Map() };

    function metadata(path) {
        const version = host.getScriptVersion(path);
        const scriptKind = host.getScriptKind?.(path) ?? ScriptKind.Unknown;
        if (typeof version !== "string" || typeof ScriptKind[scriptKind] !== "string") throw new TypeError("script metadata must have a version string and a known script kind");
        return { version, scriptKind };
    }

    function unchanged(record, current) {
        return record.version === current.version && record.scriptKind === current.scriptKind;
    }

    /** TypeScript reads every loaded file's snapshot on each build and keeps the old parse for an unchanged version. */
    function capture(path) {
        const current = metadata(path);
        const snapshot = host.getScriptSnapshot(path);
        if (snapshot === undefined) return { ...current, text: undefined };
        const previous = previousSnapshots.get(path);
        if (previous?.text !== undefined && unchanged(previous, current)) return previous;
        if (nextSnapshot === 0xffffffff) throw new RangeError("source snapshot identity exhausted");
        return { ...current, snapshot, text: snapshot.getText(0, snapshot.getLength()), identity: ++nextSnapshot };
    }

    function record(path) {
        let found = snapshots.get(path);
        if (!found) {
            found = capture(path);
            snapshots.set(path, found);
            if (found.text !== undefined) files.set(path, found.text);
        }
        return found;
    }

    function readFile(path) {
        if (selectedGeneration) return selectedGeneration.files.get(path);
        return record(path).text;
    }

    const fs = {
        ...memory,
        readFile,
        sourceMetadata(path) {
            const found = selectedGeneration ? selectedGeneration.snapshots.get(path) : record(path);
            if (found?.text === undefined) return undefined;
            return { snapshot: found.identity, version: Array.from({ length: found.version.length }, (_, index) => found.version.charCodeAt(index)), scriptKind: ScriptKind[found.scriptKind] };
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

    function stat(path) {
            const known = memory.stat(path);
            if (known?.isDirectory) return known;
            if (roots.has(path) || host.fileExists(path)) {
                const text = readFile(path);
                return text === undefined ? undefined : { isDirectory: false, size: encodeWtf8(text).length };
            }
            absentFiles.add(path);
            return directoryProbablyExists(path) ? { isDirectory: true, size: 0 } : undefined;
    }

    function directoryProbablyExists(path) {
            return !host.directoryExists || host.directoryExists(path);
    }

    function readDirectory(path) {
            const known = memory.readDirectory(path);
            const files = host.readDirectory?.(path);
            const directories = host.getDirectories?.(path);
            if (!known && !files && !directories && !directoryProbablyExists(path)) return undefined;
            const entries = new Map((known ?? []).map(entry => [entry.name, entry]));
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
        let changed = typeRootsVersion !== lastTypeRootsVersion;
        lastTypeRootsVersion = typeRootsVersion;
        const names = host.getScriptFileNames();
        const args = argumentsForSettings(host.getCompilationSettings(), names);
        const nextKey = JSON.stringify(args);
        changed ||= nextKey !== argsKey || names.some(path => !snapshots.has(path)) || host.hasChangedAutomaticTypeDirectiveNames?.() === true;
        if (!changed && absentFiles.size) {
            for (const path of channel.call({ action: "missingFiles", paths: Array.from(absentFiles) })) {
                if (changed) break;
                changed = host.fileExists(path);
            }
        }
        for (const [path, found] of snapshots) {
            if (changed) break;
            if (found.text === undefined) changed = host.fileExists(path);
            else changed = !unchanged(found, metadata(path)) || host.hasInvalidatedResolutions?.(path) === true;
        }
        if (!changed) return currentArgs = args;
        channel?.call({ action: "configure", args });
        roots = new Set(names);
        previousSnapshots = snapshots;
        snapshots = new Map();
        absentFiles = new Set();
        argsKey = nextKey;
        currentArgs = args;
        files.clear();
        filesystemFacts = { stats: new Map(), directories: new Map(), realpaths: new Map() };
        return args;
    }

    const args = synchronize();
    channel = createServiceChannel(module, {
        args, fs, cwd: host.getCurrentDirectory(), caseInsensitive: host.useCaseSensitiveFileNames?.() === false,
    });
    return {
        getProgram() {
            if (disposed) throw new Error("language service is disposed");
            synchronize();
            const program = channel.call({ action: "getProgram" });
            if (!generations.has(program)) {
                const generationFiles = new Map(files);
                generations.set(program, { files: generationFiles, snapshots: new Map(snapshots), memory: memoryFileSystem(generationFiles), facts: filesystemFacts });
            }
            return program;
        },
        graph(program, method, params = {}) {
            if (!generations.has(program)) throw new Error("program handle has been released");
            const previous = selectedGeneration;
            selectedGeneration = generations.get(program);
            try {
                const response = channel.call({ action: "graph", program, method, ...params });
                rememberSources(response);
                return response;
            }
            finally { selectedGeneration = previous; }
        },
        releaseProgram(program) {
            if (!generations.has(program)) return;
            if (channel.isAlive()) channel.call({ action: "releaseProgram", program });
            generations.delete(program);
            closeUnreferencedChannel();
        },
        source(source) {
            const result = channel.call({ action: "source", source });
            sources.add(source);
            return result;
        },
        releaseSource(source) {
            if (!sources.delete(source)) return;
            if (channel.isAlive()) channel.call({ action: "releaseSource", source });
            closeUnreferencedChannel();
        },
        request(method, params) {
            if (disposed) throw new Error("language service is disposed");
            synchronize();
            return channel.call({ action: "request", method, params });
        },
        dispose() {
            if (synchronizing) throw new Error("language service cannot dispose during host synchronization");
            if (disposed) return;
            if (channel.isAlive()) channel.call({ action: "retire" });
            else {
                generations.clear();
                sources.clear();
                channel.dispose();
            }
            disposed = true;
            snapshots.clear();
            previousSnapshots.clear();
            absentFiles.clear();
            files.clear();
            closeUnreferencedChannel();
        },
    };

    function closeUnreferencedChannel() {
        if (disposed && generations.size === 0 && sources.size === 0) channel.dispose();
    }

    function rememberSources(value) {
        if (!value || typeof value !== "object") return;
        if (value.source && value.data) {
            sources.add(value.source);
            return;
        }
        if (value.$node) {
            sources.add(value.$node.source);
            return;
        }
        for (const child of Object.values(value)) rememberSources(child);
    }
}
