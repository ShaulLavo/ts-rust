// Apache-2.0. Ported unchanged from Microsoft TypeScript 6.0.3 (050880ce)
// src/compiler/path.ts and src/compiler/core.ts.

const directorySeparator = "/";
const altDirectorySeparator = "\\";
const urlSchemeSeparator = "://";
const backslashRegExp = /\\/g;
const relativePathSegmentRegExp = /\/\/|(?:^|\/)\.\.?(?:$|\/)/;
const fileNameLowerCaseRegExp = /[^İıßa-z0-9\\/:\-_. ]+/g;

function isAnyDirectorySeparator(charCode) {
    return charCode === 47 || charCode === 92;
}

function isVolumeCharacter(charCode) {
    return charCode >= 97 && charCode <= 122 || charCode >= 65 && charCode <= 90;
}

function getFileUrlVolumeSeparatorEnd(url, start) {
    const ch0 = url.charCodeAt(start);
    if (ch0 === 58) return start + 1;
    if (ch0 === 37 && url.charCodeAt(start + 1) === 51) {
        const ch2 = url.charCodeAt(start + 2);
        if (ch2 === 97 || ch2 === 65) return start + 3;
    }
    return -1;
}

function getEncodedRootLength(path) {
    if (!path) return 0;
    const ch0 = path.charCodeAt(0);
    if (ch0 === 47 || ch0 === 92) {
        if (path.charCodeAt(1) !== ch0) return 1;
        const p1 = path.indexOf(ch0 === 47 ? directorySeparator : altDirectorySeparator, 2);
        if (p1 < 0) return path.length;
        return p1 + 1;
    }
    if (isVolumeCharacter(ch0) && path.charCodeAt(1) === 58) {
        const ch2 = path.charCodeAt(2);
        if (ch2 === 47 || ch2 === 92) return 3;
        if (path.length === 2) return 2;
    }
    const schemeEnd = path.indexOf(urlSchemeSeparator);
    if (schemeEnd !== -1) {
        const authorityStart = schemeEnd + urlSchemeSeparator.length;
        const authorityEnd = path.indexOf(directorySeparator, authorityStart);
        if (authorityEnd !== -1) {
            const scheme = path.slice(0, schemeEnd);
            const authority = path.slice(authorityStart, authorityEnd);
            if (scheme === "file" && (authority === "" || authority === "localhost") && isVolumeCharacter(path.charCodeAt(authorityEnd + 1))) {
                const volumeSeparatorEnd = getFileUrlVolumeSeparatorEnd(path, authorityEnd + 2);
                if (volumeSeparatorEnd !== -1) {
                    if (path.charCodeAt(volumeSeparatorEnd) === 47) return ~(volumeSeparatorEnd + 1);
                    if (volumeSeparatorEnd === path.length) return ~volumeSeparatorEnd;
                }
            }
            return ~(authorityEnd + 1);
        }
        return ~path.length;
    }
    return 0;
}

export function getRootLength(path) {
    const rootLength = getEncodedRootLength(path);
    return rootLength < 0 ? ~rootLength : rootLength;
}

export function isRootedDiskPath(path) {
    return getEncodedRootLength(path) > 0;
}

export function normalizeSlashes(path) {
    return path.includes("\\") ? path.replace(backslashRegExp, directorySeparator) : path;
}

function hasTrailingDirectorySeparator(path) {
    return path.length > 0 && isAnyDirectorySeparator(path.charCodeAt(path.length - 1));
}

function ensureTrailingDirectorySeparator(path) {
    return hasTrailingDirectorySeparator(path) ? path : path + directorySeparator;
}

function removeTrailingDirectorySeparator(path) {
    return hasTrailingDirectorySeparator(path) ? path.substr(0, path.length - 1) : path;
}

export function combinePaths(path, ...paths) {
    if (path) path = normalizeSlashes(path);
    for (let relativePath of paths) {
        if (!relativePath) continue;
        relativePath = normalizeSlashes(relativePath);
        if (!path || getRootLength(relativePath) !== 0) path = relativePath;
        else path = ensureTrailingDirectorySeparator(path) + relativePath;
    }
    return path;
}

