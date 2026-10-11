// Apache-2.0. Ported from Microsoft TypeScript 6.0.3 (050880ce)
// src/services/documentRegistry.ts and the source-file helpers of
// src/services/services.ts and src/compiler/parser.ts. The registry's
// bookkeeping is unchanged; its two compiler entry points parse in Rust.

import { classicInstance } from "./classic-module.js";
import { materializeSourceFile, sourceFileLease } from "./classic-source-files.js";
import { createGetCanonicalFileName, fileExtensionIsOneOf, getNormalizedAbsolutePath, normalizePath, toPath } from "./classic-paths.js";

const ScriptKind = { Unknown: 0, JS: 1, JSX: 2, TS: 3, TSX: 4, External: 5, JSON: 6, Deferred: 7 };
const ScriptTarget = { JSON: 100 };
const ModuleKind = { CommonJS: 1, ES2015: 5, ES2020: 6, ES2022: 7, ESNext: 99, Node16: 100, NodeNext: 199 };
const ModuleDetectionKind = { Legacy: 1, Auto: 2, Force: 3 };
const ModuleResolutionKind = { Classic: 1, Node16: 3, NodeNext: 99, Bundler: 100 };
const JsxEmit = { ReactJSX: 4, ReactJSXDev: 5 };

// `sourceFileAffectingCompilerOptions` of src/compiler/commandLineParser.ts, in declaration order.
// None of these has `strictFlag` or `allowJsFlag`, so `getCompilerOptionValue` reads each directly.
const sourceFileAffectingCompilerOptions = ["target", "module", "jsx", "importHelpers", "alwaysStrict", "noFallthroughCasesInSwitch",
    "moduleResolution", "jsxImportSource", "allowUnusedLabels", "allowUnreachableCode", "moduleDetection"];

function debugFail(message) {
    throw new Error(`Debug Failure. ${message}`);
}

function compilerOptionValueToString(value) {
    if (value === null || typeof value !== "object") return "" + value;
    if (Array.isArray(value)) return `[${value.map(element => compilerOptionValueToString(element))?.join(",")}]`;
    let text = "{";
    for (const key in value) {
        if (Object.hasOwn(value, key)) text += `${key}: ${compilerOptionValueToString(value[key])}`;
    }
    return text + "}";
}

function getKeyForCompilationSettings(settings) {
    return sourceFileAffectingCompilerOptions.map(name => compilerOptionValueToString(settings[name])).join("|") + `|${settings.pathsBasePath}`;
}

function isJsonEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && isJsonEqual(a[key], b[key]));
}

/** `shouldProgramCreateNewSourceFiles`: a source-file-affecting option changed. */
export function sourceFileOptionsChanged(oldOptions, newOptions) {
    return oldOptions !== newOptions && sourceFileAffectingCompilerOptions.some(name => !isJsonEqual(oldOptions[name], newOptions[name]));
}

function getDocumentRegistryBucketKeyWithMode(key, mode) {
    return mode ? `${key}|${mode}` : key;
}

function getScriptKindFromFileName(fileName) {
    const extension = fileName.substr(fileName.lastIndexOf("."));
    switch (extension.toLowerCase()) {
        case ".js": case ".cjs": case ".mjs": return ScriptKind.JS;
        case ".jsx": return ScriptKind.JSX;
        case ".ts": case ".cts": case ".mts": return ScriptKind.TS;
        case ".tsx": return ScriptKind.TSX;
        case ".json": return ScriptKind.JSON;
        default: return ScriptKind.Unknown;
    }
}

function ensureScriptKind(fileName, scriptKind) {
    return scriptKind || getScriptKindFromFileName(fileName) || ScriptKind.TS;
}

function getEmitScriptTarget(options) {
    const target = options.target === 0 ? undefined : options.target;
    return target ?? 12;
}

function getEmitModuleKind(options) {
    if (typeof options.module === "number") return options.module;
    const target = getEmitScriptTarget(options);
    if (target === 99) return ModuleKind.ESNext;
    if (target >= 9) return ModuleKind.ES2022;
    if (target >= 7) return ModuleKind.ES2020;
    if (target >= 2) return ModuleKind.ES2015;
    return ModuleKind.CommonJS;
}

function getEmitModuleResolutionKind(options) {
    if (options.moduleResolution !== undefined) return options.moduleResolution;
    const moduleKind = getEmitModuleKind(options);
    switch (moduleKind) {
        case 0: case 2: case 3: case 4: return ModuleResolutionKind.Classic;
        case ModuleKind.NodeNext: return ModuleResolutionKind.NodeNext;
    }
    if (ModuleKind.Node16 <= moduleKind && moduleKind < ModuleKind.NodeNext) return ModuleResolutionKind.Node16;
    return ModuleResolutionKind.Bundler;
}

