import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { expectedArtifact } from "../scripts/check-classic-boundary.mjs";

const headers = [
    "function createProgram(_rootNamesOrOptions, _options, _host, _oldProgram, _configFileParsingDiagnostics) {",
    "function createSourceFile(fileName, sourceText, languageVersionOrOptions, setParentNodes = false, scriptKind) {",
    "function createLanguageServiceSourceFile(fileName, scriptSnapshot, scriptTargetOrOptions, version2, setNodeParents, scriptKind) {",
    "function updateLanguageServiceSourceFile(sourceFile, scriptSnapshot, version2, textChangeRange, aggressiveChecks) {",
    "function getSetExternalModuleIndicator(options) {",
    "  function parseSourceFile(fileName2, sourceText2, languageVersion2, syntaxCursor2, setParentNodes = false, scriptKind2, setExternalModuleIndicatorOverride, jsDocParsingMode = 0 /* ParseAll */) {",
    "function updateSourceFile(sourceFile, newText, textChangeRange, aggressiveChecks = false) {",
    "function bindSourceFile(file, options) {",
    "function createTypeChecker(host) {",
    "function emitFiles(resolver, host, targetSourceFile, { scriptTransformers, declarationTransformers }, emitOnly, onlyBuildInfo, forceDtsEmit, skipBuildInfo) {",
];
const closing = '})({ get exports() { return ts; }, set exports(v) { ts = v; if (typeof module !== "undefined" && module.exports) { module.exports = v; } } })';
const fixture = "var ts = {}; ((module) => {\n" + headers.map(header => `${header}\n}\n`).join("") + closing + "\n//# sourceMappingURL=typescript.js.map\n";
const manifest = { version: "6.0.3", gitHead: "050880ce59e30b356b686bd3144efe24f875ebc8" };

test("provenance reproduction includes exact redirects, guards and wrapper changes", () => {
    const artifact = expectedArtifact(fixture, manifest);
    assert.equal(Array.from(artifact.matchAll(/return __rust\./g)).length, 5);
    assert.equal(Array.from(artifact.matchAll(/__rust\.guard\(/g)).length, 5);
    assert.match(artifact, /export function createClassicServices\(__rust\)/);
    assert.match(artifact, /lib\/typescript\.js sha256 [a-f0-9]{64}/);
    assert.doesNotMatch(artifact, /module\.exports|sourceMappingURL/);
});

test("provenance refuses duplicated or missing substitution sites", () => {
    assert.throws(() => expectedArtifact(fixture + headers[0], manifest), /not unique/);
    assert.throws(() => expectedArtifact(fixture.replace(headers[0], ""), manifest), /not unique/);
});

test("CLI describes diagnostic scope and rejects missing reference input", () => {
    const script = fileURLToPath(new URL("../scripts/check-classic-boundary.mjs", import.meta.url));
    const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /does not run Rust programs/);
    const invalid = spawnSync(process.execPath, [script, "--root", "."], { encoding: "utf8" });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--reference must identify/);
});

// Optional auditor dependency, never guessed from a developer's home or checkout.
// CLASSIC_BOUNDARY_REFERENCE=/path/to/typescript-6.0.3 node --test test/classic-boundary.test.mjs
const reference = process.env.CLASSIC_BOUNDARY_REFERENCE;
test("current artifact rejects original bypasses despite passing main guards", { skip: reference ? false : "Set CLASSIC_BOUNDARY_REFERENCE to the pinned TypeScript 6.0.3 package to run artifact/runtime controls.", timeout: 120000 }, () => {
    const script = fileURLToPath(new URL("../scripts/check-classic-boundary.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--reference", reference], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 110000 });
    assert.ifError(run.error);
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.diagnosticOnly, true);
    assert.equal(report.ok, false);
    assert.equal(report.provenance.pinned, true);
    assert.equal(report.provenance.exactGeneratedArtifact, true);
    assert.equal(report.provenance.wasm.instantiated, false);
    assert.equal(report.inventories.injected.length, 5);
    assert.equal(report.inventories.blocked.length, 6);
    assert.ok(report.inventories.blocked.some(item => item.name === "startTracing2"));
    assert.equal(report.runtime.guardProbes.length, 5);
    assert.ok(report.runtime.guardProbes.every(item => item.outcome === "blocked"));
    assert.ok(report.runtime.injectionProbes.every(item => item.outcome === "injected"));
    assert.equal(report.runtime.referenceNegativeControls.length, 12);
    assert.ok(report.runtime.referenceNegativeControls.every(item => item.outcome === "original-entry-reached"));
    assert.equal(report.runtime.bypassProbes.length, 7);
    assert.ok(report.runtime.bypassProbes.every(item => item.outcome === "original-entry-reached"));
    assert.ok(report.runtime.realCandidateGuards.every(item => item.confirmed));
    assert.equal(report.runtime.realCandidateGuards.length, 3);
    assert.ok(report.runtime.auditedUtilities.every(item => item.matches));
    for (const id of ["json-parser", "isolated-entity-parser", "jsdoc-parser", "jsdoc-type-parser", "module-resolution", "printer", "transform", "transitive-closure"]) {
        assert.ok(report.failures.some(item => item.id === id), id);
    }
    assert.ok(report.unresolvedPaths.every(item => item.locations.length && !item.resolved));
    assert.ok(report.unresolvedPaths.find(item => item.id === "jsdoc-parser").directCallSites.some(item => item.caller === "classifyComment"));
    assert.ok(report.runtime.startupOriginal.candidate.some(item => item.includes("createBinder")));
});
