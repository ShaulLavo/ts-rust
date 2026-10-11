import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { decodeSourceFile, decodeSyntheticNode, nodeHandle, unwrapNode } from "../classic-ast.js";
import { RemoteNode } from "../native-ast.js";
import { fixture } from "./classic-runtime-sequence.mjs";

const skip = existsSync(new URL("../classic-services.js", import.meta.url)) ? false : "Generate classic-services.js before classic AST verification";
const baseFields = ["pos", "end", "kind", "id", "flags", "modifierFlagsCache", "transformFlags", "parent", "original", "emitNode"];
const identifierFields = baseFields.concat(["escapedText", "text", "jsDoc"]);
const parse = (ts, text) => {
    const file = ts.createSourceFile("/layout.ts", text, ts.ScriptTarget.Latest, true);
    assert.ok(unwrapNode(file) instanceof RemoteNode, "the parser returns the Rust-backed AST");
    assert.equal(typeof nodeHandle(file).index, "number");
    return file;
};
const initializer = file => file.statements[0].declarationList.declarations[0].initializer;
const identifier = file => file.statements[0].declarationList.declarations[0].name;

// Repeated kinds occur both before and after each distinct shape, exercising cache warming order.
test("Rust-backed layouts distinguish heritage projections and preserve field order", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    for (const text of [
        "type Before = A.B.C<number>; interface I extends A.B.C<number> {} type After = A.B.C<string>;",
        "interface I extends A.B.C<number> {} type Before = A.B.C<number>; type After = A.B.C<string>;",
    ]) {
        const file = parse(ts, text);
        for (const statement of file.statements) {
            if (statement.kind === ts.SyntaxKind.TypeAliasDeclaration) {
                const type = statement.type;
                assert.equal(type.kind, ts.SyntaxKind.TypeReference);
                assert.deepEqual(Reflect.ownKeys(type), baseFields.concat(["typeName", "typeArguments", "jsDoc"]));
                assert.deepEqual(Reflect.ownKeys(type.typeName), baseFields.concat(["left", "right", "jsDoc"]));
                assert.equal("expression" in type, false);
                assert.equal(type.expression, undefined);
                continue;
            }
            const type = statement.heritageClauses[0].types[0];
            assert.equal(type.kind, ts.SyntaxKind.ExpressionWithTypeArguments);
            assert.deepEqual(Reflect.ownKeys(type), baseFields.concat(["expression", "typeArguments", "jsDoc"]));
            assert.equal("typeName" in type, false);
            assert.equal(type.typeName, undefined);
            const access = type.expression;
            assert.equal(access.kind, ts.SyntaxKind.PropertyAccessExpression);
            assert.deepEqual(Reflect.ownKeys(access), baseFields.concat(["expression", "questionDotToken", "name", "jsDoc"]));
            assert.equal(access.questionDotToken, undefined);
            assert.equal(Object.hasOwn(access, "questionDotToken"), true);
            assert.equal(access.expression.kind, ts.SyntaxKind.PropertyAccessExpression);
            assert.equal(access.expression.expression.text, "A");
        }
    }
});

test("the same Rust source encoding has separate parsed-root and synthetic-root method layouts", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    const raw = unwrapNode(parse(ts, "const value = 1;"));
    const bytes = new Uint8Array(raw.view.buffer, raw.view.byteOffset, raw.view.byteLength);
    const parsed = decodeSourceFile(bytes);
    const synthetic = decodeSyntheticNode(bytes, new Map());
    const parsedAgain = decodeSourceFile(bytes);
    assert.deepEqual(Reflect.ownKeys(synthetic), Reflect.ownKeys(parsed));
    for (const property of ["getLineStarts", "getLineAndCharacterOfPosition", "getPositionOfLineAndCharacter", "getLineEndOfPosition", "update"]) {
        assert.equal(property in parsed, true);
        assert.equal(property in parsedAgain, true);
        assert.equal(property in synthetic, false);
        assert.equal(synthetic[property], undefined);
        assert.equal(Object.getOwnPropertyDescriptor(synthetic, property), undefined);
    }
    assert.equal(parsed.getLineStarts, parsed.getLineStarts);
    assert.equal(synthetic.getSourceFile(), synthetic);
    assert.equal(parsed.getSourceFile(), parsed);
    assert.equal(parsedAgain.getSourceFile(), parsedAgain);
    assert.notEqual(parsed.statements, parsedAgain.statements);
    assert.equal(synthetic.pos, -1);
    assert.equal(synthetic.parent, undefined);
    assert.equal(identifier(synthetic).parent, undefined);
    assert.equal(identifier(parsed).parent, parsed.statements[0].declarationList.declarations[0]);
});

