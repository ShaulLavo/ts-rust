import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const entry = process.argv[2];
if (!entry) throw new TypeError('performance-workload.mjs <classic-entry.js>');
const loadStarted = performance.now();
const imported = await import(pathToFileURL(resolve(entry)).href);
const ts = imported.default ?? imported;
const moduleLoadMs = performance.now() - loadStarted;
assert.equal(typeof ts.createLanguageService, 'function');
assert.equal(typeof ts.createDocumentRegistry, 'function');

const path = '/benchmark/main.ts';
const declaration = 'export const value = { count: 1, label: "ready" };\n';
const lines = Array.from({ length: 2000 }, (_, i) => `const item${i}: number = ${i};`);
const initial = declaration + lines.join('\n') + '\nvalue.count;\n';
const position = initial.lastIndexOf('value.count') + 'value.'.length;
let text = initial;
let version = 1;
let snapshot = ts.ScriptSnapshot.fromString(text);
const counts = { readFile: 0, getScriptSnapshot: 0, fileExists: 0, getScriptVersion: 0 };
const host = {
  getCompilationSettings: () => ({ noLib: true, strict: true, target: ts.ScriptTarget.ES2020 }),
  getScriptFileNames: () => [path],
  getScriptVersion: name => { counts.getScriptVersion++; return name === path ? String(version) : '0'; },
  getScriptSnapshot: name => { counts.getScriptSnapshot++; return name === path ? snapshot : undefined; },
  getCurrentDirectory: () => '/benchmark',
  getDefaultLibFileName: () => '/benchmark/lib.d.ts',
  readFile: name => { counts.readFile++; return name === path ? text : undefined; },
  fileExists: name => { counts.fileExists++; return name === path; },
  useCaseSensitiveFileNames: () => true,
  getNewLine: () => '\n',
};
const phases = [];
function measure(name, operation) {
  const before = { ...counts };
  const started = performance.now();
  const value = operation();
  assert.equal(value?.then, undefined, `${name} must be synchronous`);
  phases.push({ name, milliseconds: performance.now() - started,
    hostCalls: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key]])) });
  return value;
}
let service;
try {
  service = measure('construction', () => ts.createLanguageService(host, ts.createDocumentRegistry(true, '/benchmark')));
  measure('open', () => {
    assert.equal(service.getProgram().getSourceFile(path).text, text);
    assert.equal(service.getSyntacticDiagnostics(path).length, 0);
    assert.equal(service.getSemanticDiagnostics(path).length, 0);
  });
  const repetitions = 30;
  for (let i = 0; i < repetitions; i++) {
    text = initial + `// edit ${i}\n`;
    version++;
    snapshot = ts.ScriptSnapshot.fromString(text);
    measure('edit', () => assert.equal(service.getProgram().getSourceFile(path).text, text));
    measure('completions', () => {
      const result = service.getCompletionsAtPosition(path, position, {});
      assert.ok(result.entries.some(entry => entry.name === 'count'));
      assert.ok(result.entries.some(entry => entry.name === 'label'));
    });
    measure('quickInfo', () => assert.ok(service.getQuickInfoAtPosition(path, position)));
    measure('diagnostics', () => {
      assert.equal(service.getSyntacticDiagnostics(path).length, 0);
      assert.equal(service.getSemanticDiagnostics(path).length, 0);
    });
  }
  const source = service.getProgram().getSourceFile(path);
  measure('lineMapFirstProbe', () => {
    const value = source.getLineAndCharacterOfPosition(initial.length - 1);
    assert.equal(value.line, 2001);
  });
  measure('lineMapRepeatedProbe', () => {
    for (let i = 0; i < 20000; i++) {
      const offset = (i * 7919) % text.length;
      const location = source.getLineAndCharacterOfPosition(offset);
      assert.equal(source.getPositionOfLineAndCharacter(location.line, location.character), offset);
    }
  });
  const grouped = {};
  for (const phase of phases) {
    const group = grouped[phase.name] ??= { samples: [], hostCalls: Object.fromEntries(Object.keys(counts).map(key => [key, 0])) };
    group.samples.push(phase.milliseconds);
    for (const key of Object.keys(counts)) group.hostCalls[key] += phase.hostCalls[key];
  }
  for (const group of Object.values(grouped)) {
    group.samples.sort((a, b) => a - b);
    group.count = group.samples.length;
    group.totalMs = group.samples.reduce((sum, value) => sum + value, 0);
    group.medianMs = group.samples[Math.floor(group.samples.length / 2)];
    group.p95Ms = group.samples[Math.ceil(group.samples.length * 0.95) - 1];
  }
  console.log(JSON.stringify({ entry: resolve(entry), entrySha256: createHash('sha256').update(readFileSync(resolve(entry))).digest('hex'),
    version: ts.version, node: process.version, moduleLoadMs, fixtureSha256: createHash('sha256').update(initial).digest('hex'),
    fixtureBytes: Buffer.byteLength(initial), repetitions, counts, grouped, phases }));
} finally {
  service?.dispose();
}
