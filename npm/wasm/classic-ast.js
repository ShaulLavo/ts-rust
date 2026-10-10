import { decodeNode, RemoteNode, RemoteNodeList } from "./native-ast.js";
import { SyntaxKind, NodeFlags, TokenFlags, ModifierFlags,
    nativeSyntaxKind, nativeNodeFlags, nativeTokenFlags, nativeModifierFlags } from "./classic-enums.js";
import { nodeFields } from "./classic-node-fields.js";

const nativeNodes = new WeakMap();
const kindNames = {
    EndOfFile: "EndOfFileToken", JSDoc: "JSDocComment", JSDocAnyType: "JSDocAllType",
    JSTypeAliasDeclaration: "TypeAliasDeclaration", JSImportDeclaration: "ImportDeclaration",
    JSDocUnknownTag: "JSDocTag",
};
const kinds = new Map();
const childFields = new Map();
for (const [name, value] of Object.entries(nativeSyntaxKind)) {
    if (typeof value !== "number") continue;
    if (name.startsWith("First") || name.startsWith("Last") || name === "Count") continue;
    const classic = SyntaxKind[kindNames[name] ?? name];
    if (classic !== undefined) kinds.set(value, classic);
    if (nodeFields[name]) childFields.set(value, nodeFields[name]);
}

const nodeMethods = new Set(["getSourceFile", "getStart", "getFullStart", "getEnd", "getWidth", "getFullWidth",
    "getLeadingTriviaWidth", "getFullText", "getText", "getChildCount", "getChildAt", "getChildren", "getFirstToken", "getLastToken", "forEachChild"]);
const fileMethods = new Set(["getLineStarts", "getLineAndCharacterOfPosition", "getPositionOfLineAndCharacter", "getLineEndOfPosition", "update"]);
const kindProperties = {
    Identifier: ["escapedText", "text"], PrivateIdentifier: ["escapedText", "text"],
    JSDocText: ["text"], JSDocLink: ["text"], JSDocLinkPlain: ["text"], JSDocLinkCode: ["text"],
    JSDocParameterTag: ["isNameFirst", "isBracketed"], JSDocPropertyTag: ["isNameFirst", "isBracketed"],
    JSDocTypeLiteral: ["isArrayType"],
    NumericLiteral: ["text", "numericLiteralFlags"], BigIntLiteral: ["text"], StringLiteral: ["text", "singleQuote"],
    RegularExpressionLiteral: ["text"], NoSubstitutionTemplateLiteral: ["text", "rawText", "templateFlags"],
    TemplateHead: ["text", "rawText", "templateFlags"], TemplateMiddle: ["text", "rawText", "templateFlags"], TemplateTail: ["text", "rawText", "templateFlags"],
    JsxText: ["text", "containsOnlyTriviaWhiteSpaces"], PrefixUnaryExpression: ["operator"], PostfixUnaryExpression: ["operator"],
    TypeOperator: ["operator"], HeritageClause: ["token"], MetaProperty: ["keywordToken"],
    ImportClause: ["isTypeOnly", "phaseModifier"], ImportSpecifier: ["isTypeOnly"], ExportSpecifier: ["isTypeOnly"], ExportDeclaration: ["isTypeOnly"],
    ImportEqualsDeclaration: ["isTypeOnly"], ImportAttributes: ["token", "multiLine"], ExportAssignment: ["isExportEquals"],
    SourceFile: ["text", "fileName", "path", "languageVersion", "languageVariant", "scriptKind", "isDeclarationFile", "referencedFiles",
        "typeReferenceDirectives", "libReferenceDirectives", "imports", "moduleAugmentations", "ambientModuleNames", "externalModuleIndicator", "parseDiagnostics", "bindDiagnostics", "version"],
};
const extraProperties = new Map();
for (const [kind, fields] of Object.entries(kindProperties)) extraProperties.set(nativeSyntaxKind[kind], fields);

function publicFields(raw) {
    const children = (childFields.get(raw.kind) ?? []).flatMap(field => field === "postfixToken" ? ["questionToken", "exclamationToken"] : field ? [field] : []);
    return Array.from(new Set(["pos", "end", "kind", "id", "flags", "modifierFlagsCache", "transformFlags", "parent", "original", "emitNode"].concat(children, extraProperties.get(raw.kind) ?? [], ["jsDoc"])));
}

function jsDocProperties(raw) {
    if (raw.kind === nativeSyntaxKind.JSDocParameterTag || raw.kind === nativeSyntaxKind.JSDocPropertyTag) {
        return ["tagName"].concat(raw.isNameFirst ? ["name", "typeExpression"] : ["typeExpression", "name"], ["comment"]);
    }
    return childFields.get(raw.kind) ?? [];
}