test("literal layouts keep optional fields absent and separate scanner flag shapes", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    const cases = [
        ['"plain"', ["text", "singleQuote", "hasExtendedUnicodeEscape", "jsDoc"], false, undefined],
        ['"\\u{1F30A}"', ["text", "singleQuote", "hasExtendedUnicodeEscape", "jsDoc"], true, undefined],
        ['"open', ["text", "singleQuote", "hasExtendedUnicodeEscape", "isUnterminated", "jsDoc"], false, true],
        ["`plain`", ["text", "rawText", "templateFlags", "jsDoc"], undefined, undefined],
        ["`\\u{1F30A}`", ["text", "rawText", "templateFlags", "hasExtendedUnicodeEscape", "jsDoc"], true, undefined],
        ["`open", ["text", "rawText", "templateFlags", "isUnterminated", "jsDoc"], undefined, true],
        ["42", ["text", "numericLiteralFlags", "jsDoc"], undefined, undefined],
    ];
    for (const batch of [cases, cases.toReversed(), cases]) {
        for (const [literal, fields, extended, unterminated] of batch) {
            const node = initializer(parse(ts, `const value = ${literal}`));
            assert.deepEqual(Reflect.ownKeys(node), baseFields.concat(fields));
            assert.equal(node.hasExtendedUnicodeEscape, extended);
            assert.equal(node.isUnterminated, unterminated);
            for (const property of ["hasExtendedUnicodeEscape", "isUnterminated"]) {
                assert.equal(property in node, fields.includes(property));
                assert.equal(Object.hasOwn(node, property), fields.includes(property));
                assert.equal(Object.getOwnPropertyDescriptor(node, property)?.value, node[property]);
            }
        }
    }
});

test("layouts preserve own descriptors, symbols, prototype inheritance and mutation", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    const node = identifier(parse(ts, "const value = 1;"));
    const peer = identifier(parse(ts, "const other = 2;"));
    assert.deepEqual(Object.keys(node), identifierFields);
    assert.deepEqual(Object.getOwnPropertyDescriptor(node, "text"), { configurable: true, enumerable: true, writable: true, value: "value" });
    assert.equal(Object.getOwnPropertyDescriptor(node, "getEnd"), undefined);
    assert.equal("getEnd" in node, true);
    assert.equal("toString" in node, true);
    assert.equal(Object.hasOwn(node, "toString"), false);
    const inherited = Object.create(node);
    inherited.pos = 2;
    inherited.end = 7;
    inherited.text = "inherited";
    assert.equal(inherited.getFullStart(), 2);
    assert.equal(inherited.getEnd(), 7);
    assert.equal(inherited.getFullWidth(), 5);
    assert.equal(node.text, "value");
    assert.notEqual(node.pos, inherited.pos);
    assert.equal(Object.hasOwn(node, Symbol.toStringTag), false);
    const symbol = Symbol("layout");
    node[symbol] = "symbol value";
    node.extra = 1;
    assert.deepEqual(Reflect.ownKeys(node), identifierFields.concat(["extra", symbol]));
    assert.equal(Object.getOwnPropertyDescriptor(node, symbol).value, "symbol value");
    assert.equal(Reflect.deleteProperty(node, "text"), true);
    assert.equal(node.text, undefined);
    assert.equal("text" in node, false);
    assert.equal(Object.hasOwn(node, "text"), false);
    assert.deepEqual(Object.keys(node), identifierFields.filter(field => field !== "text").concat(["extra"]));
    node.text = "replacement";
    assert.deepEqual(Object.keys(node), identifierFields.concat(["extra"]));
    assert.equal(node.text, "replacement");
    const originalEnd = node.getEnd;
    node.getEnd = () => 99;
    assert.equal(node.getEnd(), 99);
    assert.equal(Reflect.deleteProperty(node, "getEnd"), true);
    assert.equal(node.getEnd, undefined);
    node.getEnd = originalEnd;
    assert.equal(node.getEnd, originalEnd);
    Object.defineProperty(node, "text", { configurable: false, enumerable: false, writable: false, value: "fixed" });
    assert.equal(Reflect.deleteProperty(node, "text"), false);
    assert.equal(Reflect.set(node, "text", "failed"), false);
    assert.equal(node.text, "fixed");
    assert.equal(Object.keys(node).includes("text"), false);
    assert.equal(Object.getOwnPropertyDescriptor(node, "text").configurable, false);
    assert.equal(Reflect.deleteProperty(node, symbol), true);
    assert.equal(node[symbol], undefined);
    const prototype = { inheritedValue: 12 };
    assert.equal(Reflect.setPrototypeOf(node, prototype), true);
    assert.equal(node.inheritedValue, 12);
    assert.equal("inheritedValue" in node, true);
    assert.equal(Object.hasOwn(node, "inheritedValue"), false);
    assert.deepEqual(Object.keys(peer), identifierFields);
    assert.equal(peer.text, "other", "shared descriptions carry no node values or mutations");
});

