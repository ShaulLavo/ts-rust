export function verifyClassicPublic(ts, progress = () => {}) {
    const checks = [];
    function check(value, name) {
        if (!value) throw new Error(name);
        checks.push(name);
        progress(name);
    }
    const texts = new Map([["/a.ts", 'import { value } from "./b"; export const result: number = value;'], ["/b.ts", "export const value = 1;"]]);
    const versions = new Map([["/a.ts", "1"], ["/b.ts", "1"]]);
    const calls = new Map();
    let failure;
    const host = {
        getCompilationSettings() { check(this === host, "settings callback binding"); return { noLib: true, strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }; },
        getScriptFileNames() { return ["/a.ts"]; },
        getScriptVersion(path) { return versions.get(path); },
        getScriptSnapshot(path) {
            if (failure) throw failure;
            calls.set(path, (calls.get(path) ?? 0) + 1);
            return texts.has(path) ? ts.ScriptSnapshot.fromString(texts.get(path)) : undefined;
        },
        getCurrentDirectory() { return "/"; },
        getDefaultLibFileName() { return "/lib.d.ts"; },
        useCaseSensitiveFileNames() { return true; },
        readFile(path) { return texts.get(path); },
        fileExists(path) { check(this === host, "fileExists callback binding"); return texts.has(path); },
    };
    const registry = ts.createDocumentRegistry(true, "/");
    const service = ts.createLanguageService(host, registry);
    check(typeof service.getProgram === "function" && typeof service.then !== "function", "synchronous first construction");
    let peer;
    let syntax;
    try {
        check(service.getSemanticDiagnostics("/a.ts").length === 0, "semantic diagnostics");
        const first = service.getProgram();
        check(first === service.getProgram(), "stable program identity");
        const oldB = first.getSourceFile("/b.ts");
        const checker = first.getTypeChecker();
        const name = oldB.statements[0].declarationList.declarations[0].name;
        const symbol = checker.getSymbolAtLocation(name);
        check(symbol !== undefined && symbol === checker.getSymbolAtLocation(name), "symbol identity");
        peer = ts.createLanguageService(host, registry);
        check(peer.getProgram().getSourceFile("/b.ts") === oldB, "shared registry identity");
        texts.set("/b.ts", 'export const value = "edited";');
        versions.set("/b.ts", "2");
        const diagnostics = service.getSemanticDiagnostics("/a.ts");
        const current = service.getProgram();
        check(diagnostics.length === 1 && diagnostics[0].code === 2322, "versioned edit diagnostic");
        check(diagnostics[0].file === current.getSourceFile("/a.ts"), "diagnostic file identity");
        check(current !== first && current.getSourceFile("/b.ts") !== oldB && oldB.text === "export const value = 1;", "old source retained");
        check((calls.get("/a.ts") ?? 0) > 0 && (calls.get("/b.ts") ?? 0) > 0, "host root and dependency snapshots");
        syntax = ts.createLanguageService(host, registry, ts.LanguageServiceMode.Syntactic);
        check(syntax.getProgram() === undefined, "syntactic mode");
        failure = { sentinel: "host snapshot exception" };
        versions.set("/b.ts", "3");
        let caught;
        try { service.getSemanticDiagnostics("/a.ts"); } catch (error) { caught = error; }
        check(caught === failure, "host exception identity");
        failure = undefined;
        check(service.getSemanticDiagnostics("/a.ts")[0].code === 2322, "recovery after host exception");
    } finally {
        syntax?.dispose();
        peer?.dispose();
        service.dispose();
    }
    check(true, "ordinary disposal");

    const text = `export const sum = ${Array(5000).fill("1").join(" + ")};\n`;
    const deepHost = {
        ...host,
        getCompilationSettings() { return { noLib: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }; },
        getScriptFileNames() { return ["/deep.ts"]; },
        getScriptVersion() { return "1"; },
        getScriptSnapshot(path) { return path === "/deep.ts" ? ts.ScriptSnapshot.fromString(text) : undefined; },
        readFile(path) { return path === "/deep.ts" ? text : undefined; },
        fileExists(path) { return path === "/deep.ts"; },
    };
    const deep = ts.createLanguageService(deepHost);
    let output;
    try {
        check(deep.getSyntacticDiagnostics("/deep.ts").length === 0, "deep syntax");
        check(deep.getSemanticDiagnostics("/deep.ts").length === 0, "deep semantics");
        check(deep.getQuickInfoAtPosition("/deep.ts", text.indexOf("sum")) !== undefined, "deep quick info");
        const cold = deep.getEmitOutput("/deep.ts");
        const warm = deep.getEmitOutput("/deep.ts");
        output = cold.outputFiles[0]?.text;
        check(!cold.emitSkipped && output === text && warm.outputFiles[0]?.text === output, "deep cold and warm exact emit");
    } finally { deep.dispose(); }
    check(true, "deep disposal");
    return { ok: true, checks: Array.from(new Set(checks)), deepTerms: 5000, emittedBytes: output.length };
}
