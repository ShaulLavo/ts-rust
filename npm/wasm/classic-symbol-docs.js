// Apache-2.0. Ported from Microsoft TypeScript 6.0.3 (050880ce) src/services/services.ts:
// the documentation and JSDoc tag members of SymbolObject and SignatureObject and their helpers.
import { SymbolFlags, SyntaxKind } from "./classic-enums.js";
import { classicNamespace } from "./classic-module.js";

function hasJSDocInheritDocTag(node) {
    return classicNamespace().getJSDocTags(node).some(tag => tag.tagName.text === "inheritDoc" || tag.tagName.text === "inheritdoc");
}

export function getJsDocTagsOfDeclarations(declarations, checker) {
    const ts = classicNamespace();
    if (!declarations) return ts.emptyArray;
    let tags = ts.JsDoc.getJsDocTagsFromDeclarations(declarations, checker);
    if (checker && (tags.length === 0 || declarations.some(hasJSDocInheritDocTag))) {
        const seenSymbols = new Set();
        for (const declaration of declarations) {
            const inheritedTags = findBaseOfDeclaration(checker, declaration, symbol => {
                if (!seenSymbols.has(symbol)) {
                    seenSymbols.add(symbol);
                    if (declaration.kind === SyntaxKind.GetAccessor || declaration.kind === SyntaxKind.SetAccessor) {
                        return symbol.getContextualJsDocTags(declaration, checker);
                    }
                    return symbol.declarations?.length === 1 ? symbol.getJsDocTags(checker) : undefined;
                }
            });
            if (inheritedTags) tags = [...inheritedTags, ...tags];
        }
    }
    return tags;
}

export function getDocumentationComment(declarations, checker) {
    const ts = classicNamespace();
    if (!declarations) return ts.emptyArray;
    let doc = ts.JsDoc.getJsDocCommentsFromDeclarations(declarations, checker);
    if (checker && (doc.length === 0 || declarations.some(hasJSDocInheritDocTag))) {
        const seenSymbols = new Set();
        for (const declaration of declarations) {
            const inheritedDocs = findBaseOfDeclaration(checker, declaration, symbol => {
                if (!seenSymbols.has(symbol)) {
                    seenSymbols.add(symbol);
                    if (declaration.kind === SyntaxKind.GetAccessor || declaration.kind === SyntaxKind.SetAccessor) {
                        return symbol.getContextualDocumentationComment(declaration, checker);
                    }
                    return symbol.getDocumentationComment(checker);
                }
            });
            if (inheritedDocs) doc = doc.length === 0 ? inheritedDocs.slice() : inheritedDocs.concat(ts.lineBreakPart(), doc);
        }
    }
    return doc;
}

function findBaseOfDeclaration(checker, declaration, cb) {
    const ts = classicNamespace();
    const classOrInterfaceDeclaration = declaration.parent?.kind === SyntaxKind.Constructor ? declaration.parent.parent : declaration.parent;
    if (!classOrInterfaceDeclaration) return;
    const isStaticMember = ts.hasStaticModifier(declaration);
    return ts.firstDefined(ts.getAllSuperTypeNodes(classOrInterfaceDeclaration), superTypeNode => {
        const baseType = checker.getTypeAtLocation(superTypeNode);
        const type = isStaticMember && baseType.symbol ? checker.getTypeOfSymbol(baseType.symbol) : baseType;
        const symbol = checker.getPropertyOfType(type, declaration.symbol.name);
        return symbol ? cb(symbol) : undefined;
    });
}

/** SymbolObject's documentation members over `symbol`, which keeps their caches. */
export function symbolDocumentationMembers(symbol) {
    const contextual = (context, checker, getKey, setKey, all, compute) => {
        const ts = classicNamespace();
        if (context) {
            if (ts.isGetAccessor(context)) {
                if (!symbol[getKey]) {
                    symbol[getKey] = ts.emptyArray;
                    symbol[getKey] = compute(ts.filter(symbol.declarations, ts.isGetAccessor), checker);
                }
                if (ts.length(symbol[getKey])) return symbol[getKey];
            }
            if (ts.isSetAccessor(context)) {
                if (!symbol[setKey]) {
                    symbol[setKey] = ts.emptyArray;
                    symbol[setKey] = compute(ts.filter(symbol.declarations, ts.isSetAccessor), checker);
                }
                if (ts.length(symbol[setKey])) return symbol[setKey];
            }
        }
        return all(checker);
    };
    const members = {
        getDocumentationComment(checker) {
            if (!symbol.documentationComment) {
                const ts = classicNamespace();
                // Set temporarily to avoid an infinite loop finding inherited docs.
                symbol.documentationComment = ts.emptyArray;
                const target = symbol.links?.target;
                symbol.documentationComment = !symbol.declarations && (symbol.flags & SymbolFlags.Transient) && target && (target.flags & SymbolFlags.Transient) && target.links?.tupleLabelDeclaration
                    ? getDocumentationComment([target.links.tupleLabelDeclaration], checker)
                    : getDocumentationComment(symbol.declarations, checker);
            }
            return symbol.documentationComment;
        },
        getContextualDocumentationComment: (context, checker) => contextual(context, checker,
            "contextualGetAccessorDocumentationComment", "contextualSetAccessorDocumentationComment", members.getDocumentationComment, getDocumentationComment),
        getJsDocTags(checker) {
            if (symbol.tags === undefined) {
                symbol.tags = classicNamespace().emptyArray;
                symbol.tags = getJsDocTagsOfDeclarations(symbol.declarations, checker);
            }
            return symbol.tags;
        },
        getContextualJsDocTags: (context, checker) => contextual(context, checker,
            "contextualGetAccessorTags", "contextualSetAccessorTags", members.getJsDocTags, getJsDocTagsOfDeclarations),
    };
    return members;
}

/** SignatureObject's documentation members over `signature` and its checker. */
export function signatureDocumentationMembers(signature, checker) {
    return {
        getDocumentationComment: () => signature.documentationComment
            || (signature.documentationComment = getDocumentationComment(classicNamespace().singleElementArray(signature.declaration), checker)),
        getJsDocTags: () => signature.jsDocTags
            || (signature.jsDocTags = getJsDocTagsOfDeclarations(classicNamespace().singleElementArray(signature.declaration), checker)),
    };
}
