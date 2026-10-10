import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptSnapshot, displayPartsToString } from "../classic-utilities.js";

test("classic string snapshots preserve UTF-16 text and substring behavior", () => {
    const text = "a🌊b\r\nc";
    const snapshot = ScriptSnapshot.fromString(text);
    assert.equal(snapshot.getLength(), text.length);
    for (const [start, end, expected] of [[0, text.length, text], [1, 3, "🌊"], [-1, 2, "a\ud83c"], [4, 1, "🌊b"], [30, 40, ""]]) {
        assert.equal(snapshot.getText(start, end), expected);
    }
    assert.equal(snapshot.getChangeRange(ScriptSnapshot.fromString("old")), undefined);
});

test("classic display parts preserve text and missing results", () => {
    assert.equal(displayPartsToString(undefined), "");
    assert.equal(displayPartsToString([]), "");
    assert.equal(displayPartsToString([{ text: "const ", kind: "keyword" }, { text: "value", kind: "localName" }]), "const value");
});
