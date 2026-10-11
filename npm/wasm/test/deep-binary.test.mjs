// Build the module first with scripts/wasm/build.sh.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule, memoryFileSystem, runTscAsync } from "../node.js";

async function check(source) {
    // Run on the calling thread: tsc()'s enlarged worker stack can hide recursion.
    return runTscAsync(await loadModule(), {
        args: ["--noEmit", "--strict", "--types", "", "--lib", "es5", "--allowUnreachableCode", "true", "/binary.ts"],
        fs: memoryFileSystem({ "/binary.ts": source }),
        diagnosticsJson: true,
    });
}

test("checks 5000 arithmetic operators on the calling thread", async () => {
    const expression = Array.from({ length: 5001 }, () => "1").join(" + ");
    const clean = await check(`const total: number = ${expression};\n`);
    assert.equal(clean.exitCode, 0);
    assert.deepEqual(clean.diagnostics, []);

    const invalid = await check(`const total: string = ${expression};\n`);
    assert.equal(invalid.exitCode, 2);
    assert.deepEqual(invalid.diagnostics.map(d => [d.code, d.startPosition, d.text]), [
        [2322, { line: 0, character: 6 }, "Type 'number' is not assignable to type 'string'."],
    ]);
});

test("keeps the final operand type across 5000 comma operators", async () => {
    const expression = Array.from({ length: 5000 }, () => "touch()").concat(['"done"']).join(", ");
    const result = await check(`declare function touch(): number;\nconst value: string = (${expression});\n`);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.diagnostics, []);
});

test("binds 5000 operators in unreachable code", async () => {
    const expression = Array.from({ length: 5001 }, () => "1").join(" + ");
    const result = await check(`function stopped() { return; const value: number = ${expression}; }\n`);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.diagnostics, []);
});

test("preserves assignment, destructuring and comma-call flow order", async () => {
    const result = await check([
        "declare function assertString(value: unknown): asserts value is string;",
        "let first: unknown;",
        "const leftCall: number = (assertString(first), first.length);",
        "let second: unknown;",
        "(0, assertString(second));",
        "const rightCall: number = second.length;",
        "let value: string | number;",
        'const narrowed: number = (value = "ready", value.length);',
        "let a: number, b: number;",
        "const assigned: number = a = b = 1;",
        "const destructured: number[] = ([a, b] = [1, 2]);",
        "declare const optional: number | undefined; const logical: number = (a && b) || (optional ?? b);",
        "const invalid = (value = 1, value.length);",
        "",
    ].join("\n"));
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.diagnostics.map(d => [d.code, d.startPosition, d.text]), [
        [2339, { line: 12, character: 34 }, "Property 'length' does not exist on type 'number'."],
    ]);
});

test("visits both binary subtrees once and retains parse diagnostics", async () => {
    const result = await check([
        "const both = (missingLeft + 1) + (missingRight + 2);",
        "const broken = 1 + ;",
        "const after: string = 1 + 2;",
        "",
    ].join("\n"));
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.diagnostics.map(d => [d.code, d.startPosition, d.text]), [
        [2304, { line: 0, character: 14 }, "Cannot find name 'missingLeft'."],
        [2304, { line: 0, character: 34 }, "Cannot find name 'missingRight'."],
        [1109, { line: 1, character: 19 }, "Expression expected."],
        [2322, { line: 2, character: 6 }, "Type 'number' is not assignable to type 'string'."],
    ]);
});
