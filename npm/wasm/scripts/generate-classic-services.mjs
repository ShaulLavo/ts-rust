// Writes classic-services.js: TypeScript 6.0.3's published lib/typescript.js as a
// factory whose compiler entry points run in Rust. createProgram, createSourceFile,
// createLanguageServiceSourceFile, updateLanguageServiceSourceFile and
// getSetExternalModuleIndicator go to the functions the factory receives; the
// classic parser, incremental parser, binder, checker and emitter throw if reached.
// Node system/profiler loading is removed, file tracing is guarded, and timing
// uses the realm's performance object. Services and registry code stay unchanged.
//
// usage: node scripts/generate-classic-services.mjs <typescript-package-directory>
// Use the typescript@6.0.3 package (gitHead 050880ce).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const packageDirectory = process.argv[2];
if (!packageDirectory) throw new Error("pass the reference typescript package directory");
const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
if (manifest.version !== "6.0.3" || manifest.gitHead !== "050880ce59e30b356b686bd3144efe24f875ebc8") {
    throw new Error(`expected typescript 6.0.3 (050880ce), found ${manifest.version} (${manifest.gitHead})`);
}
const original = readFileSync(join(packageDirectory, "lib/typescript.js"), "utf8");
const sha256 = createHash("sha256").update(original).digest("hex");

const redirected = [
    "function createProgram(_rootNamesOrOptions, _options, _host, _oldProgram, _configFileParsingDiagnostics) {",
    "function createSourceFile(fileName, sourceText, languageVersionOrOptions, setParentNodes = false, scriptKind) {",
    "function createLanguageServiceSourceFile(fileName, scriptSnapshot, scriptTargetOrOptions, version2, setNodeParents, scriptKind) {",
    "function updateLanguageServiceSourceFile(sourceFile, scriptSnapshot, version2, textChangeRange, aggressiveChecks) {",
    "function getSetExternalModuleIndicator(options) {",
];
const guarded = [
    ["Parser.parseSourceFile", "  function parseSourceFile(fileName2, sourceText2, languageVersion2, syntaxCursor2, setParentNodes = false, scriptKind2, setExternalModuleIndicatorOverride, jsDocParsingMode = 0 /* ParseAll */) {"],
    ["updateSourceFile", "function updateSourceFile(sourceFile, newText, textChangeRange, aggressiveChecks = false) {"],
    ["bindSourceFile", "function bindSourceFile(file, options) {"],
    ["createTypeChecker", "function createTypeChecker(host) {"],
    ["emitFiles", "function emitFiles(resolver, host, targetSourceFile, { scriptTransformers, declarationTransformers }, emitOnly, onlyBuildInfo, forceDtsEmit, skipBuildInfo) {"],
];

const require = createRequire(import.meta.url);
const ts = require(join(resolve(packageDirectory), "lib/typescript.js"));
const source = ts.createSourceFile("typescript.js", original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const nodes = [];
function collect(node) {
    nodes.push(node);
    ts.forEachChild(node, collect);
}
collect(source);
function unique(predicate, label) {
    const matches = nodes.filter(predicate);
    if (matches.length !== 1) throw new Error(`expected one ${label}, found ${matches.length}`);
    return matches[0];
}
const namedFunction = name => unique(node => ts.isFunctionDeclaration(node) && node.name?.text === name, name);
const isRequireCall = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require";
const requireCalls = nodes.filter(isRequireCall);
if (requireCalls.length !== 9) throw new Error(`expected nine original Node requires, found ${requireCalls.length}`);
const performanceFunction = namedFunction("tryGetPerformance");
const nodePerformance = performanceFunction.body.statements[0];
if (!ts.isIfStatement(nodePerformance) || nodePerformance.expression.getText(source) !== "isNodeLikeSystem()") {
    throw new Error("original performance loader changed");
}
const sys = unique(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "sys", "sys initializer");
if (!ts.isCallExpression(sys.initializer) || !sys.initializer.getText(source).includes("function getNodeSystem()")) {
    throw new Error("original Node system initializer changed");
}
// AST ranges remove complete tooling paths; strings containing require() and
// host.require callbacks for caller-provided plugins are ordinary service data.
const edits = [
    { node: namedFunction("isNodeLikeSystem").body, replacement: "{ return false; }" },
    { node: nodePerformance, replacement: "" },
    { node: sys.initializer, replacement: "void 0" },
    { node: namedFunction("startTracing2").body, replacement: '{ __rust.guard("startTracing"); }' },
];
const requireCounts = edits.map(edit => requireCalls.filter(call => call.getStart(source) >= edit.node.getStart(source) && call.end <= edit.node.end).length);
if (requireCounts.join(",") !== "0,1,7,1") throw new Error(`original Node tooling call sites changed: ${requireCounts}`);
edits.sort((a, b) => b.node.getStart(source) - a.node.getStart(source));
let text = original;
for (const edit of edits) text = text.slice(0, edit.node.getStart(source)) + edit.replacement + text.slice(edit.node.end);
const stripped = ts.createSourceFile("services.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function verifyNoRequire(node) {
    if (isRequireCall(node)) throw new Error("Node require remains in the services artifact");
    ts.forEachChild(node, verifyNoRequire);
}
verifyNoRequire(stripped);
function replaceOnce(header, replacement) {
    const parts = text.split(header);
    if (parts.length !== 2) throw new Error(`expected one occurrence of ${JSON.stringify(header)}, found ${parts.length - 1}`);
    text = parts[0] + replacement + parts[1];
}
for (const header of redirected) {
    const name = /function (\w+)\(/.exec(header)[1];
    replaceOnce(header, `${header} return __rust.${name}.apply(this, arguments);`);
}
for (const [name, header] of guarded) replaceOnce(header, `${header} __rust.guard(${JSON.stringify(name)});`);

const opening = "var ts = {}; ((module) => {";
const closing = "})({ get exports() { return ts; }, set exports(v) { ts = v; if (typeof module !== \"undefined\" && module.exports) { module.exports = v; } } })";
replaceOnce(opening, "var ts = {}; ((module) => {");
const end = text.lastIndexOf(closing);
if (end < 0) throw new Error("bundle wrapper changed");
const body = text.slice(0, end) + "})({ get exports() { return ts; }, set exports(v) { ts = v; } })" + text.slice(end + closing.length).replace(/\/\/# sourceMappingURL=.*\n?$/, "");

writeFileSync(new URL("../classic-services.js", import.meta.url),
    `// Generated by scripts/generate-classic-services.mjs from typescript@${manifest.version} (gitHead ${manifest.gitHead}),\n`
    + `// lib/typescript.js sha256 ${sha256}. Microsoft TypeScript is Apache-2.0; its notice follows.\n`
    + `export function createClassicServices(__rust) {\n${body}\nreturn ts;\n}\n`);
process.stdout.write(JSON.stringify({ version: manifest.version, sha256, redirected: redirected.length, guarded: guarded.length, removedNodeRequires: requireCalls.length, toolingRanges: edits.length }) + "\n");