function isCommentContainer(kind) {
    return kind === nativeSyntaxKind.JSDoc || kind === nativeSyntaxKind.JSDocText || kind === nativeSyntaxKind.JSDocTypeLiteral
        || kind === nativeSyntaxKind.JSDocSignature || kind === nativeSyntaxKind.JSDocLink || kind === nativeSyntaxKind.JSDocLinkCode
        || kind === nativeSyntaxKind.JSDocLinkPlain || (kind >= nativeSyntaxKind.FirstJSDocTagNode && kind <= nativeSyntaxKind.LastJSDocTagNode);
}

function translateKind(value) {
    if (value === undefined) return undefined;
    const result = kinds.get(value);
    if (result === undefined) throw new RangeError(`Native AST kind has no classic representation: ${nativeSyntaxKind[value]}`);
    return result;
}

function flagTranslation(native, classic) {
    return Object.entries(native).flatMap(([name, bit]) => {
        if (typeof bit !== "number" || bit === 0 || (bit & (bit - 1)) !== 0) return [];
        const classicBit = classic[name];
        return classicBit === undefined ? [] : [[bit, classicBit]];
    });
}
const nodeFlagBits = flagTranslation(nativeNodeFlags, NodeFlags).filter(([bit]) => bit !== nativeNodeFlags.OptionalChain && bit !== nativeNodeFlags.ThisNodeOrAnySubNodesHasError);
const tokenFlagBits = flagTranslation(nativeTokenFlags, TokenFlags);
const modifierFlagBits = flagTranslation(nativeModifierFlags, ModifierFlags);

function translateFlags(value, bits) {
    let result = 0;
    for (const [native, classic] of bits) if ((value & native) !== 0) result |= classic;
    return result;
}

function translateNodeFlags(raw) {
    const flags = raw.flags ?? 0;
    let result = translateFlags(flags, nodeFlagBits);
    if ((flags & nativeNodeFlags.OptionalChain) !== 0) {
        result |= raw.kind === nativeSyntaxKind.ModuleDeclaration ? NodeFlags.NestedNamespace : NodeFlags.OptionalChain;
    }
    if (raw.kind === nativeSyntaxKind.ModuleDeclaration && raw.keyword === nativeSyntaxKind.NamespaceKeyword) result |= NodeFlags.Namespace;
    if (isNestedNamespace(raw)) result |= NodeFlags.NestedNamespace;
    return result;
}

function isNestedNamespace(raw) {
    return raw.kind === nativeSyntaxKind.ModuleDeclaration && raw.parent?.kind === nativeSyntaxKind.ModuleDeclaration && raw.parent.body === raw;
}

function isClassicChild(raw) {
    if ((raw.flags & nativeNodeFlags.Reparsed) !== 0) return false;
    return raw.kind !== nativeSyntaxKind.ExportKeyword || raw.pos !== raw.end || !isNestedNamespace(raw.parent);
}

export function unwrapNode(node) {
    return nativeNodes.get(node)?.node ?? node;
}

export function nodeLease(node) {
    return nativeNodes.get(node)?.lease;
}

export function nodeHandle(node) {
    const data = nativeNodes.get(node);
    if (!data || !(data.node instanceof RemoteNode)) throw new TypeError("Node is not backed by this compiler");
    return { index: data.node.index, fileName: data.root.fileName, nativeKind: data.node.kind, source: data.lease?.source };
}

export function resolveNodeHandle(sourceFile, handle) {
    const data = nativeNodes.get(sourceFile);
    if (!data) throw new TypeError("Source file is not backed by this compiler");
    const raw = data.root.getOrCreateNodeAtIndex(handle.index);
    if (raw.kind !== handle.nativeKind) throw new TypeError("Node handle does not match the source file");
    return data.wrap(raw);
}

function materializeParents(root, index) {
    const pending = [];
    let current = index;
    while (current !== 0 && !root.nodes[current]) {
        pending.push(current);
        current = root.view.getUint32(root._offsetNodes + current * 28 + 16, true);
    }
    while (pending.length) materializeNode(root, pending.pop());
    return root.nodes[index];
}

function materializeNode(root, index) {
    const offset = root._offsetNodes + index * 28;
    let parentIndex = root.view.getUint32(offset + 16, true);
    while (root.view.getUint32(root._offsetNodes + parentIndex * 28, true) === 0xffffffff) {
        parentIndex = root.view.getUint32(root._offsetNodes + parentIndex * 28 + 16, true);
    }
    const parent = root.nodes[parentIndex];
    root.nodes[index] = root.view.getUint32(offset, true) === 0xffffffff
        ? new RemoteNodeList(root.view, index, parent, root, root._offsetNodes)
        : new RemoteNode(root.view, index, parent, root, root._offsetNodes);
}

