import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { unwrapNode } from "../classic-ast.js";
import { nativeSyntaxKind } from "../classic-enums.js";
import { fixture } from "./classic-runtime-sequence.mjs";

const skip = existsSync(new URL("../classic-services.js", import.meta.url)) ? false : "Generate classic-services.js before classic AST verification";

test("array-binding holes project as omitted expressions without changing native handles", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    for (const text of [
        "const [, x,, ...rest] = value;",
        "function f([, x = 1]) {}",
        "for (const [, x] of values) {}",
        "const [x, , [,, y]] = value;",
    ]) {
        const file = ts.createSourceFile("/holes.ts", text, ts.ScriptTarget.Latest, true);
        let holes = 0;
        const visit = node => {
            if (node.kind === ts.SyntaxKind.ArrayBindingPattern) {
                const elements = [];
                node.forEachChild(child => { elements.push(child); });
                assert.deepEqual(elements, Array.from(node.elements));
                for (const element of elements) {
                    const raw = unwrapNode(element);
                    assert.equal(raw.kind, nativeSyntaxKind.BindingElement);
                    assert.equal(element.parent, node);
                    if (raw.name) {
                        assert.equal(element.kind, ts.SyntaxKind.BindingElement);
                        assert.ok("name" in element);
                        continue;
                    }
                    holes++;
                    assert.equal(element.kind, ts.SyntaxKind.OmittedExpression);
                    assert.equal(element.pos, element.end);
                    assert.equal("name" in element, false);
                    assert.equal("initializer" in element, false);
                    assert.equal(element.name, undefined);
                    assert.deepEqual(element.getChildren(file), []);
                    assert.equal(node.elements.find(item => item === element), element);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
        assert.ok(holes > 0);
        const object = ts.createSourceFile("/object.ts", "const {x} = value;", ts.ScriptTarget.Latest, true);
        assert.equal(object.statements[0].declarationList.declarations[0].name.elements[0].kind, ts.SyntaxKind.BindingElement);
    }
});

test("breakpoint navigation skips binding holes and retains old source identities after edits", { skip }, async () => {
    const { default: ts } = await import("../classic.js");
    const project = fixture();
    const text = "function f([, name]) { return name; }";
    project.text.set("/a.ts", text);
    const service = ts.createLanguageService(project.host);
    try {
        const file = service.getProgram().getSourceFile("/a.ts");
        const elements = file.statements[0].parameters[0].name.elements;
        assert.equal(elements[0].kind, ts.SyntaxKind.OmittedExpression);
        assert.deepEqual(service.getBreakpointStatementAtPosition("/a.ts", text.indexOf(",")), { start: text.indexOf("name"), length: 4 });
        assert.equal(file.statements[0].parameters[0].name.elements[0], elements[0]);
        project.text.set("/a.ts", "function f([first, name]) { return name; }");
        project.versions.set("/a.ts", "2");
        const next = service.getProgram().getSourceFile("/a.ts");
        assert.notEqual(next, file);
        assert.equal(next.statements[0].parameters[0].name.elements[0].kind, ts.SyntaxKind.BindingElement);
        assert.equal(elements[0].kind, ts.SyntaxKind.OmittedExpression);
        assert.equal(elements[0].parent, file.statements[0].parameters[0].name);
    } finally {
        service.dispose();
    }
});