function getEmitModuleDetectionKind(options) {
    if (options.moduleDetection !== undefined) return options.moduleDetection;
    const moduleKind = getEmitModuleKind(options);
    return ModuleKind.Node16 <= moduleKind && moduleKind <= ModuleKind.NodeNext ? ModuleDetectionKind.Force : ModuleDetectionKind.Auto;
}

function isDeclarationFileName(fileName) {
    if (fileExtensionIsOneOf(fileName, [".d.ts", ".d.mts", ".d.cts"])) return true;
    if (!fileName.endsWith(".ts")) return false;
    const baseName = fileName.slice(fileName.lastIndexOf("/") + 1);
    return baseName.lastIndexOf(".d.") >= 0;
}

/** `getImpliedNodeFormatForFile`, with the package.json scope read through the host. */
function getImpliedNodeFormatForFile(fileName, host, options) {
    const moduleResolution = getEmitModuleResolutionKind(options);
    const lookup = ModuleResolutionKind.Node16 <= moduleResolution && moduleResolution <= ModuleResolutionKind.NodeNext || fileName.includes("/node_modules/");
    if (fileExtensionIsOneOf(fileName, [".d.mts", ".mts", ".mjs"])) return ModuleKind.ESNext;
    if (fileExtensionIsOneOf(fileName, [".d.cts", ".cts", ".cjs"])) return ModuleKind.CommonJS;
    if (!lookup || !fileExtensionIsOneOf(fileName, [".d.ts", ".ts", ".tsx", ".js", ".jsx"])) return undefined;
    return packageJsonType(fileName, host) === "module" ? ModuleKind.ESNext : ModuleKind.CommonJS;
}

function packageJsonType(fileName, host) {
    let directory = fileName.slice(0, fileName.lastIndexOf("/"));
    while (directory) {
        const packageJson = `${directory}/package.json`;
        if (host.fileExists?.(packageJson)) {
            try { return JSON.parse(host.readFile?.(packageJson) ?? "{}").type; }
            catch { return undefined; }
        }
        const parent = directory.slice(0, directory.lastIndexOf("/"));
        if (parent === directory) break;
        directory = parent;
    }
    return undefined;
}

/** The Rust form of a classic `setExternalModuleIndicator` callback, per file. */
const indicators = new WeakMap();

function impliedFormatForEmit(fileName, options, impliedNodeFormat) {
    const moduleKind = getEmitModuleKind(options);
    if (ModuleKind.Node16 <= moduleKind && moduleKind <= ModuleKind.NodeNext) return impliedNodeFormat;
    if (impliedNodeFormat === ModuleKind.CommonJS && fileExtensionIsOneOf(fileName, [".cjs", ".cts"])) return ModuleKind.CommonJS;
    if (impliedNodeFormat === ModuleKind.ESNext && fileExtensionIsOneOf(fileName, [".mjs", ".mts"])) return ModuleKind.ESNext;
    return undefined;
}

/** `getSetExternalModuleIndicator`: the callback carries its options so the Rust parser can apply them. */
export function getSetExternalModuleIndicator(options) {
    const callback = file => indicators.get(callback)(file.fileName, file.impliedNodeFormat);
    indicators.set(callback, (fileName, impliedNodeFormat) => {
        if (isDeclarationFileName(fileName)) return { jsx: false, force: false };
        switch (getEmitModuleDetectionKind(options)) {
            case ModuleDetectionKind.Force: return { jsx: false, force: true };
            case ModuleDetectionKind.Auto: return {
                jsx: options.jsx === JsxEmit.ReactJSX || options.jsx === JsxEmit.ReactJSXDev,
                force: impliedFormatForEmit(fileName, options, impliedNodeFormat) === ModuleKind.ESNext
                    || fileExtensionIsOneOf(fileName, [".cjs", ".cts", ".mjs", ".mts"]),
            };
            default: return { jsx: false, force: false };
        }
    });
    return callback;
}

/** A callback with the exact options a Rust program build asked for. */
export function fixedExternalModuleIndicator(jsx, force) {
    const callback = () => {};
    indicators.set(callback, () => ({ jsx, force }));
    return callback;
}

let pendingPath;

/** Runs `action` while a Rust build asks for `fileName` at `path`, so its parse keeps the program's path. */
export function withRequestedPath(fileName, path, action) {
    const previous = pendingPath;
    pendingPath = { fileName, path };
    try { return action(); }
    finally { pendingPath = previous; }
}