/** Decode the compiler's immutable AST, preserving one wrapper per native node. */
export function decodeSourceFile(bytes, metadata = {}, lease) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (data.length < 64 || data[3] !== 9) throw new RangeError("Unsupported compiler AST encoding");
    const root = decodeNode(data);
    root.getOrCreateNodeAtIndex = index => materializeParents(root, index);
    const nodes = new WeakMap();
    const arrays = new WeakMap();
    const children = new WeakMap();

    function wrap(value) {
        if (Array.isArray(value)) return wrapArray(value);
        if (typeof value?.kind !== "number") return value;
        let node = nodes.get(value);
        if (node) return node;
        const overrides = {};
        const methods = new Map();
        const deleted = new Set();
        const fields = publicFields(value);
        const allowed = new Set(fields.concat(Array.from(nodeMethods), value === root ? Array.from(fileMethods) : []));
        const keys = () => Reflect.isExtensible(overrides) ? Array.from(new Set(fields.filter(field => !deleted.has(field)).concat(Reflect.ownKeys(overrides)))) : Reflect.ownKeys(overrides);
        const get = property => {
            if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property, node);
            if (deleted.has(property) || !allowed.has(property)) return Reflect.get(overrides, property, node);
            const value = read(valueNode, overrides, property);
            if (typeof value !== "function") return value;
            if (!methods.has(property)) methods.set(property, value);
            return methods.get(property);
        };
        const valueNode = value;
        node = new Proxy(overrides, {
            get: (_, property) => get(property),
            set: (_, property, replacement) => {
                deleted.delete(property);
                return Reflect.set(overrides, property, replacement);
            },
            has: (_, property) => (!deleted.has(property) && allowed.has(property)) || Reflect.has(overrides, property),
            ownKeys: keys,
            getOwnPropertyDescriptor: (_, property) => Reflect.getOwnPropertyDescriptor(overrides, property) ?? (keys().includes(property)
                ? { configurable: true, enumerable: true, writable: true, value: get(property) } : undefined),
            deleteProperty: (_, property) => {
                if (!Reflect.deleteProperty(overrides, property)) return false;
                deleted.add(property);
                return true;
            },
            preventExtensions: () => {
                for (const property of keys()) if (!Object.hasOwn(overrides, property)) Object.defineProperty(overrides, property, { configurable: true, enumerable: true, writable: true, value: get(property) });
                return Reflect.preventExtensions(overrides);
            },
        });
        nodes.set(value, node);
        nativeNodes.set(node, { node: value, root, wrap, lease });
        return node;
    }

    function wrapArray(value) {
        let result = arrays.get(value);
        if (result) return result;
        result = Array.from(value).filter(isClassicChild).map(wrap);
        arrays.set(value, result);
        for (const property of ["pos", "end", "hasTrailingComma", "transformFlags"]) {
            if (value[property] !== undefined) result[property] = value[property];
        }
        return result;
    }

    function read(raw, overrides, property) {
        if (Object.hasOwn(overrides, property)) return overrides[property];
        if (property === "kind") return translateKind(raw.kind);
        if (property === "flags") return translateNodeFlags(raw);
        if (property === "tokenFlags") return translateFlags(raw.tokenFlags ?? 0, tokenFlagBits);
        if (property === "templateFlags") return translateFlags(templateFlags(raw), tokenFlagBits) & TokenFlags.TemplateLiteralLikeFlags;
        if (property === "modifierFlags") return translateFlags(raw.modifierFlags ?? 0, modifierFlagBits);
        if (property === "id") return 0;
        if (property === "escapedText") return escapedText(raw);
        if (property === "numericLiteralFlags") return translateFlags(raw.tokenFlags, tokenFlagBits);
        if (property === "rawText" && raw.kind === nativeSyntaxKind.NoSubstitutionTemplateLiteral) {
            const delimiter = (templateFlags(raw) & nativeTokenFlags.Unterminated) !== 0 ? 0 : 1;
            return raw.sourceFile.text.slice(raw.getStart() + 1, raw.end - delimiter);
        }
        if (property === "questionToken" || property === "exclamationToken") return postfixToken(raw, property);
        if (["operator", "keywordToken", "token", "phaseModifier"].includes(property)) return translateKind(raw[property]);
        if (property === "forEachChild") return (visit, visitArray) => visitChildren(raw, visit, visitArray);
        if (property === "comment" && Array.isArray(raw.comment)) return comment(raw.comment);
        if (property === "getFirstToken" || property === "getLastToken") return source => edgeToken(wrap(raw), property === "getFirstToken", source);
        if (raw === root && Object.hasOwn(metadata, property)) return metadata[property];
        if (property === "getSourceFile") return () => wrap(root);
        if (property === "getLineEndOfPosition") return position => {
            const { line } = root.getLineAndCharacterOfPosition(position);
            const starts = root.getLineStarts();
            let end = line + 1 >= starts.length ? root.end : undefined;
            if (!end) end = starts[line + 1] - 1;
            return root.text[end] === "\n" && root.text[end - 1] === "\r" ? end - 1 : end;
        };
        if (property === "getChildren") return source => classicChildren(raw, source);
        if (property === "getChildCount") return source => classicChildren(raw, source).length;
        if (property === "getChildAt") return (index, source) => classicChildren(raw, source)[index];
        const value = raw[property];
        if (typeof value === "function") return (...args) => wrap(value.apply(raw, args.map(unwrapNode)));
        if (typeof value?.kind === "number" && !isClassicChild(value)) return undefined;
        if (property === "modifiers" && value?.length && !Array.from(value).some(isClassicChild)) return undefined;
        return wrap(value);
    }

    function classicChildren(raw, source) {
        let result = children.get(raw);
        if (result) return result;
        if (isCommentContainer(raw.kind)) {
            result = [];
            visitChildren(raw, child => void result.push(child));
            children.set(raw, result);
            return result;
        }
        result = raw.getChildren(unwrapNode(source)).flatMap(child => child.kind === nativeSyntaxKind.LessThanSlashToken
            ? [syntheticToken(child, nativeSyntaxKind.LessThanToken, child.pos, child.end - 1), syntheticToken(child, nativeSyntaxKind.SlashToken, child.end - 1, child.end)]
            : isClassicChild(child) ? [wrap(child)] : []);
        children.set(raw, result);
        return result;
    }

    function comment(parts) {
        if (Array.from(parts).every(part => part.kind === nativeSyntaxKind.JSDocText)) return Array.from(parts, part => part.text).join("");
        return wrapArray(parts);
    }

    function visitChildren(raw, visit, visitArray) {
        if (isCommentContainer(raw.kind)) return visitFields(jsDocProperties(raw), raw, visit, visitArray);
        return raw.forEachChild(child => isClassicChild(child) ? visit(wrap(child)) : undefined,
            visitArray && (children => Array.from(children).some(isClassicChild) || children.length === 0 ? visitArray(wrapArray(children)) : undefined));
    }

    function visitFields(properties, raw, visit, visitArray) {
        for (const property of properties) {
            const value = raw[property];
            if (!value || (property === "comment" && typeof comment(value) === "string")) continue;
            const result = Array.isArray(value) ? visitNodes(wrapArray(value), visit, visitArray) : visit(wrap(value));
            if (result) return result;
        }
        return undefined;
    }

    function visitNodes(nodes, visit, visitArray) {
        if (visitArray) return visitArray(nodes);
        for (const node of nodes) {
            const result = visit(node);
            if (result) return result;
        }
        return undefined;
    }

    function syntheticToken(original, kind, pos, end) {
        const token = Object.assign(Object.create(Object.getPrototypeOf(original)), original, { kind, pos, end, flags: 0 });
        return wrap(token);
    }

    function postfixToken(raw, property) {
        const token = raw.postfixToken;
        if (!token) return wrap(raw[property]);
        const expected = property === "questionToken" ? nativeSyntaxKind.QuestionToken : nativeSyntaxKind.ExclamationToken;
        return token.kind === expected ? wrap(token) : undefined;
    }

    return wrap(root);
}

function templateFlags(raw) {
    if (raw.kind !== nativeSyntaxKind.NoSubstitutionTemplateLiteral) return raw.templateFlags ?? 0;
    const offset = raw.sourceFile._offsetExtendedData + (raw.data & 0x00ffffff);
    return raw.view.getUint32(offset + 4, true);
}

function escapedText(raw) {
    if (raw.kind !== nativeSyntaxKind.Identifier && raw.kind !== nativeSyntaxKind.PrivateIdentifier) return undefined;
    const text = raw.text;
    return text.startsWith("__") ? `_${text}` : text;
}

function edgeToken(node, first, source) {
    let current = node;
    while (current) {
        const children = current.getChildren(source);
        const child = first ? children.find(child => child.kind < SyntaxKind.FirstJSDocNode || child.kind > SyntaxKind.LastJSDocNode) : children.at(-1);
        if (!child || child.kind < SyntaxKind.FirstNode) return child;
        current = child;
    }
    return undefined;
}