test("preventExtensions, seal and freeze retain proxy descriptor invariants", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    for (const lock of [Object.preventExtensions, Object.seal, Object.freeze]) {
        const node = identifier(parse(ts, "const value = 1;"));
        const keys = Reflect.ownKeys(node);
        const method = node.getEnd;
        lock(node);
        assert.equal(Object.isExtensible(node), false);
        assert.deepEqual(Reflect.ownKeys(node), keys);
        assert.equal(node.getEnd, method);
        assert.equal(Reflect.set(node, "newField", 1), false);
        assert.equal(Object.getOwnPropertyDescriptor(node, "newField"), undefined);
        assert.equal(Object.getOwnPropertyDescriptor(node, "getEnd"), undefined);
        for (const property of keys) assert.equal(Object.getOwnPropertyDescriptor(node, property).value, node[property]);
        if (lock === Object.preventExtensions) {
            assert.equal(Reflect.deleteProperty(node, "text"), true);
            assert.equal(Object.getOwnPropertyDescriptor(node, "text"), undefined);
            assert.equal(Reflect.ownKeys(node).includes("text"), false);
            assert.equal(Reflect.set(node, "text", "replacement"), false);
        } else {
            assert.equal(Object.isSealed(node), true);
            assert.equal(Reflect.deleteProperty(node, "text"), false);
            assert.equal(Object.getOwnPropertyDescriptor(node, "text").configurable, false);
            assert.equal(Reflect.set(node, "text", "replacement"), lock !== Object.freeze);
            assert.equal(Object.isFrozen(node), lock === Object.freeze);
        }
    }
});

test("parsed and Rust-synthesized nodes keep local node, method, child-array and source identities", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    const project = fixture();
    project.text.set("/a.ts", "interface Box<T> {} const value: Box<string> = {};");
    project.setSettings({ noLib: true });
    const service = ts.createLanguageService(project.host);
    try {
        const program = service.getProgram();
        const file = program.getSourceFile("/a.ts");
        assert.equal(program.getSourceFile("/a.ts"), file);
        assert.equal(file.getSourceFile(), file);
        assert.equal(file.statements, file.statements);
        const declaration = file.statements[1].declarationList.declarations[0];
        const parsed = declaration.type;
        assert.equal(parsed, file.statements[1].declarationList.declarations[0].type);
        assert.equal(parsed.parent, declaration);
        assert.equal(parsed.getSourceFile(), file);
        assert.equal(parsed.typeArguments, parsed.typeArguments);
        assert.equal(parsed.getChildren(file), parsed.getChildren(file));
        for (const property of ["getSourceFile", "getEnd", "getChildren", "forEachChild"]) assert.equal(parsed[property], parsed[property]);
        assert.equal("getLineStarts" in file, true);
        assert.equal("getLineStarts" in parsed, false);
        assert.equal(file.getLineStarts, file.getLineStarts);
        const checker = program.getTypeChecker();
        const synthetic = checker.typeToTypeNode(checker.getTypeAtLocation(declaration.name), undefined, undefined);
        assert.ok(unwrapNode(synthetic) instanceof RemoteNode, "the type builder returns Rust-backed synthesized nodes");
        assert.equal(synthetic.kind, ts.SyntaxKind.TypeReference);
        assert.equal(synthetic.pos, -1);
        assert.equal(synthetic.end, -1);
        assert.equal(synthetic.parent, undefined);
        assert.equal(synthetic.flags & ts.NodeFlags.Synthesized, ts.NodeFlags.Synthesized);
        assert.deepEqual(Reflect.ownKeys(synthetic), Reflect.ownKeys(parsed));
        assert.equal(synthetic.typeName, synthetic.typeName);
        assert.equal(synthetic.typeArguments, synthetic.typeArguments);
        assert.equal(synthetic.getSourceFile(), synthetic);
        assert.equal("getLineStarts" in synthetic, false);
        assert.equal(synthetic.getLineStarts, undefined);
        assert.equal(synthetic.getChildren, synthetic.getChildren);
        assert.throws(() => synthetic.getEnd(), /real position/);
        const inherited = Object.create(synthetic);
        inherited.pos = 3;
        inherited.end = 9;
        assert.equal(inherited.getFullStart(), 3);
        assert.equal(inherited.getEnd(), 9);
        assert.equal(parsed.getSourceFile(), file);
        assert.equal(service.getProgram(), program);
    } finally { service.dispose(); }
});
