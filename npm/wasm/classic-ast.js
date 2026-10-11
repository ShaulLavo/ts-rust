import { decodeNode, RemoteNode, RemoteNodeList } from "./native-ast.js";
import { SyntaxKind, NodeFlags, TokenFlags, ModifierFlags, EmitFlags,
    nativeSyntaxKind, nativeNodeFlags, nativeTokenFlags, nativeModifierFlags, nativeEmitFlags } from "./classic-enums.js";
import { nodeFields } from "./classic-node-fields.js";
import { classicNamespaceOrUndefined } from "./classic-module.js";

const nativeNodes = new WeakMap();
let nodeSymbol = () => undefined;

/** Sets how a parsed node answers classic `symbol` and `localSymbol`: the binder's symbols, as a checker interns them. */
export function useNodeSymbols(resolver) {
    nodeSymbol = resolver;
}
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

// NodeObject's position methods (services.ts) over the node's own `pos` and `end`, so an object
// made with `Object.create(node)` and given new positions answers with those, as classic's do.
function assertHasRealPosition(node) {
    if (!(node.pos >= 0) || !(node.end >= 0)) throw new Error("Debug Failure. False expression: Node must have a real position for this operation");
}
const positionMethods = {
    getStart(sourceFile, includeJsDocComment) {
        assertHasRealPosition(this);
        return classicNamespaceOrUndefined().getTokenPosOfNode(this, sourceFile, includeJsDocComment);
    },
    getFullStart() {
        assertHasRealPosition(this);
        return this.pos;
    },
    getEnd() {
        assertHasRealPosition(this);
        return this.end;
    },
    getWidth(sourceFile) {
        assertHasRealPosition(this);
        return this.getEnd() - this.getStart(sourceFile);
    },
    getFullWidth() {
        assertHasRealPosition(this);
        return this.end - this.pos;
    },
    getLeadingTriviaWidth(sourceFile) {
        assertHasRealPosition(this);
        return this.getStart(sourceFile) - this.pos;
    },
    getFullText(sourceFile) {
        assertHasRealPosition(this);
        return (sourceFile || this.getSourceFile()).text.substring(this.pos, this.end);
    },
    getText(sourceFile) {
        assertHasRealPosition(this);
        if (!sourceFile) sourceFile = this.getSourceFile();
        return sourceFile.text.substring(this.getStart(sourceFile), this.getEnd());
    },
};

const nodeMethods = new Set(["getSourceFile", "getStart", "getFullStart", "getEnd", "getWidth", "getFullWidth",
    "getLeadingTriviaWidth", "getFullText", "getText", "getChildCount", "getChildAt", "getChildren", "getFirstToken", "getLastToken", "forEachChild"]);
const fileMethods = new Set(["getLineStarts", "getLineAndCharacterOfPosition", "getPositionOfLineAndCharacter", "getLineEndOfPosition", "update"]);
const kindProperties = {
    Identifier: ["escapedText", "text"], PrivateIdentifier: ["escapedText", "text"],
    JSDocText: ["text"], JSDocLink: ["text"], JSDocLinkPlain: ["text"], JSDocLinkCode: ["text"],
    JSDocParameterTag: ["isNameFirst", "isBracketed"], JSDocPropertyTag: ["isNameFirst", "isBracketed"],
    JSDocTypeLiteral: ["isArrayType"], JSDocTypedefTag: ["fullName"], JSDocCallbackTag: ["fullName"],
    NumericLiteral: ["text", "numericLiteralFlags"], BigIntLiteral: ["text"], StringLiteral: ["text", "singleQuote"],
    RegularExpressionLiteral: ["text"], NoSubstitutionTemplateLiteral: ["text", "rawText", "templateFlags"],
    TemplateHead: ["text", "rawText", "templateFlags"], TemplateMiddle: ["text", "rawText", "templateFlags"], TemplateTail: ["text", "rawText", "templateFlags"],
    JsxText: ["text", "containsOnlyTriviaWhiteSpaces"], PrefixUnaryExpression: ["operator"], PostfixUnaryExpression: ["operator"],
    TypeOperator: ["operator"], HeritageClause: ["token"], MetaProperty: ["keywordToken"],
    ImportType: ["isTypeOf"], SyntaxList: ["_children"], ImportClause: ["isTypeOnly", "phaseModifier"], ImportSpecifier: ["isTypeOnly"], ExportSpecifier: ["isTypeOnly"], ExportDeclaration: ["isTypeOnly"],
    ImportEqualsDeclaration: ["isTypeOnly"], ImportAttributes: ["token", "multiLine"], ExportAssignment: ["isExportEquals"],
    SourceFile: ["text", "fileName", "path", "languageVersion", "languageVariant", "scriptKind", "isDeclarationFile", "referencedFiles",
        "typeReferenceDirectives", "libReferenceDirectives", "imports", "moduleAugmentations", "ambientModuleNames", "externalModuleIndicator", "parseDiagnostics", "bindDiagnostics", "version"],
};
const extraProperties = new Map();
for (const [kind, fields] of Object.entries(kindProperties)) extraProperties.set(nativeSyntaxKind[kind], fields);

