const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** UTF-8 with lone UTF-16 surrogate code units preserved as three-byte sequences. */
export function encodeWtf8(text) {
    if (!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return encoder.encode(text);
    let length = 0;
    for (const character of text) {
        const point = character.codePointAt(0);
        length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const character of text) offset = encodePoint(bytes, offset, character.codePointAt(0));
    return bytes;
}

function encodePoint(bytes, offset, point) {
    if (point < 0x80) {
        bytes[offset] = point;
        return offset + 1;
    }
    if (point < 0x800) {
        bytes[offset] = 0xc0 | (point >> 6);
        bytes[offset + 1] = 0x80 | (point & 0x3f);
        return offset + 2;
    }
    if (point < 0x10000) {
        bytes[offset] = 0xe0 | (point >> 12);
        bytes[offset + 1] = 0x80 | ((point >> 6) & 0x3f);
        bytes[offset + 2] = 0x80 | (point & 0x3f);
        return offset + 3;
    }
    bytes[offset] = 0xf0 | (point >> 18);
    bytes[offset + 1] = 0x80 | ((point >> 12) & 0x3f);
    bytes[offset + 2] = 0x80 | ((point >> 6) & 0x3f);
    bytes[offset + 3] = 0x80 | (point & 0x3f);
    return offset + 4;
}

export function decodeWtf8(bytes) {
    const parts = [];
    let start = 0;
    for (let index = 0; index + 2 < bytes.length; index++) {
        if (bytes[index] !== 0xed || bytes[index + 1] < 0xa0 || bytes[index + 1] > 0xbf || (bytes[index + 2] & 0xc0) !== 0x80) continue;
        parts.push(decoder.decode(bytes.subarray(start, index)));
        parts.push(String.fromCharCode(0xd000 | ((bytes[index + 1] & 0x3f) << 6) | (bytes[index + 2] & 0x3f)));
        index += 2;
        start = index + 1;
    }
    if (start === 0) return decoder.decode(bytes);
    parts.push(decoder.decode(bytes.subarray(start)));
    return parts.join("");
}

/** Internal scalar-string encoding used where JSON cannot express Rust's port strings. */
export function decodeProtocolString(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.$string)) return value;
    const parts = [];
    for (let index = 0; index < value.$string.length; index += 0x4000) {
        parts.push(String.fromCharCode(...value.$string.slice(index, index + 0x4000)));
    }
    return parts.join("");
}