/** `createSourceFile` in Rust. Unknown `setExternalModuleIndicator` callbacks parse with the legacy rule. */
export function createSourceFile(fileName, sourceText, languageVersionOrOptions, setParentNodes = false, scriptKind) {
    return parseSourceFile(fileName, sourceText, languageVersionOrOptions, scriptKind);
}

function parseSourceFile(fileName, sourceText, languageVersionOrOptions, scriptKind, predecessor) {
    const options = typeof languageVersionOrOptions === "object" ? languageVersionOrOptions : { languageVersion: languageVersionOrOptions };
    const { languageVersion, setExternalModuleIndicator, impliedNodeFormat, jsDocParsingMode } = options;
    scriptKind = ensureScriptKind(fileName, languageVersion === ScriptTarget.JSON ? ScriptKind.JSON : scriptKind);
    const indicator = languageVersion === ScriptTarget.JSON ? undefined : indicators.get(setExternalModuleIndicator)?.(fileName, impliedNodeFormat);
    // The Rust parser takes absolute names: a relative name parses at the root and keeps its classic name.
    const classicName = normalizePath(fileName);
    const parseName = getNormalizedAbsolutePath(classicName, "/");
    const path = pendingPath?.fileName === fileName ? pendingPath.path : parseName;
    // `parseJsonText` parses every JSON file at ES2015.
    const resultVersion = scriptKind === ScriptKind.JSON ? 2 : languageVersion;
    const instance = classicInstance();
    const response = instance.parseDocument({
        fileName: parseName, path, scriptKind, languageVersion: resultVersion ?? 0, version: [],
        jsx: indicator?.jsx ?? false, force: indicator?.force ?? false, predecessor,
    }, sourceText);
    const file = materializeSourceFile(instance, response);
    if (classicName !== parseName) file.fileName = classicName;
    file.languageVersion = resultVersion;
    file.scriptKind = scriptKind;
    file.setExternalModuleIndicator = setExternalModuleIndicator;
    file.jsDocParsingMode = jsDocParsingMode;
    if (impliedNodeFormat !== undefined) file.impliedNodeFormat = impliedNodeFormat;
    return file;
}

function getSnapshotText(snapshot) {
    return snapshot.getText(0, snapshot.getLength());
}

function setSourceFileFields(sourceFile, scriptSnapshot, version) {
    sourceFile.version = version;
    sourceFile.scriptSnapshot = scriptSnapshot;
}

export function createLanguageServiceSourceFile(fileName, scriptSnapshot, scriptTargetOrOptions, version, setNodeParents, scriptKind) {
    const sourceFile = createSourceFile(fileName, getSnapshotText(scriptSnapshot), scriptTargetOrOptions, setNodeParents, scriptKind);
    setSourceFileFields(sourceFile, scriptSnapshot, version);
    return sourceFile;
}

/** The Rust parser has no incremental mode, so an edit parses the new text in full. */
export function updateLanguageServiceSourceFile(sourceFile, scriptSnapshot, version, textChangeRange, aggressiveChecks) {
    const options = {
        languageVersion: sourceFile.languageVersion,
        impliedNodeFormat: sourceFile.impliedNodeFormat,
        setExternalModuleIndicator: sourceFile.setExternalModuleIndicator,
        jsDocParsingMode: sourceFile.jsDocParsingMode,
    };
    if (textChangeRange && version !== sourceFile.version) {
        const start = textChangeRange.span.start;
        const end = start + textChangeRange.span.length;
        const prefix = start !== 0 ? sourceFile.text.substr(0, start) : "";
        const suffix = end !== sourceFile.text.length ? sourceFile.text.substr(end) : "";
        let newText;
        if (textChangeRange.newLength === 0) newText = prefix && suffix ? prefix + suffix : prefix || suffix;
        else {
            const changedText = scriptSnapshot.getText(start, start + textChangeRange.newLength);
            newText = prefix && suffix ? prefix + changedText + suffix : prefix ? prefix + changedText : changedText + suffix;
        }
        const newSourceFile = parseSourceFile(sourceFile.fileName, newText, options, sourceFile.scriptKind,
            sourceFileLease(sourceFile, classicInstance()));
        setSourceFileFields(newSourceFile, scriptSnapshot, version);
        newSourceFile.nameTable = undefined;
        if (sourceFile !== newSourceFile && sourceFile.scriptSnapshot) {
            if (sourceFile.scriptSnapshot.dispose) sourceFile.scriptSnapshot.dispose();
            sourceFile.scriptSnapshot = undefined;
        }
        return newSourceFile;
    }
    const newSourceFile = parseSourceFile(sourceFile.fileName, getSnapshotText(scriptSnapshot), options,
        sourceFile.scriptKind, sourceFileLease(sourceFile, classicInstance()));
    setSourceFileFields(newSourceFile, scriptSnapshot, version);
    return newSourceFile;
}

