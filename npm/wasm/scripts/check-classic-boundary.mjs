#!/usr/bin/env node
// Diagnostic only: retained original compiler code is not made safe by guard counts.
// The reference parser runs in the auditor, never in the candidate compiler.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";

const PIN = "050880ce59e30b356b686bd3144efe24f875ebc8";
const REFERENCE_SHA256 = "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39";
const redirected = [
    "function createProgram(_rootNamesOrOptions, _options, _host, _oldProgram, _configFileParsingDiagnostics) {",
    "function createSourceFile(fileName, sourceText, languageVersionOrOptions, setParentNodes = false, scriptKind) {",
    "function createLanguageServiceSourceFile(fileName, scriptSnapshot, scriptTargetOrOptions, version2, setNodeParents, scriptKind) {",
    "function updateLanguageServiceSourceFile(sourceFile, scriptSnapshot, version2, textChangeRange, aggressiveChecks) {",
    "function getSetExternalModuleIndicator(options) {",
];
const blocked = [
    ["Parser.parseSourceFile", "  function parseSourceFile(fileName2, sourceText2, languageVersion2, syntaxCursor2, setParentNodes = false, scriptKind2, setExternalModuleIndicatorOverride, jsDocParsingMode = 0 /* ParseAll */) {"],
    ["updateSourceFile", "function updateSourceFile(sourceFile, newText, textChangeRange, aggressiveChecks = false) {"],
    ["bindSourceFile", "function bindSourceFile(file, options) {"],
    ["createTypeChecker", "function createTypeChecker(host) {"],
    ["emitFiles", "function emitFiles(resolver, host, targetSourceFile, { scriptTransformers, declarationTransformers }, emitOnly, onlyBuildInfo, forceDtsEmit, skipBuildInfo) {"],
];
const originalClosing = '})({ get exports() { return ts; }, set exports(v) { ts = v; if (typeof module !== "undefined" && module.exports) { module.exports = v; } } })';
const candidateClosing = '})({ get exports() { return ts; }, set exports(v) { ts = v; } })';
const hooks = "ts.__boundary = { parser: Parser.parseSourceFile, emitFiles };\n";
const sensitiveNames = new Set([
    "parseSourceFile", "updateSourceFile", "bindSourceFile", "createBinder", "createTypeChecker", "emitFiles",
    "parseJsonText2", "parseIsolatedEntityName2", "parseIsolatedJSDocComment2", "parseJSDocTypeExpressionForTests",
    "resolveModuleName", "createPrinter", "transformNodes", "transform", "getDeclarationDiagnostics",
]);
const utilities = [
    { name: "createScanner", reason: "Lexical scanner explicitly permitted for editor algorithms; this is not a parser exemption." },
    { name: "factory.createIdentifier", provenanceFunction: "createNodeFactory", reason: "Synthetic identifier construction explicitly permitted; printing/transformation and other factory methods remain outside this bounded audit." },
    { name: "normalizePath", reason: "Path normalization explicitly permitted; module resolution is a separate compiler path." },
];
const knownPaths = [
    { id: "json-parser", entry: "parseJsonText", original: "parseJsonText2", path: "parseJsonText -> Parser.parseJsonText -> parseJsonText2; package metadata strict JSON fallback", category: "parser" },
    { id: "isolated-entity-parser", entry: "parseIsolatedEntityName", original: "parseIsolatedEntityName2", path: "parseIsolatedEntityName -> Parser.parseIsolatedEntityName", category: "parser" },
    { id: "jsdoc-parser", entry: "parseIsolatedJSDocComment", original: "parseIsolatedJSDocComment2", path: "syntactic comment classifications -> classifyComment -> parseIsolatedJSDocComment -> Parser.JSDocParser", category: "parser" },
    { id: "jsdoc-type-parser", entry: "parseJSDocTypeExpressionForTests", original: "parseJSDocTypeExpressionForTests", path: "namespace parseJSDocTypeExpressionForTests -> Parser.JSDocParser", category: "parser" },
    { id: "module-resolution", entry: "resolveModuleName", original: "resolveModuleName", path: "getEditsForFileRename -> lexical resolveModuleName (namespace replacement cannot intercept it)", category: "compiler" },
    { id: "printer", entry: "createPrinter", original: "createPrinter", path: "ChangeTracker / checker display writers -> createPrinter().writeNode", category: "emitter" },
    { id: "transform", entry: "transform", original: "transformNodes", path: "transform -> transformNodes; standalone declaration diagnostics -> transformNodes", category: "emitter" },
];

