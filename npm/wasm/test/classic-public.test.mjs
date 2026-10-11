import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { verifyClassicPublic } from "./classic-public-sequence.mjs";

const skip = existsSync(new URL("../classic-services.js", import.meta.url)) ? false : "Generate the pinned classic-services.js artifact before public-entry verification";

test("the public package exposes the synchronous classic facade", { skip }, async () => {
    const ts = await import("ts-rust-wasm");
    assert.equal(ts.createLanguageService, ts.default.createLanguageService);
    assert.equal(ts.createDocumentRegistry, ts.default.createDocumentRegistry);
    assert.equal(ts.SyntaxKind, ts.default.SyntaxKind);
    assert.equal(ts.version, "6.0.3");
    assert.equal(verifyClassicPublic(ts).ok, true);
});

test("the asynchronous LSP transport has an explicit package entry", { skip }, async () => {
    const ts = await import("ts-rust-wasm");
    const lsp = await import("ts-rust-wasm/lsp");
    assert.notEqual(ts.createLanguageService, lsp.createLanguageService);
    assert.equal(typeof lsp.loadModule, "function");
    assert.equal(typeof lsp.tsc, "function");
});
