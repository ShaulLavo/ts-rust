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
    let projectVersion;
    let disposed = false;
    let synchronizing = false;
    let channel;
    let selectedGeneration;
    let nextSnapshot = 0;
    const generations = new Map();
    const sources = new Set();
    let filesystemFacts = { stats: new Map(), directories: new Map(), realpaths: new Map() };

    function capture(path, previous) {
        const version = host.getScriptVersion(path);
        const scriptKind = host.getScriptKind?.(path) ?? ScriptKind.Unknown;
        if (typeof version !== "string" || typeof ScriptKind[scriptKind] !== "string") throw new TypeError("script metadata must have a version string and a known script kind");
        if (previous && previous.version === version && previous.scriptKind === scriptKind) return previous;
        const snapshot = host.getScriptSnapshot(path);
        const text = snapshot === undefined ? host.readFile(path) : snapshot.getText(0, snapshot.getLength());
        if (nextSnapshot === 0xffffffff) throw new RangeError("source snapshot identity exhausted");
        return { version, snapshot, text, scriptKind, identity: ++nextSnapshot };
    }

    function readFile(path) {
        if (selectedGeneration) return selectedGeneration.files.get(path);
        let record = snapshots.get(path);
        if (!record) {
            record = capture(path);
            snapshots.set(path, record);
            if (record.text !== undefined) files.set(path, record.text);
        }
        return record.text;
    }

    const fs = {
        ...memory,
        readFile,
        sourceMetadata(path) {
            let record = selectedGeneration ? selectedGeneration.snapshots.get(path) : snapshots.get(path);
            if (!record && !selectedGeneration) {
                record = capture(path);
                snapshots.set(path, record);
                if (record.text !== undefined) files.set(path, record.text);
            }
            if (!record) return undefined;
            return { snapshot: record.identity, version: Array.from({ length: record.version.length }, (_, index) => record.version.charCodeAt(index)), scriptKind: ScriptKind[record.scriptKind] };
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
            if (known) return known;
            if (host.directoryExists?.(path)) return { isDirectory: true, size: 0 };
            if (!host.fileExists(path)) return undefined;
            const text = readFile(path);
            return text === undefined ? undefined : { isDirectory: false, size: encodeWtf8(text).length };
    }

    function readDirectory(path) {
            const known = memory.readDirectory(path);
            const files = host.readDirectory?.(path);
            const directories = host.getDirectories?.(path);
            if (!known && !files && !directories && !host.directoryExists?.(path)) return undefined;
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
        const names = host.getScriptFileNames();
        const args = argumentsForSettings(host.getCompilationSettings(), names);
        const nextKey = JSON.stringify(args);
        const nextProjectVersion = host.getProjectVersion?.();
        const projectChanged = nextProjectVersion !== projectVersion;
        const nextRoots = new Set(names);
        const nextSnapshots = new Map();
        let changed = nextKey !== argsKey || projectChanged;
        for (const path of snapshots.keys()) {
            if (roots.has(path) && !nextRoots.has(path)) continue;
            const previous = snapshots.get(path);
            const record = capture(path, previous);
            nextSnapshots.set(path, record);
            if (record !== previous) changed = true;
        }
        for (const path of names) {
            if (nextSnapshots.has(path)) continue;
            nextSnapshots.set(path, capture(path));
            changed = true;
        }
        if (!changed) return args;
        channel?.call({ action: "configure", args });
        roots = nextRoots;
        snapshots = nextSnapshots;
        argsKey = nextKey;
        projectVersion = nextProjectVersion;
        files.clear();
        filesystemFacts = { stats: new Map(), directories: new Map(), realpaths: new Map() };
        for (const [path, record] of snapshots) {
            if (record.text !== undefined) files.set(path, record.text);
        }
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