function sha(text) { return createHash("sha256").update(text).digest("hex"); }
function functionName(header) { return /function (\w+)\(/.exec(header)[1]; }
function replaceOnce(text, from, to) {
    const parts = text.split(from);
    if (parts.length !== 2) throw new Error(`provenance replacement is not unique: ${from}`);
    return parts[0] + to + parts[1];
}

export function expectedArtifact(original, manifest, provenanceSource = original) {
    let text = original;
    for (const header of redirected) text = replaceOnce(text, header, `${header} return __rust.${functionName(header)}.apply(this, arguments);`);
    for (const [name, header] of blocked) text = replaceOnce(text, header, `${header} __rust.guard(${JSON.stringify(name)});`);
    text = replaceOnce(text, originalClosing, candidateClosing).replace(/\/\/# sourceMappingURL=.*\n?$/, "");
    return `// Generated by scripts/generate-classic-services.mjs from typescript@${manifest.version} (gitHead ${manifest.gitHead}),\n`
        + `// lib/typescript.js sha256 ${sha(provenanceSource)}. Microsoft TypeScript is Apache-2.0; its notice follows.\n`
        + `export function createClassicServices(__rust) {\n${text}\nreturn ts;\n}\n`;
}

function isolatedReference(source) {
    const context = vm.createContext({});
    vm.runInContext(source, context, { timeout: 30000, filename: "reference-typescript.js" });
    return context.ts;
}

function stripNodeTooling(ts, original) {
    const ast = ts.createSourceFile("typescript.js", original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const nodes = [];
    function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
    visit(ast);
    function unique(predicate, name) {
        const found = nodes.filter(predicate);
        if (found.length !== 1) throw new Error(`expected one original ${name}, found ${found.length}`);
        return found[0];
    }
    const named = name => unique(node => ts.isFunctionDeclaration(node) && node.name?.text === name, name);
    const performanceBranch = named("tryGetPerformance").body.statements[0];
    if (!ts.isIfStatement(performanceBranch) || performanceBranch.expression.getText(ast) !== "isNodeLikeSystem()") throw new Error("original Node performance branch changed");
    const sys = unique(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "sys", "sys");
    if (!ts.isCallExpression(sys.initializer) || !sys.initializer.getText(ast).includes("function getNodeSystem()")) throw new Error("original Node sys initializer changed");
    const requires = nodes.filter(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require");
    const edits = [
        { node: named("isNodeLikeSystem").body, replacement: "{ return false; }" },
        { node: performanceBranch, replacement: "" },
        { node: sys.initializer, replacement: "void 0" },
        { node: named("startTracing2").body, replacement: '{ __rust.guard("startTracing"); }' },
    ];
    const counts = edits.map(edit => requires.filter(node => node.getStart(ast) >= edit.node.getStart(ast) && node.end <= edit.node.end).length);
    if (requires.length !== 9 || counts.join(",") !== "0,1,7,1") throw new Error("original Node require provenance changed");
    const ranges = edits.map(edit => ({ line: ast.getLineAndCharacterOfPosition(edit.node.getStart(ast)).line + 1, start: edit.node.getStart(ast), end: edit.node.end, replacement: edit.replacement }));
    edits.sort((a, b) => b.node.getStart(ast) - a.node.getStart(ast));
    let text = original;
    for (const edit of edits) text = text.slice(0, edit.node.getStart(ast)) + edit.replacement + text.slice(edit.node.end);
    return { text, ranges, removedNodeRequires: requires.length };
}

function sourceInventory(ts, source, file) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error(`${file}: audit parser reported ${ast.parseDiagnostics.length} errors`);
    const markers = Array.from(source.matchAll(/^\/\/ (src\/[^\n]+)$/gm), match => ({ offset: match.index, source: match[1] }));
    const entries = [];
    const directCalls = [];
    const trackedNames = new Set(Array.from(sensitiveNames).concat(knownPaths.map(item => item.entry)));
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const expression = node.expression;
            let name;
            if (ts.isIdentifier(expression)) name = expression.text;
            if (ts.isPropertyAccessExpression(expression)) name = expression.name.text;
            if (trackedNames.has(name)) {
                const offset = node.getStart(ast);
                let owner = node.parent;
                while (owner && !(ts.isFunctionDeclaration(owner) && owner.name)) owner = owner.parent;
                directCalls.push({ name, expression: expression.getText(ast), caller: owner?.name.text ?? "module initialization or anonymous callback", source: markers.findLast(item => item.offset <= offset)?.source ?? "bundle-wrapper", line: ast.getLineAndCharacterOfPosition(offset).line + 1 });
            }
        }
        if (ts.isFunctionDeclaration(node) && node.name && node.body) {
            const offset = node.getStart(ast);
            const marker = markers.findLast(item => item.offset <= offset);
            const first = node.body.statements[0];
            const leading = first?.getText(ast) ?? "";
            const state = leading.startsWith("return __rust.") ? "injected" : leading.startsWith("__rust.guard(") ? "blocked" : "original";
            const calls = [];
            function scan(child) {
                if (child !== node.body && ts.isFunctionLike(child)) return;
                if (ts.isCallExpression(child)) calls.push(child.expression.getText(ast));
                ts.forEachChild(child, scan);
            }
            scan(node.body);
            entries.push({ name: node.name.text, source: marker?.source ?? "bundle-wrapper", line: ast.getLineAndCharacterOfPosition(offset).line + 1, offset, bodyOffset: node.body.getStart(ast) + 1, firstEnd: first?.end, state, calls: Array.from(new Set(calls)) });
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return { ast, entries, directCalls };
}

function instrument(source, inventory) {
    const edits = inventory.entries.filter(entry => sensitiveNames.has(entry.name)).map(entry => ({
        // A guard or injected return must run before the original-body tripwire.
        offset: entry.state === "original" ? entry.bodyOffset : entry.firstEnd,
        text: `\n__boundaryTripwire(${JSON.stringify(`${entry.source}:${entry.name}:${entry.line}`)});\n`,
    }));
    edits.sort((a, b) => b.offset - a.offset);
    let text = source;
    for (const edit of edits) text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset);
    return text;
}

function instrumentedNamespace(source, inventory, isReference) {
    let text = instrument(source, inventory);
    if (isReference) text = replaceOnce(text, originalClosing, hooks + originalClosing);
    if (!isReference) text = replaceOnce(text, candidateClosing, hooks + candidateClosing).replace("export function createClassicServices", "function createClassicServices");
    let armed = false;
    const startupOriginal = [];
    const context = vm.createContext({ __boundaryTripwire(name) {
        if (armed) throw { boundaryOriginal: name };
        startupOriginal.push(name);
    } });
    const events = [];
    if (isReference) {
        vm.runInContext(text, context, { timeout: 30000, filename: "instrumented-reference.js" });
        armed = true;
        return { ts: context.ts, events, startupOriginal };
    }
    vm.runInContext(text, context, { timeout: 30000, filename: "instrumented-candidate.js" });
    const bridge = { guard(name) { events.push({ kind: "guard", name }); throw { boundaryGuard: name }; } };
    for (const header of redirected) {
        const name = functionName(header);
        bridge[name] = () => { events.push({ kind: "injected", name }); throw { boundaryInjected: name }; };
    }
    const ts = context.createClassicServices(bridge);
    armed = true;
    return { ts, events, startupOriginal };
}

function probe(namespace, name, call) {
    namespace.events.length = 0;
    try {
        call(namespace.ts);
        return { name, outcome: "returned", events: namespace.events.slice() };
    } catch (error) {
        return { name, outcome: error?.boundaryOriginal ? "original-entry-reached" : error?.boundaryGuard ? "blocked" : error?.boundaryInjected ? "injected" : "unexpected-error", original: error?.boundaryOriginal, guard: error?.boundaryGuard, injected: error?.boundaryInjected, error: error?.message, events: namespace.events.slice() };
    }
}

const guardProbes = [
    ["Parser.parseSourceFile", ts => ts.__boundary.parser("x.ts", "let x = 1", 99, undefined, true, 3)],
    ["updateSourceFile", ts => ts.updateSourceFile({}, "", {})],
    ["bindSourceFile", ts => ts.bindSourceFile({}, {})],
    ["createTypeChecker", ts => ts.createTypeChecker({})],
    ["emitFiles", ts => ts.__boundary.emitFiles({}, {}, undefined, { scriptTransformers: [], declarationTransformers: [] })],
];
const bypassProbes = [
    ["parseJsonText", ts => ts.parseJsonText("package.json", '{"name":"x",}')],
    ["parseIsolatedEntityName", ts => ts.parseIsolatedEntityName("a.b", 99)],
    ["parseIsolatedJSDocComment", ts => ts.parseIsolatedJSDocComment("/** @param {string} value */", 0, 28)],
    ["parseJSDocTypeExpressionForTests", ts => ts.parseJSDocTypeExpressionForTests("{string}", 0, 8)],
    ["resolveModuleName", ts => ts.resolveModuleName("./other", "/x.ts", {}, { fileExists: () => false, readFile: () => undefined })],
    ["createPrinter", ts => ts.createPrinter()],
    ["transform", ts => ts.transform([], [])],
];

async function dependencyGraph(ts, root, entry) {
    const pending = [resolve(root, entry)];
    const nodes = new Map();
    const edges = [];
    const unresolved = [];
    const nodeDependencies = [];
    while (pending.length) {
        const file = pending.pop();
        if (nodes.has(file)) continue;
        let source;
        try { source = await readFile(file, "utf8"); }
        catch { unresolved.push({ file: relative(root, file), reason: "missing dependency" }); nodes.set(file, null); continue; }
        nodes.set(file, { file: relative(root, file), sha256: sha(source) });
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        function edge(node, specifier, kind) {
            const from = relative(root, file);
            const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
            edges.push({ from, specifier, kind, line });
            if (specifier.startsWith("node:") || (!specifier.startsWith(".") && !specifier.startsWith("/"))) {
                nodeDependencies.push({ from, specifier, kind, line });
                return;
            }
            const target = resolve(dirname(file), specifier);
            if (/\.(?:m?js)$/.test(target)) pending.push(target);
        }
        function visit(node) {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) edge(node, node.moduleSpecifier.text, "static");
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require")) {
                const argument = node.arguments[0];
                if (argument && ts.isStringLiteral(argument)) edge(node, argument.text, node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require");
                else unresolved.push({ file: relative(root, file), line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, reason: "nonliteral module dependency" });
            }
            if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL" && ts.isStringLiteral(node.arguments?.[0])) edge(node, node.arguments[0].text, "url-asset");
            ts.forEachChild(node, visit);
        }
        visit(ast);
    }
    return { entry, nodes: Array.from(nodes.values()).filter(Boolean).sort((a, b) => a.file.localeCompare(b.file)), edges, unresolved, nodeDependencies };
}

export async function auditBoundary({ root, reference, candidateEntry = "classic.js" }) {
    root = resolve(root);
    reference = resolve(reference);
    const artifact = await readFile(resolve(root, "classic-services.js"), "utf8");
    const original = await readFile(resolve(reference, "lib/typescript.js"), "utf8");
    const manifest = JSON.parse(await readFile(resolve(reference, "package.json"), "utf8"));
    const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const failures = [];
    const pinned = manifest.version === "6.0.3" && manifest.gitHead === PIN && sha(original) === REFERENCE_SHA256;
    const provenance = { artifactFile: resolve(root, "classic-services.js"), referenceFile: resolve(reference, "lib/typescript.js"), referenceVersion: manifest.version, referenceGitHead: manifest.gitHead, expectedGitHead: PIN, referenceSha256: sha(original), artifactSha256: sha(artifact), generatorSha256: sha(await readFile(resolve(root, "scripts/generate-classic-services.mjs"))), license: "Apache-2.0", pinned, exactGeneratedArtifact: false };
    if (!pinned) {
        failures.push({ id: "reference-pin", reason: "Reference version, gitHead or source SHA-256 does not match the pinned TypeScript 6.0.3 source." });
        return { schemaVersion: 1, diagnosticOnly: true, provenance, failures, ok: false };
    }
    const ts = isolatedReference(original);
    try {
        const stripped = stripNodeTooling(ts, original);
        provenance.nodeToolingRemovals = { ranges: stripped.ranges, removedNodeRequires: stripped.removedNodeRequires };
        provenance.exactGeneratedArtifact = expectedArtifact(stripped.text, manifest, original) === artifact;
    } catch (error) { failures.push({ id: "generator-reproduction", reason: error.message }); }
    if (!provenance.exactGeneratedArtifact) failures.push({ id: "artifact-provenance", reason: "Artifact does not byte-match the documented substitutions of the reference source." });
    if (!pinned || !provenance.exactGeneratedArtifact) return { schemaVersion: 1, diagnosticOnly: true, provenance, failures, ok: false };

    const wasm = await readFile(resolve(root, "ts_rust.wasm"));
    provenance.wasm = { file: "ts_rust.wasm", bytes: wasm.length, sha256: sha(wasm), instantiated: false };
    const candidateInventory = sourceInventory(ts, artifact, "classic-services.js");
    const referenceInventory = sourceInventory(ts, original, "lib/typescript.js");
    const instrumented = instrumentedNamespace(artifact, candidateInventory, false);
    const control = instrumentedNamespace(original, referenceInventory, true);
    const runtime = { auditedUtilities: [], startupOriginal: { candidate: instrumented.startupOriginal, reference: control.startupOriginal }, guardProbes: [], injectionProbes: [], bypassProbes: [], referenceNegativeControls: [], realCandidateGuards: [] };
    if (instrumented.startupOriginal.length) failures.push({ id: "startup-original", reason: "Original sensitive entries execute during namespace initialization. createBinder is factory setup; this does not demonstrate file binding.", entries: instrumented.startupOriginal });
    const utilityChecks = [
        ["createScanner", namespace => { const scanner = namespace.createScanner(99, true, 0, "name"); return scanner.scan() === namespace.SyntaxKind.Identifier && scanner.getTokenText() === "name"; }],
        ["factory.createIdentifier", namespace => namespace.factory.createIdentifier("name").escapedText === "name"],
        ["normalizePath", namespace => namespace.normalizePath("/a/b/../c") === "/a/c"],
    ];
    for (const [name, check] of utilityChecks) {
        let matches = false;
        const result = probe(instrumented, name, namespace => { matches = check(namespace); });
        runtime.auditedUtilities.push({ ...result, matches });
        if (!matches || result.outcome !== "returned") failures.push({ id: `utility:${name}`, reason: "Named utility probe entered a sensitive body or returned an unexpected value.", result });
    }
    for (const [name, call] of guardProbes) {
        const result = probe(instrumented, name, call);
        runtime.guardProbes.push(result);
        if (result.outcome !== "blocked" || result.guard !== name) failures.push({ id: `guard:${name}`, reason: "Known guard did not stop the original body.", result });
        const negative = probe(control, name, call);
        runtime.referenceNegativeControls.push(negative);
        if (negative.outcome !== "original-entry-reached") failures.push({ id: `negative-control:${name}`, reason: "Probe did not detect original reference execution.", result: negative });
    }
    for (const header of redirected) {
        const name = functionName(header);
        const result = probe(instrumented, name, namespace => namespace[name]());
        runtime.injectionProbes.push(result);
        if (result.outcome !== "injected" || result.injected !== name) failures.push({ id: `injection:${name}`, reason: "Entry did not reach its injected bridge.", result });
    }
    for (const [name, call] of bypassProbes) {
        const result = probe(instrumented, name, call);
        runtime.bypassProbes.push(result);
        const negative = probe(control, name, call);
        runtime.referenceNegativeControls.push(negative);
        if (negative.outcome !== "original-entry-reached") failures.push({ id: `negative-control:${name}`, reason: "Probe did not detect original reference execution.", result: negative });
    }
    // Import compiles the module only. Do not create a program/service or instantiate Rust.
    try {
        const imported = await import(pathToFileURL(resolve(root, candidateEntry)).href);
        const candidate = imported.default ?? imported;
        for (const [name, call] of guardProbes.filter(([name]) => name !== "Parser.parseSourceFile" && name !== "emitFiles")) {
            const result = probe({ ts: candidate, events: [] }, name, call);
            const confirmed = result.outcome === "unexpected-error" && result.error?.includes(`classic ${name} is not part of this compiler`);
            runtime.realCandidateGuards.push({ ...result, confirmed });
            if (!confirmed) failures.push({ id: `candidate-guard:${name}`, reason: "Actual initialized namespace guard was not observed.", result });
        }
    } catch (error) { failures.push({ id: "candidate-import", reason: error.message }); }

    const inventories = {
        injected: candidateInventory.entries.filter(entry => entry.state === "injected"),
        blocked: candidateInventory.entries.filter(entry => entry.state === "blocked"),
        auditedUtilities: utilities.map(item => {
            const declaration = candidateInventory.entries.find(entry => entry.name === (item.provenanceFunction ?? item.name));
            return { ...item, source: declaration?.source, line: declaration?.line, license: "Apache-2.0", runtimeProbe: runtime.auditedUtilities.find(probe => probe.name === item.name), exemptionScope: "named utility and bounded test only, not transitive compiler execution" };
        }),
        sensitiveOriginal: candidateInventory.entries.filter(entry => entry.state === "original" && sensitiveNames.has(entry.name)),
        // This is deliberately a residual inventory, not a reachability proof.
        retainedCompilerFunctions: candidateInventory.entries.filter(entry => entry.state === "original" && entry.source.startsWith("src/compiler/")),
    };
    const unresolvedPaths = knownPaths.map(item => {
        const entries = candidateInventory.entries.filter(entry => entry.name === item.original);
        const runtimeProbe = runtime.bypassProbes.find(probe => probe.name === item.entry);
        return { ...item, locations: entries.map(entry => ({ source: entry.source, line: entry.line, state: entry.state, calls: entry.calls })), directCallSites: candidateInventory.directCalls.filter(call => call.name === item.entry || call.name === item.original), runtimeProbe, resolved: entries.length > 0 && entries.every(entry => entry.state !== "original") && ["blocked", "injected"].includes(runtimeProbe?.outcome) };
    });
    for (const item of unresolvedPaths.filter(item => !item.resolved)) failures.push({ id: item.id, reason: "Original compiler/parser/emitter path is unresolved (not an audited utility).", locations: item.locations });
    failures.push({ id: "transitive-closure", reason: "Named-entry instrumentation and direct-call inventories do not prove closure through callbacks, property dispatch, aliases or returned printer/transform objects. Remaining original compiler functions need a dependency audit." });
    const browserEntry = packageManifest.exports?.["."]?.default;
    const graphs = { candidate: await dependencyGraph(ts, root, candidateEntry), browser: browserEntry ? await dependencyGraph(ts, root, browserEntry) : undefined };
    for (const [name, graph] of Object.entries(graphs)) {
        if (!graph) { failures.push({ id: `${name}-entry`, reason: "No browser default export declared." }); continue; }
        for (const dependency of graph.unresolved) failures.push({ id: `${name}-dependency`, ...dependency });
        const staticLeakage = graph.nodeDependencies.filter(item => item.kind !== "require");
        if (name === "browser" && staticLeakage.length) failures.push({ id: "browser-node-leakage", dependencies: staticLeakage });
        // Conditional require in the classic bundle's sys branch needs runtime browser proof.
        graph.conditionalNodeRequires = graph.nodeDependencies.filter(item => item.kind === "require");
        graph.packMissing = graph.nodes.filter(item => !packageManifest.files?.includes(item.file)).map(item => item.file);
        if (graph.packMissing.length) failures.push({ id: `${name}-pack-files`, files: graph.packMissing, reason: "Reachable JS files missing from package files inventory." });
    }
    return { schemaVersion: 1, diagnosticOnly: true, ok: false, node: process.version, provenance, inventories, unresolvedPaths, runtime, graphs, limitations: ["Only direct calls are inventoried; property dispatch and callbacks are not resolved into a sound whole-program graph.", "Original TypeScript parses audit inputs in an isolated VM. No candidate Rust program or language service runs.", "Instrumented probes insert original-body tripwires in memory and expose two lexical hooks; they do not modify shipped artifacts.", "The three actual-namespace guard probes supplement instrumentation; they do not cover lexical Parser/emitFiles hooks.", "Conditional Node require edges are reported, not asserted to execute in browsers. Browser execution and Rust-owned compiler execution remain unrun."], failures };
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.length || args.includes("--help") || args.includes("help")) {
        console.log("Usage: node scripts/check-classic-boundary.mjs --reference <typescript-6.0.3-package> [--root <wasm-package>] [--candidate-entry classic.js] [--report <results.json>]\nReports JSON to stdout (and --report). Exit 0: proved boundary; 1: unresolved paths/check failures; 2: invalid inputs. This diagnostic currently rejects known original JS bypasses and incomplete transitive closure. It does not run Rust programs. The pinned reference parser is an auditor-only dependency.");
        return;
    }
    const options = { root: fileURLToPath(new URL("..", import.meta.url)) };
    for (let index = 0; index < args.length; index += 2) {
        const key = { "--reference": "reference", "--root": "root", "--candidate-entry": "candidateEntry", "--report": "report" }[args[index]];
        if (!key || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`invalid argument: ${args[index]}`);
        options[key] = args[index + 1];
    }
    if (!options.reference) throw new Error("--reference must identify the pinned TypeScript package directory");
    const report = await auditBoundary(options);
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.report) await writeFile(resolve(options.report), text);
    process.stdout.write(text);
    process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 2; });
}