function isDocumentRegistryEntry(entry) {
    return !!entry.sourceFile;
}

export function createDocumentRegistry(useCaseSensitiveFileNames, currentDirectory, jsDocParsingMode) {
    return createDocumentRegistryInternal(useCaseSensitiveFileNames, currentDirectory, jsDocParsingMode);
}

export function createDocumentRegistryInternal(useCaseSensitiveFileNames, currentDirectory = "", jsDocParsingMode, externalCache) {
    const buckets = new Map();
    const getCanonicalFileName = createGetCanonicalFileName(!!useCaseSensitiveFileNames);

    function reportStats() {
        const bucketInfoArray = Array.from(buckets.keys()).filter(name => name && name.charAt(0) === "_").map(name => {
            const entries = buckets.get(name);
            const sourceFiles = [];
            entries.forEach((entry, name) => {
                if (isDocumentRegistryEntry(entry)) {
                    sourceFiles.push({ name, scriptKind: entry.sourceFile.scriptKind, refCount: entry.languageServiceRefCount });
                }
                else {
                    entry.forEach((value, scriptKind) => sourceFiles.push({ name, scriptKind, refCount: value.languageServiceRefCount }));
                }
            });
            sourceFiles.sort((x, y) => y.refCount - x.refCount);
            return { bucket: name, sourceFiles };
        });
        return JSON.stringify(bucketInfoArray, undefined, 2);
    }

    function getCompilationSettings(settingsOrHost) {
        if (typeof settingsOrHost.getCompilationSettings === "function") return settingsOrHost.getCompilationSettings();
        return settingsOrHost;
    }

    function acquireDocument(fileName, compilationSettings, scriptSnapshot, version, scriptKind, languageVersionOrOptions) {
        const path = toPath(fileName, currentDirectory, getCanonicalFileName);
        const key = getKeyForCompilationSettings(getCompilationSettings(compilationSettings));
        return acquireDocumentWithKey(fileName, path, compilationSettings, key, scriptSnapshot, version, scriptKind, languageVersionOrOptions);
    }

    function acquireDocumentWithKey(fileName, path, compilationSettings, key, scriptSnapshot, version, scriptKind, languageVersionOrOptions) {
        return acquireOrUpdateDocument(fileName, path, compilationSettings, key, scriptSnapshot, version, true, scriptKind, languageVersionOrOptions);
    }

    function updateDocument(fileName, compilationSettings, scriptSnapshot, version, scriptKind, languageVersionOrOptions) {
        const path = toPath(fileName, currentDirectory, getCanonicalFileName);
        const key = getKeyForCompilationSettings(getCompilationSettings(compilationSettings));
        return updateDocumentWithKey(fileName, path, compilationSettings, key, scriptSnapshot, version, scriptKind, languageVersionOrOptions);
    }

    function updateDocumentWithKey(fileName, path, compilationSettings, key, scriptSnapshot, version, scriptKind, languageVersionOrOptions) {
        return acquireOrUpdateDocument(fileName, path, getCompilationSettings(compilationSettings), key, scriptSnapshot, version, false, scriptKind, languageVersionOrOptions);
    }

    function getDocumentRegistryEntry(bucketEntry, scriptKind) {
        let entry;
        if (isDocumentRegistryEntry(bucketEntry)) entry = bucketEntry;
        else {
            if (scriptKind === undefined) debugFail("If there are more than one scriptKind's for same document the scriptKind should be provided");
            entry = bucketEntry.get(scriptKind);
        }
        if (!(scriptKind === undefined || !entry || entry.sourceFile.scriptKind === scriptKind)) {
            debugFail(`False expression: Script kind should match provided ScriptKind:${scriptKind} and sourceFile.scriptKind: ${entry?.sourceFile.scriptKind}, !entry: ${!entry}`);
        }
        return entry;
    }

    function acquireOrUpdateDocument(fileName, path, compilationSettingsOrHost, key, scriptSnapshot, version, acquiring, scriptKind, languageVersionOrOptions) {
        scriptKind = ensureScriptKind(fileName, scriptKind);
        const compilationSettings = getCompilationSettings(compilationSettingsOrHost);
        const host = compilationSettingsOrHost === compilationSettings ? undefined : compilationSettingsOrHost;
        const scriptTarget = scriptKind === ScriptKind.JSON ? ScriptTarget.JSON : getEmitScriptTarget(compilationSettings);
        const sourceFileOptions = typeof languageVersionOrOptions === "object" ?
            languageVersionOrOptions :
            {
                languageVersion: scriptTarget,
                impliedNodeFormat: host && getImpliedNodeFormatForFile(path, host, compilationSettings),
                setExternalModuleIndicator: getSetExternalModuleIndicator(compilationSettings),
                jsDocParsingMode,
            };
        sourceFileOptions.languageVersion = scriptTarget;
        if (jsDocParsingMode !== sourceFileOptions.jsDocParsingMode) {
            debugFail(`Expected ${sourceFileOptions.jsDocParsingMode} === ${jsDocParsingMode}. `);
        }
        const keyWithMode = getDocumentRegistryBucketKeyWithMode(key, sourceFileOptions.impliedNodeFormat);
        let bucket = buckets.get(keyWithMode);
        if (!bucket) {
            bucket = new Map();
            buckets.set(keyWithMode, bucket);
        }
        const bucketEntry = bucket.get(path);
        let entry = bucketEntry && getDocumentRegistryEntry(bucketEntry, scriptKind);
        if (!entry && externalCache) {
            const sourceFile = externalCache.getDocument(keyWithMode, path);
            if (sourceFile && sourceFile.scriptKind === scriptKind && sourceFile.text === getSnapshotText(scriptSnapshot)) {
                if (!acquiring) debugFail("False expression.");
                entry = { sourceFile, languageServiceRefCount: 0 };
                setBucketEntry();
            }
        }
        if (!entry) {
            const sourceFile = createLanguageServiceSourceFile(fileName, scriptSnapshot, sourceFileOptions, version, false, scriptKind);
            if (externalCache) externalCache.setDocument(keyWithMode, path, sourceFile);
            entry = { sourceFile, languageServiceRefCount: 1 };
            setBucketEntry();
        }
        else {
            if (entry.sourceFile.version !== version) {
                entry.sourceFile = updateLanguageServiceSourceFile(entry.sourceFile, scriptSnapshot, version, scriptSnapshot.getChangeRange(entry.sourceFile.scriptSnapshot));
                if (externalCache) externalCache.setDocument(keyWithMode, path, entry.sourceFile);
            }
            if (acquiring) entry.languageServiceRefCount++;
        }
        if (entry.languageServiceRefCount === 0) debugFail("False expression.");
        return entry.sourceFile;

        function setBucketEntry() {
            if (!bucketEntry) bucket.set(path, entry);
            else if (isDocumentRegistryEntry(bucketEntry)) {
                const scriptKindMap = new Map();
                scriptKindMap.set(bucketEntry.sourceFile.scriptKind, bucketEntry);
                scriptKindMap.set(scriptKind, entry);
                bucket.set(path, scriptKindMap);
            }
            else bucketEntry.set(scriptKind, entry);
        }
    }

    function releaseDocument(fileName, compilationSettings, scriptKind, impliedNodeFormat) {
        const path = toPath(fileName, currentDirectory, getCanonicalFileName);
        const key = getKeyForCompilationSettings(compilationSettings);
        return releaseDocumentWithKey(path, key, scriptKind, impliedNodeFormat);
    }

    function releaseDocumentWithKey(path, key, scriptKind, impliedNodeFormat) {
        const bucket = buckets.get(getDocumentRegistryBucketKeyWithMode(key, impliedNodeFormat));
        if (bucket === undefined) debugFail("Expected value to be defined.");
        const bucketEntry = bucket.get(path);
        const entry = getDocumentRegistryEntry(bucketEntry, scriptKind);
        entry.languageServiceRefCount--;
        if (!(entry.languageServiceRefCount >= 0)) debugFail("False expression.");
        if (entry.languageServiceRefCount === 0) {
            if (isDocumentRegistryEntry(bucketEntry)) bucket.delete(path);
            else {
                bucketEntry.delete(scriptKind);
                if (bucketEntry.size === 1) bucket.set(path, bucketEntry.values().next().value);
            }
        }
    }

    return {
        acquireDocument,
        acquireDocumentWithKey,
        updateDocument,
        updateDocumentWithKey,
        releaseDocument,
        releaseDocumentWithKey,
        getKeyForCompilationSettings,
        getDocumentRegistryBucketKeyWithMode,
        reportStats,
        getBuckets: () => buckets,
    };
}

export { getKeyForCompilationSettings, ensureScriptKind, getEmitScriptTarget, getNormalizedAbsolutePath };
