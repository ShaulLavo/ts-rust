// Apache-2.0. Ported from Microsoft TypeScript 6.0.3 services/types.ts and services/services.ts.
class StringScriptSnapshot {
    constructor(text) { this.text = text; }
    getText(start, end) {
        return start === 0 && end === this.text.length ? this.text : this.text.substring(start, end);
    }
    getLength() { return this.text.length; }
    getChangeRange() { return undefined; }
}

export const ScriptSnapshot = {
    fromString(text) { return new StringScriptSnapshot(text); },
};

export function displayPartsToString(displayParts) {
    return displayParts ? displayParts.map(part => part.text).join("") : "";
}