// Classic names of native child fields, by native kind: classic name to native name.
const renamedFields = new Map(Object.entries({
    TypeParameter: { default: "defaultType" },
    JSDocSeeTag: { name: "nameExpression" },
    JSDocImplementsTag: { class: "className" },
    JSDocAugmentsTag: { class: "className" },
    JSDocTypeLiteral: { jsDocPropertyTags: "jsdocPropertyTags" },
    ImportAttributes: { elements: "attributes" },
}).map(([kind, names]) => [nativeSyntaxKind[kind], names]));
const nativeFieldNames = new Map(Array.from(renamedFields, ([kind, names]) => [kind, new Map(Object.entries(names).map(([classic, native]) => [native, classic]))]));

// Go parses the types of `implements` and of an interface's `extends` as type references; classic
// parses them as expressions with type arguments, with a dotted name as property accesses.
const heritageViews = {
    expression: { kind: nativeSyntaxKind.ExpressionWithTypeArguments, fields: { expression: "typeName", typeArguments: "typeArguments" } },
    access: { kind: nativeSyntaxKind.PropertyAccessExpression, fields: { expression: "left", name: "right", questionDotToken: undefined } },
};

function isHeritageTypeReference(raw) {
    return raw?.kind === nativeSyntaxKind.TypeReference && raw.parent?.kind === nativeSyntaxKind.HeritageClause;
}

function heritageView(raw) {
    if (raw.kind === nativeSyntaxKind.TypeReference) return isHeritageTypeReference(raw) ? heritageViews.expression : undefined;
    if (raw.kind !== nativeSyntaxKind.QualifiedName) return undefined;
    let top = raw;
    while (top.parent?.kind === nativeSyntaxKind.QualifiedName && top.parent.left?.index === top.index) top = top.parent;
    return isHeritageTypeReference(top.parent) && top.parent.typeName?.index === top.index ? heritageViews.access : undefined;
}

function viewKind(raw) {
    return heritageView(raw)?.kind ?? raw.kind;
}

function publicFields(raw) {
    const renamed = nativeFieldNames.get(raw.kind);
    const children = (childFields.get(viewKind(raw)) ?? []).flatMap(field => field === "postfixToken" ? ["questionToken", "exclamationToken"]
        : renamed?.has(field) ? [renamed.get(field)] : field ? [field] : []);
    return Array.from(new Set(["pos", "end", "kind", "id", "flags", "modifierFlagsCache", "transformFlags", "parent", "original", "emitNode"].concat(children, extraProperties.get(raw.kind) ?? [], literalFields(raw), ["jsDoc"])));
}

const literalKinds = new Set([nativeSyntaxKind.StringLiteral, nativeSyntaxKind.NumericLiteral, nativeSyntaxKind.BigIntLiteral,
    nativeSyntaxKind.RegularExpressionLiteral, nativeSyntaxKind.NoSubstitutionTemplateLiteral, nativeSyntaxKind.TemplateHead,
    nativeSyntaxKind.TemplateMiddle, nativeSyntaxKind.TemplateTail]);

/** The scanner flags a literal was parsed with. */
function literalTokenFlags(raw) {
    if (!literalKinds.has(raw.kind)) return 0;
    if (raw.kind === nativeSyntaxKind.StringLiteral || raw.kind === nativeSyntaxKind.NumericLiteral
        || raw.kind === nativeSyntaxKind.BigIntLiteral || raw.kind === nativeSyntaxKind.RegularExpressionLiteral) return raw.tokenFlags ?? 0;
    return templateFlags(raw);
}

