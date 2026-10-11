import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [rootArg, entryArg, playwrightArg, outputArg] = process.argv.slice(2);
if (!outputArg) {
    console.error("Usage: node check-classic-browser.mjs <served-directory> <entry-relative-path> <playwright-module> <results.json>");
    process.exit(2);
}
const root = resolve(rootArg);
const entry = `/${entryArg.replace(/^\/+/, "")}`;
const { chromium, webkit } = await import(pathToFileURL(resolve(playwrightArg)).href);
const sequence = await readFile(new URL("../test/classic-public-sequence.mjs", import.meta.url));
const workerSource = `import * as ts from ${JSON.stringify(entry)};
import { verifyClassicPublic } from "/__verification/sequence.mjs";
const completed = [];
try { self.postMessage({ ok: true, result: verifyClassicPublic(ts, name => completed.push(name)) }); }
catch (error) { self.postMessage({ ok: false, error: String(error), stack: error?.stack, completed }); }`;
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const servedFiles = new Map();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") { response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Classic synchronous verification</title>"); return; }
    if (path === "/__verification/sequence.mjs") { response.writeHead(200, { "content-type": "text/javascript" }).end(sequence); return; }
    if (path === "/__verification/worker.mjs") { response.writeHead(200, { "content-type": "text/javascript" }).end(workerSource); return; }
    const file = resolve(root, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    try {
        let asset = servedFiles.get(path);
        if (!asset) {
            const bytes = await readFile(file);
            asset = { bytes, sha256: digest(bytes) };
            servedFiles.set(path, asset);
        }
        response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }).end(asset.bytes);
    } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const results = [];
let failed = false;
try {
    for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
        const browser = await type.launch({ headless: true });
        try {
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", error => errors.push(String(error)));
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            const main = await page.evaluate(async entry => {
                const completed = [];
                try {
                    const ts = await import(entry);
                    const { verifyClassicPublic } = await import("/__verification/sequence.mjs");
                    return { ok: true, result: verifyClassicPublic(ts, name => completed.push(name)) };
                } catch (error) { return { ok: false, error: String(error), stack: error?.stack, completed }; }
            }, entry);
            const worker = await page.evaluate(() => new Promise(resolve => {
                const worker = new Worker("/__verification/worker.mjs", { type: "module" });
                const timer = setTimeout(() => finish({ ok: false, error: "module worker timeout" }), 120000);
                function finish(result) { clearTimeout(timer); worker.terminate(); resolve(result); }
                worker.onmessage = event => finish(event.data);
                worker.onerror = event => finish({ ok: false, error: event.message });
            }));
            const result = { browser: name, version: browser.version(), main, worker, errors };
            results.push(result);
            console.log(JSON.stringify(result));
            failed ||= !main.ok || !worker.ok || errors.length > 0;
        } finally { await browser.close(); }
    }
} finally {
    await new Promise(resolve => server.close(resolve));
    const wasm = servedFiles.get("/ts_rust.wasm");
    const assets = Array.from(servedFiles, ([path, asset]) => ({ path, bytes: asset.bytes.length, sha256: asset.sha256 }));
    await writeFile(outputArg, JSON.stringify({ node: process.version, entry, sequenceSha256: digest(sequence), workerSha256: digest(workerSource), wasm: wasm && { bytes: wasm.bytes.length, sha256: wasm.sha256 }, assets, results }, null, 2) + "\n");
}
assert.equal(results.length, 2, "both browser engines ran");
assert.equal(failed, false, "all main-thread and module-worker cells must pass");
