// Apache-2.0. Ported from Microsoft TypeScript 6.0.3 (050880ce) src/services/services.ts:
// SourceFileObject's `getNamedDeclarations` and `computeNamedDeclarations`.
import { ModifierFlags, SyntaxKind } from "./classic-enums.js";
import { classicNamespace } from "./classic-module.js";

export function getNamedDeclarations(sourceFile, cache) {
    let result = cache.get(sourceFile);
    if (!result) {
        result = computeNamedDeclarations(sourceFile);
        cache.set(sourceFile, result);
    }
    return result;
}

function computeNamedDeclarations(sourceFile) {
    const ts = classicNamespace();
    const result = ts.createMultiMap();

    sourceFile.forEachChild(visit);

    return result;

    function addDeclaration(declaration) {
        const name = getDeclarationName(declaration);
        if (name) result.add(name, declaration);
    }

    function getDeclarations(name) {
        let declarations = result.get(name);
        if (!declarations) result.set(name, declarations = []);
        return declarations;
    }

    function getDeclarationName(declaration) {
        const name = ts.getNonAssignedNameOfDeclaration(declaration);
        return name && (ts.isComputedPropertyName(name) && ts.isPropertyAccessExpression(name.expression) ? name.expression.name.text
            : ts.isPropertyName(name) ? ts.getNameFromPropertyName(name) : undefined);
    }

    function visit(node) {
        switch (node.kind) {
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.FunctionExpression:
            case SyntaxKind.MethodDeclaration:
            case SyntaxKind.MethodSignature: {
                const functionDeclaration = node;
                const declarationName = getDeclarationName(functionDeclaration);
                if (declarationName) {
                    const declarations = getDeclarations(declarationName);
                    const lastDeclaration = ts.lastOrUndefined(declarations);
                    // Check whether this declaration belongs to an "overload group".
                    if (lastDeclaration && functionDeclaration.parent === lastDeclaration.parent && functionDeclaration.symbol === lastDeclaration.symbol) {
                        // Overwrite the last declaration if it was an overload and this one is an implementation.
                        if (functionDeclaration.body && !lastDeclaration.body) declarations[declarations.length - 1] = functionDeclaration;
                    }
                    else {
                        declarations.push(functionDeclaration);
                    }
                }
                ts.forEachChild(node, visit);
                break;
            }
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.ClassExpression:
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.TypeAliasDeclaration:
            case SyntaxKind.EnumDeclaration:
            case SyntaxKind.ModuleDeclaration:
            case SyntaxKind.ImportEqualsDeclaration:
            case SyntaxKind.ExportSpecifier:
            case SyntaxKind.ImportSpecifier:
            case SyntaxKind.ImportClause:
            case SyntaxKind.NamespaceImport:
            case SyntaxKind.GetAccessor:
            case SyntaxKind.SetAccessor:
            case SyntaxKind.TypeLiteral:
                addDeclaration(node);
                ts.forEachChild(node, visit);
                break;
            case SyntaxKind.Parameter:
                // Only consider parameter properties
                if (!ts.hasSyntacticModifier(node, ModifierFlags.ParameterPropertyModifier)) break;
            // falls through
            case SyntaxKind.VariableDeclaration:
            case SyntaxKind.BindingElement: {
                const decl = node;
                if (ts.isBindingPattern(decl.name)) {
                    ts.forEachChild(decl.name, visit);
                    break;
                }
                if (decl.initializer) visit(decl.initializer);
            }
            // falls through
            case SyntaxKind.EnumMember:
            case SyntaxKind.PropertyDeclaration:
            case SyntaxKind.PropertySignature:
                addDeclaration(node);
                break;
            case SyntaxKind.ExportDeclaration: {
                // Handle named exports case e.g.: export {a, b as B} from "mod";
                const exportDeclaration = node;
                if (exportDeclaration.exportClause) {
                    if (ts.isNamedExports(exportDeclaration.exportClause)) ts.forEach(exportDeclaration.exportClause.elements, visit);
                    else visit(exportDeclaration.exportClause.name);
                }
                break;
            }
            case SyntaxKind.ImportDeclaration: {
                const importClause = node.importClause;
                if (importClause) {
                    // Handle default import case e.g.: import d from "mod";
                    if (importClause.name) addDeclaration(importClause.name);
                    // Handle named bindings in imports e.g.: import * as NS from "mod"; import {a, b as B} from "mod";
                    if (importClause.namedBindings) {
                        if (importClause.namedBindings.kind === SyntaxKind.NamespaceImport) addDeclaration(importClause.namedBindings);
                        else ts.forEach(importClause.namedBindings.elements, visit);
                    }
                }
                break;
            }
            case SyntaxKind.BinaryExpression:
                if (ts.getAssignmentDeclarationKind(node) !== 0 /* AssignmentDeclarationKind.None */) addDeclaration(node);
            // falls through
            default:
                ts.forEachChild(node, visit);
        }
    }
}