/** Classic `parseLiteralLikeNode` sets `isUnterminated` and `hasExtendedUnicodeEscape` only when true;
 * a string literal always has `hasExtendedUnicodeEscape` (`createStringLiteral`'s parameter). */
function literalFields(raw) {
    if (!literalKinds.has(raw.kind)) return [];
    const flags = literalTokenFlags(raw);
    return (raw.kind === nativeSyntaxKind.StringLiteral || (flags & nativeTokenFlags.ExtendedUnicodeEscape) !== 0 ? ["hasExtendedUnicodeEscape"] : [])
        .concat((flags & nativeTokenFlags.Unterminated) !== 0 ? ["isUnterminated"] : []);
}

function jsDocProperties(raw) {
    if (raw.kind === nativeSyntaxKind.JSDocParameterTag || raw.kind === nativeSyntaxKind.JSDocPropertyTag) {
        return ["tagName"].concat(raw.isNameFirst ? ["name", "typeExpression"] : ["typeExpression", "name"], ["comment"]);
    }
    // Classic visits a typedef's name before a `JSDocTypeLiteral`, and a callback's before its signature.
    if (raw.kind === nativeSyntaxKind.JSDocTypedefTag && raw.typeExpression?.kind !== nativeSyntaxKind.JSDocTypeExpression
        || raw.kind === nativeSyntaxKind.JSDocCallbackTag) {
        return ["tagName", "name", "typeExpression", "comment"];
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
const emitFlagBits = flagTranslation(nativeEmitFlags, EmitFlags);

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
    if (isGlobalAugmentation(raw)) result |= NodeFlags.GlobalAugmentation;
    if (isNestedNamespace(raw)) result |= NodeFlags.NestedNamespace;
    return result;
}

/** Classic flags `global { }` (the name directly after the modifiers) with `GlobalAugmentation`; the
 * native encoding records only `namespace` or `module`. */
function isGlobalAugmentation(raw) {
    if (raw.kind !== nativeSyntaxKind.ModuleDeclaration || raw.keyword === nativeSyntaxKind.NamespaceKeyword) return false;
    const name = raw.name;
    if (name?.kind !== nativeSyntaxKind.Identifier || name.text !== "global" || !classicNamespaceOrUndefined()) return false;
    const modifiers = raw.modifiers;
    const start = modifiers?.length ? modifiers[modifiers.length - 1].end : raw.pos;
    return classicNamespaceOrUndefined().skipTrivia(raw.sourceFile.text, start) === name.getStart();
}

function isNestedNamespace(raw) {
    return raw.kind === nativeSyntaxKind.ModuleDeclaration && raw.parent?.kind === nativeSyntaxKind.ModuleDeclaration && raw.parent.body === raw;
}

/** Go's reparser puts an `as`/`satisfies` expression with the JSDoc type between a parenthesized
 * expression (or initializer, return value) and its operand; classic's tree has the operand there. */
function isReparsedCast(raw) {
    return (raw.kind === nativeSyntaxKind.AsExpression || raw.kind === nativeSyntaxKind.SatisfiesExpression)
        && (raw.type?.flags & nativeNodeFlags.Reparsed) !== 0;
}

function throughReparsedCasts(raw) {
    while (raw && typeof raw.kind === "number" && isReparsedCast(raw)) raw = raw.expression;
    return raw;
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
    // A token `getChildren` made names its parsed parent; the compiler makes the same token.
    if (data && !data.synthetic && !(data.node instanceof RemoteNode) && data.node.parent instanceof RemoteNode) {
        const parent = data.node.parent;
        return { token: { parent: { index: parent.index, fileName: data.root.fileName, nativeKind: parent.kind, source: data.lease?.source },
            nativeKind: data.node.kind, pos: data.node.pos, end: data.node.end }, source: data.lease?.source };
    }
    if (!data || data.synthetic || !(data.node instanceof RemoteNode)) throw new TypeError("Node is not backed by this compiler");
    return { index: data.node.index, fileName: data.root.fileName, nativeKind: data.node.kind, source: data.lease?.source };
}

/** Classic synthesized nodes from the node builder's binary output. */
export function decodeSyntheticNode(bytes, symbols, emitFlags = new Map(), singleQuotes = new Set(), comments = new Map()) {
    return decodeSourceFile(bytes, {}, undefined, { symbols, emitFlags, singleQuotes, comments });
}

/** Classic `SynthesizedComment`s from the builder's `[kind, text, hasLeadingNewLine, hasTrailingNewLine]`. */
function synthesizedComments(comments) {
    if (comments.length === 0) return undefined;
    return comments.map(([kind, text, hasLeadingNewLine, hasTrailingNewLine]) => ({ kind: translateKind(kind), text, pos: -1, end: -1,
        ...(hasLeadingNewLine ? { hasLeadingNewLine } : {}), ...(hasTrailingNewLine ? { hasTrailingNewLine } : {}) }));
}

export function resolveNodeHandle(sourceFile, handle) {
    const data = nativeNodes.get(sourceFile);
    if (!data) throw new TypeError("Source file is not backed by this compiler");
    let raw = data.root.getOrCreateNodeAtIndex(handle.index);
    if (raw.kind !== handle.nativeKind) throw new TypeError("Node handle does not match the source file");
    // Go's reparser clones JSDoc nodes (a `@template` type parameter) into the host declaration;
    // classic's tree has only the JSDoc node, which the clone copies with its range.
    if ((raw.flags & nativeNodeFlags.Reparsed) !== 0 && !data.synthetic) raw = parsedCounterpart(data.root, raw) ?? raw;
    return data.wrap(raw);
}

const parsedNodeIndexes = new WeakMap();
/** The first parsed (not reparsed) node of the file with the node's kind and range. */
function parsedCounterpart(root, raw) {
    let index = parsedNodeIndexes.get(root);
    if (!index) {
        index = new Map();
        const view = root.view;
        for (let i = 1; i < root.nodes.length; i++) {
            const offset = root._offsetNodes + i * 28;
            const kind = view.getUint32(offset, true);
            if (kind === 0xffffffff || (view.getUint32(offset + 24, true) & nativeNodeFlags.Reparsed) !== 0) continue;
            const key = `${kind}:${view.getInt32(offset + 4, true)}:${view.getInt32(offset + 8, true)}`;
            if (!index.has(key)) index.set(key, i);
        }
        parsedNodeIndexes.set(root, index);
    }
    const found = index.get(`${raw.kind}:${raw.pos}:${raw.end}`);
    return found === undefined ? undefined : root.getOrCreateNodeAtIndex(found);
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
export function decodeSourceFile(bytes, metadata = {}, lease, synthetic) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (data.length < 64 || data[3] !== 9) throw new RangeError("Unsupported compiler AST encoding");
    const root = decodeNode(data);
    root.getOrCreateNodeAtIndex = index => materializeParents(root, index);
    const nodes = new WeakMap();
    const arrays = new WeakMap();
    const children = new WeakMap();
    // Builder output reuses the reparsed nodes JSDoc types become: there they are real children.
    const isChild = synthetic ? raw => (raw.flags & nativeNodeFlags.Reparsed) !== 0 || isClassicChild(raw) : isClassicChild;

    function wrap(value) {
        if (Array.isArray(value)) return wrapArray(value);
        if (typeof value?.kind !== "number") return value;
        let node = nodes.get(value);
        if (node) return node;
        const overrides = {};
        const methods = new Map();
        const deleted = new Set();
        const fields = publicFields(value);
        const allowed = new Set(fields.concat(Array.from(nodeMethods), value === root && !synthetic ? Array.from(fileMethods) : []));
        // A synthesized identifier carries the symbol the node builder named it for.
        if (synthetic?.symbols.has(value.index)) overrides.symbol = synthetic.symbols.get(value.index);
        // The builder's emit flags, as classic's builder sets them with `setEmitFlags`.
        if (synthetic?.emitFlags.has(value.index)) {
            const native = synthetic.emitFlags.get(value.index);
            overrides.emitNode = { flags: translateFlags(native, emitFlagBits) };
            if (native & nativeEmitFlags.StartOnNewLine) overrides.emitNode.startsOnNewLine = true;
        }
        if (synthetic?.comments.has(value.index)) {
            const { leading, trailing } = synthetic.comments.get(value.index);
            overrides.emitNode ??= { flags: 0 };
            const leadingComments = synthesizedComments(leading);
            const trailingComments = synthesizedComments(trailing);
            if (leadingComments) overrides.emitNode.leadingComments = leadingComments;
            if (trailingComments) overrides.emitNode.trailingComments = trailingComments;
        }
        const keys = () => Reflect.isExtensible(overrides) ? Array.from(new Set(fields.filter(field => !deleted.has(field)).concat(Reflect.ownKeys(overrides)))) : Reflect.ownKeys(overrides);
        const get = property => {
            if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property, node);
            // Builder output has positions only once textChanges assigns them; classic's own node
            // methods then scan its tokens (`createChildren`) from those positions.
            if (synthetic && syntheticChildMethods.has(property)) return classicNodePrototype(translateKind(valueNode.kind))[property];
            if ((property === "symbol" || property === "localSymbol" || property === "locals") && !synthetic && !deleted.has(property)) return nodeSymbol(node, property);
            if (deleted.has(property) || !allowed.has(property)) return Reflect.get(overrides, property, node);
            const value = read(valueNode, overrides, property);
            if (typeof value !== "function") return value;
            if (!methods.has(property)) methods.set(property, value);
            return methods.get(property);
        };
        const valueNode = value;
        node = new Proxy(overrides, {
            get: (_, property) => get(property),
            set: (_, property, replacement, receiver) => {
                // An object made with `Object.create(node)` gets its own property, as an ordinary prototype gives.
                if (receiver !== node) return Reflect.defineProperty(receiver, property, { configurable: true, enumerable: true, writable: true, value: replacement });
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
        nativeNodes.set(node, { node: value, root, wrap, lease, synthetic: synthetic !== undefined });
        if (synthetic) parenthesizeChildren(node, overrides);
        return node;
    }

    function wrapArray(value) {
        let result = arrays.get(value);
        if (result) return result;
        result = Array.from(value, child => synthetic ? child : throughReparsedCasts(child)).filter(isChild).map(wrap);
        arrays.set(value, result);
        for (const property of ["pos", "end", "hasTrailingComma", "transformFlags"]) {
            if (value[property] !== undefined) result[property] = value[property];
        }
        if (synthetic) result.pos = result.end = -1;
        return result;
    }

    function read(raw, overrides, property) {
        if (Object.hasOwn(overrides, property)) return overrides[property];
        if (property === "kind") return isUnknownJSDocType(raw) ? SyntaxKind.JSDocUnknownType : translateKind(viewKind(raw));
        const view = heritageView(raw);
        if (view && Object.hasOwn(view.fields, property)) return view.fields[property] === undefined ? undefined : wrap(raw[view.fields[property]]);
        if (property === "type" && isUnknownJSDocType(raw)) return undefined;
        // Builder output is synthesized, as classic factory nodes are: no position, no parent.
        if (synthetic && (property === "pos" || property === "end")) return -1;
        if (synthetic && property === "parent") return undefined;
        // A classic JSDoc comment starts at its `/**`; the native node starts at the trivia before it.
        if (property === "pos" && raw.kind === nativeSyntaxKind.JSDoc && classicNamespaceOrUndefined()) {
            const range = classicNamespaceOrUndefined().getLeadingCommentRanges(root.text, raw.pos)?.find(comment => comment.end === raw.end);
            return range ? range.pos : raw.pos;
        }
        if (property === "flags") return translateNodeFlags(raw) | (synthetic ? NodeFlags.Synthesized : 0);
        if (property === "tokenFlags") return translateFlags(raw.tokenFlags ?? 0, tokenFlagBits);
        if (property === "templateFlags") return translateFlags(templateFlags(raw), tokenFlagBits) & TokenFlags.TemplateLiteralLikeFlags;
        if (property === "modifierFlags") return translateFlags(raw.modifierFlags ?? 0, modifierFlagBits);
        if (property === "id") return 0;
        // Classic services read `modifierFlagsCache` directly, after the classic checker has filled it
        // (`getModifierFlagsWorker`); a parsed node answers with the value that computation stores.
        if (property === "modifierFlagsCache") {
            if (synthetic || (raw.kind >= nativeSyntaxKind.FirstToken && raw.kind <= nativeSyntaxKind.LastToken)) return 0;
            return overrides.modifierFlagsCache = classicNamespaceOrUndefined().getSyntacticModifierFlagsNoCache(wrap(raw)) | ModifierFlags.HasComputedFlags;
        }
        if (property === "transformFlags") return !synthetic && containsJsx(raw) ? transformFlagsContainsJsx : 0;
        if (property === "escapedText") return escapedText(raw);
        if (property === "numericLiteralFlags") return translateFlags(raw.tokenFlags, tokenFlagBits);
        if (property === "isUnterminated") return synthetic ? undefined : true;
        if (property === "hasExtendedUnicodeEscape") return synthetic ? undefined : (literalTokenFlags(raw) & nativeTokenFlags.ExtendedUnicodeEscape) !== 0;
        if (property === "rawText" && raw.kind === nativeSyntaxKind.NoSubstitutionTemplateLiteral) {
            const delimiter = (templateFlags(raw) & nativeTokenFlags.Unterminated) !== 0 ? 0 : 1;
            return raw.sourceFile.text.slice(raw.getStart() + 1, raw.end - delimiter);
        }
        // Classic's factory leaves a template part's `rawText` undefined unless given; the port's
        // builder passes an empty one, which the printer would print in place of `text`.
        if (property === "rawText" && synthetic) return raw.rawText || undefined;
        if (property === "typeParameters" && raw.kind === nativeSyntaxKind.JSDocTemplateTag) return templateTagTypeParameters(raw);
        if (property === "questionToken" || property === "exclamationToken") return postfixToken(raw, property);
        if (property === "jsDocPropertyTags" && raw.kind === nativeSyntaxKind.JSDocTypeLiteral) return propertyTags(raw);
        const native = renamedFields.get(raw.kind)?.[property];
        if (native) return read(raw, overrides, native);
        // Classic sets `singleQuote` only on factory literals; the builder says which of its are.
        if (property === "singleQuote") return synthetic?.singleQuotes.has(raw.index) ? true : undefined;
        if (["operator", "keywordToken", "token", "phaseModifier"].includes(property)) return translateKind(raw[property]);
        if (property === "forEachChild") return synthetic
            ? (visit, visitArray) => classicNamespaceOrUndefined().forEachChild(wrap(raw), visit, visitArray)
            : (visit, visitArray) => visitChildren(raw, visit, visitArray);
        if (property === "comment" && Array.isArray(raw.comment)) return comment(raw.comment);
        if (property === "getFirstToken" || property === "getLastToken") return source => edgeToken(wrap(raw), property === "getFirstToken", source);
        if (raw === root && Object.hasOwn(metadata, property)) return metadata[property];
        if (property === "getSourceFile") return () => wrap(root);
        if (Object.hasOwn(positionMethods, property) && classicNamespaceOrUndefined()) return positionMethods[property];
        if (property === "getLineEndOfPosition") return position => {
            const { line } = root.getLineAndCharacterOfPosition(position);
            const starts = root.getLineStarts();
            let end = line + 1 >= starts.length ? root.end : undefined;
            if (!end) end = starts[line + 1] - 1;
            return root.text[end] === "\n" && root.text[end - 1] === "\r" ? end - 1 : end;
        };
        // Classic's typedef and callback tags name their full (possibly namespaced) name `fullName`
        // and its innermost identifier `name`.
        if ((raw.kind === nativeSyntaxKind.JSDocTypedefTag || raw.kind === nativeSyntaxKind.JSDocCallbackTag) && (property === "fullName" || property === "name")) {
            let name = raw.name;
            if (property === "name") while (name?.kind === nativeSyntaxKind.ModuleDeclaration) name = name.body ?? name.name;
            return wrap(name);
        }
        // Classic's `SyntaxList` keeps its children in `_children`; `getTokenPosOfNode` reads it.
        if (property === "_children" && raw.kind === nativeSyntaxKind.SyntaxList) return classicChildren(raw, wrap(root));
        if (property === "getChildren") return source => classicChildren(raw, source);
        if (property === "getChildCount") return source => classicChildren(raw, source).length;
        if (property === "getChildAt") return (index, source) => classicChildren(raw, source)[index];
        let value = raw[property];
        if (!synthetic && typeof value?.kind === "number") {
            if (property === "parent") while (value && isReparsedCast(value)) value = value.parent;
            else value = throughReparsedCasts(value);
        }
        if (typeof value === "function") return (...args) => wrap(value.apply(raw, args.map(unwrapNode)));
        if (typeof value?.kind === "number" && !isChild(value)) return undefined;
        if (property === "modifiers" && value?.length && !Array.from(value).some(isChild)) return undefined;
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
        result = raw.getChildren(unwrapNode(source)).filter(child => !isUnknownJSDocType(raw) || child !== raw.type).flatMap(child => child.kind === nativeSyntaxKind.LessThanSlashToken
            ? [syntheticToken(child, nativeSyntaxKind.LessThanToken, child.pos, child.end - 1), syntheticToken(child, nativeSyntaxKind.SlashToken, child.end - 1, child.end)]
            : isChild(child = synthetic ? child : throughReparsedCasts(child)) ? [wrap(child)] : []);
        children.set(raw, result);
        return result;
    }

    // Go's parser gives a template tag's type parameter list an empty range; classic's list starts
    // after the constraint, or where `skipWhitespaceOrAsterisk` stops after the tag name, and ends
    // where it stops after the last parameter.
    function templateTagTypeParameters(raw) {
        const list = raw.typeParameters;
        const result = wrapArray(list);
        if (!list || list.length === 0 || list.pos !== 0 || list.end !== 0) return result;
        result.pos = raw.constraint ? raw.constraint.end : skipJSDocWhitespaceOrAsterisk(raw.tagName.end, raw.end);
        result.end = skipJSDocWhitespaceOrAsterisk(list[list.length - 1].end, raw.end);
        return result;
    }

    function skipJSDocWhitespaceOrAsterisk(position, limit) {
        const text = root.text;
        let lineBreak = false;
        for (; position < limit; position++) {
            const char = text[position];
            if (char === "\n" || char === "\r") lineBreak = true;
            else if (char === "*" && lineBreak) lineBreak = false;
            else if (char !== " " && char !== "\t") break;
        }
        return position;
    }

    function comment(parts) {
        // Classic leaves `comment` undefined when the comment has no text.
        if (parts.length === 0) return undefined;
        if (Array.from(parts).every(part => part.kind === nativeSyntaxKind.JSDocText)) return Array.from(parts, part => part.text).join("");
        return wrapArray(parts);
    }

    function visitChildren(raw, visit, visitArray) {
        if (isUnknownJSDocType(raw)) return undefined;
        if (isCommentContainer(raw.kind)) return visitFields(jsDocProperties(raw), raw, visit, visitArray);
        return raw.forEachChild(child => isChild(child = synthetic ? child : throughReparsedCasts(child)) ? visit(wrap(child)) : undefined,
            visitArray && (children => Array.from(children).some(isChild) || children.length === 0 ? visitArray(wrapArray(children)) : undefined));
    }

    // Go's `JSDocPropertyTags` is a slice the encoder writes as direct children, so the native
    // field answers only the first; classic's is a plain array of every tag.
    const propertyTagLists = new WeakMap();
    function propertyTags(raw) {
        let result = propertyTagLists.get(raw);
        if (result) return result;
        result = Array.from(raw.getChildren()).filter(child => child.kind === nativeSyntaxKind.JSDocParameterTag || child.kind === nativeSyntaxKind.JSDocPropertyTag).map(wrap);
        if (result.length === 0) result = undefined;
        propertyTagLists.set(raw, result);
        return result;
    }

    function visitFields(properties, raw, visit, visitArray) {
        for (const property of properties) {
            if (property === "jsdocPropertyTags") {
                const tags = propertyTags(raw);
                const result = tags && visitNodes(tags, visit, undefined);
                if (result) return result;
                continue;
            }
            const value = raw[property];
            if (!value || (property === "comment" && !Array.isArray(comment(value)))) continue;
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

// Classic's factory parenthesizes a node's children as it creates the node, and its printer
// relies on that; the port's factory leaves it to the port's printer. Builder output therefore
// gets the parenthesization the classic constructor of each node gives.
const parenthesizedChildren = {
    ArrayType: [["elementType", "parenthesizeNonArrayTypeOfPostfixType"]],
    IndexedAccessType: [["objectType", "parenthesizeNonArrayTypeOfPostfixType"]],
    OptionalType: [["type", "parenthesizeTypeOfOptionalType"]],
    UnionType: [["types", "parenthesizeConstituentTypesOfUnionType"]],
    IntersectionType: [["types", "parenthesizeConstituentTypesOfIntersectionType"]],
    ConditionalType: [["checkType", "parenthesizeCheckTypeOfConditionalType"], ["extendsType", "parenthesizeExtendsTypeOfConditionalType"]],
    TupleType: [["elements", "parenthesizeElementTypesOfTupleType"]],
    TypeReference: [["typeArguments", "parenthesizeTypeArguments"]],
    TypeQuery: [["typeArguments", "parenthesizeTypeArguments"]],
    ImportType: [["typeArguments", "parenthesizeTypeArguments"]],
    ExpressionWithTypeArguments: [["expression", "parenthesizeLeftSideOfAccess"], ["typeArguments", "parenthesizeTypeArguments"]],
    PropertyAccessExpression: [["expression", "parenthesizeLeftSideOfAccess"]],
    ElementAccessExpression: [["expression", "parenthesizeLeftSideOfAccess"]],
    ComputedPropertyName: [["expression", "parenthesizeExpressionOfComputedPropertyName"]],
};

const parenthesizedChildrenByKind = new Map(Object.entries(parenthesizedChildren).map(([name, children]) => [SyntaxKind[name], children]));

function parenthesizeChildren(node, overrides) {
    const ts = classicNamespaceOrUndefined();
    if (!ts) return;
    const rules = ts.factory.parenthesizer;
    const kind = node.kind;
    const children = kind === SyntaxKind.TypeOperator
        ? [["type", node.operator === SyntaxKind.ReadonlyKeyword ? "parenthesizeOperandOfReadonlyTypeOperator" : "parenthesizeOperandOfTypeOperator"]]
        : parenthesizedChildrenByKind.get(kind);
    if (!children) return;
    for (const [property, rule] of children) {
        const child = node[property];
        if (child === undefined) continue;
        const result = rules[rule](child);
        if (result !== child) overrides[property] = result;
    }
}

const syntheticChildMethods = new Set(["getChildren", "getChildCount", "getChildAt", "getFirstToken", "getLastToken", "assertHasRealPosition"]);
function classicNodePrototype(kind) {
    const allocator = classicNamespaceOrUndefined().objectAllocator;
    if (kind >= SyntaxKind.FirstNode) return allocator.getNodeConstructor().prototype;
    if (kind === SyntaxKind.Identifier) return allocator.getIdentifierConstructor().prototype;
    if (kind === SyntaxKind.PrivateIdentifier) return allocator.getPrivateIdentifierConstructor().prototype;
    return allocator.getTokenConstructor().prototype;
}

// Classic `TransformFlags.ContainsJsx`, the one transform flag services read (moving JSX
// statements, JSX completions and fixes). Other flags drive classic's emit, which never runs.
const transformFlagsContainsJsx = 2;
const jsxSubtrees = new WeakMap();
function containsJsx(raw) {
    let result = jsxSubtrees.get(raw);
    if (result !== undefined) return result;
    result = raw.kind === nativeSyntaxKind.JsxText || raw.kind === nativeSyntaxKind.JsxTextAllWhiteSpaces
        || (raw.kind >= nativeSyntaxKind.JsxElement && raw.kind <= nativeSyntaxKind.JsxNamespacedName)
        || !!raw.forEachChild(child => containsJsx(child) || undefined);
    jsxSubtrees.set(raw, result);
    return result;
}

// Go parses a lone `?` JSDoc type as a nullable type over a missing reference; classic parses
// it as `JSDocUnknownType`.
function isUnknownJSDocType(raw) {
    if (raw.kind !== nativeSyntaxKind.JSDocNullableType) return false;
    const type = raw.type;
    return type?.kind === nativeSyntaxKind.TypeReference && type.pos === type.end && type.end === raw.end
        && type.typeName?.kind === nativeSyntaxKind.Identifier && type.typeName.text === "";
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