function simpleNormalizePath(path) {
    if (!relativePathSegmentRegExp.test(path)) return path;
    let simplified = path.replace(/\/\.\//g, "/");
    if (simplified.startsWith("./")) simplified = simplified.slice(2);
    if (simplified !== path) {
        path = simplified;
        if (!relativePathSegmentRegExp.test(path)) return path;
    }
    return undefined;
}

export function getNormalizedAbsolutePath(path, currentDirectory) {
    let rootLength = getRootLength(path);
    if (rootLength === 0 && currentDirectory) {
        path = combinePaths(currentDirectory, path);
        rootLength = getRootLength(path);
    }
    else {
        path = normalizeSlashes(path);
    }
    const simpleNormalized = simpleNormalizePath(path);
    if (simpleNormalized !== undefined) {
        return simpleNormalized.length > rootLength ? removeTrailingDirectorySeparator(simpleNormalized) : simpleNormalized;
    }
    const length = path.length;
    const root = path.substring(0, rootLength);
    let normalized;
    let index = rootLength;
    let segmentStart = index;
    let normalizedUpTo = index;
    let seenNonDotDotSegment = rootLength !== 0;
    while (index < length) {
        segmentStart = index;
        let ch = path.charCodeAt(index);
        while (ch === 47 && index + 1 < length) {
            index++;
            ch = path.charCodeAt(index);
        }
        if (index > segmentStart) {
            normalized ??= path.substring(0, segmentStart - 1);
            segmentStart = index;
        }
        let segmentEnd = path.indexOf(directorySeparator, index + 1);
        if (segmentEnd === -1) segmentEnd = length;
        const segmentLength = segmentEnd - segmentStart;
        if (segmentLength === 1 && path.charCodeAt(index) === 46) {
            normalized ??= path.substring(0, normalizedUpTo);
        }
        else if (segmentLength === 2 && path.charCodeAt(index) === 46 && path.charCodeAt(index + 1) === 46) {
            if (!seenNonDotDotSegment) {
                if (normalized !== undefined) normalized += normalized.length === rootLength ? ".." : "/..";
                else normalizedUpTo = index + 2;
            }
            else if (normalized === undefined) {
                normalized = normalizedUpTo - 2 >= 0
                    ? path.substring(0, Math.max(rootLength, path.lastIndexOf(directorySeparator, normalizedUpTo - 2)))
                    : path.substring(0, normalizedUpTo);
            }
            else {
                const lastSlash = normalized.lastIndexOf(directorySeparator);
                normalized = lastSlash !== -1 ? normalized.substring(0, Math.max(rootLength, lastSlash)) : root;
                if (normalized.length === rootLength) seenNonDotDotSegment = rootLength !== 0;
            }
        }
        else if (normalized !== undefined) {
            if (normalized.length !== rootLength) normalized += directorySeparator;
            seenNonDotDotSegment = true;
            normalized += path.substring(segmentStart, segmentEnd);
        }
        else {
            seenNonDotDotSegment = true;
            normalizedUpTo = segmentEnd;
        }
        index = segmentEnd + 1;
    }
    return normalized ?? (length > rootLength ? removeTrailingDirectorySeparator(path) : path);
}

export function normalizePath(path) {
    path = normalizeSlashes(path);
    let normalized = simpleNormalizePath(path);
    if (normalized !== undefined) return normalized;
    normalized = getNormalizedAbsolutePath(path, "");
    return normalized && hasTrailingDirectorySeparator(path) ? ensureTrailingDirectorySeparator(normalized) : normalized;
}

export function toFileNameLowerCase(x) {
    return fileNameLowerCaseRegExp.test(x) ? x.replace(fileNameLowerCaseRegExp, value => value.toLowerCase()) : x;
}

export function createGetCanonicalFileName(useCaseSensitiveFileNames) {
    return useCaseSensitiveFileNames ? value => value : toFileNameLowerCase;
}

export function toPath(fileName, basePath, getCanonicalFileName) {
    const nonCanonicalizedPath = isRootedDiskPath(fileName) ? normalizePath(fileName) : getNormalizedAbsolutePath(fileName, basePath);
    return getCanonicalFileName(nonCanonicalizedPath);
}

export function fileExtensionIsOneOf(path, extensions) {
    return extensions.some(extension => path.length > extension.length && path.endsWith(extension));
}
