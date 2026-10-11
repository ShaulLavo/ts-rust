import { decodeSyntheticNode, nodeHandle, nodeLease } from "./classic-ast.js";
import { classicNamespace } from "./classic-module.js";
import { signatureDocumentationMembers, symbolDocumentationMembers } from "./classic-symbol-docs.js";
import { EmitHint, NodeBuilderFlags, NodeFlags, SignatureKind, SymbolFormatFlags, SyntaxKind, TypeFormatFlags, TypeFlags, ObjectFlags, SymbolFlags, nativeSyntaxKind, nativeTypeFlags, nativeObjectFlags, nativeSymbolFlags } from "./classic-enums.js";

function translateBits(flags, source, destination) {
    let result = 0;
    for (const [name, bit] of Object.entries(source)) {
        if (typeof bit !== "number" || bit === 0 || (bit & (bit - 1)) !== 0) continue;
        if ((flags & bit) !== 0) result |= destination[name] ?? 0;
    }
    return result;
}

/** The checker member that answers a parsed node's binder symbol. */
export const nodeSymbolKey = Symbol("nodeSymbol");

// Internal classic flags (types.ts): SymbolFormatFlags and InternalNodeBuilderFlags.
const symbolFormatWriteComputedProps = 1 << 4;
const symbolFormatDoNotIncludeSymbolChain = 1 << 5;
const internalWriteComputedProps = 1 << 0;
const internalDoNotIncludeSymbolChain = 1 << 2;

/** Classic `getParseTreeNode` (utilities.ts): the node, or the first parse-tree node it came from. */
function getParseTreeNode(node, nodeTest) {
    if (node === undefined || (node.flags & NodeFlags.Synthesized) === 0) return node;
    node = node.original;
    while (node) {
        if ((node.flags & NodeFlags.Synthesized) === 0) return !nodeTest || nodeTest(node) ? node : undefined;
        node = node.original;
    }
}

/** Classic `symbolName`. */
function symbolName(symbol) {
    const name = symbol.valueDeclaration?.name;
    if (name?.kind === SyntaxKind.PrivateIdentifier && isClassElementWithName(symbol.valueDeclaration)) return name.escapedText;
    const escaped = symbol.escapedName;
    return escaped.length >= 3 && escaped.startsWith("___") ? escaped.slice(1) : escaped;
}

function isClassElementWithName(node) {
    return node.kind === SyntaxKind.PropertyDeclaration || node.kind === SyntaxKind.MethodDeclaration
        || node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor;
}

/** Intern compiler objects within the checker that owns their Rust arenas. */
export function createTypeChecker(lease, resolveNode) {
    const types = new Map();
    const symbols = new Map();
    const signatures = new Map();
    const objectHandles = new WeakMap();
    const inputLeases = new WeakMap();

    function query(method, params = {}) {
        try { return decode(lease.channel.graph(lease.handle, method, params)); }
        finally { if (params.location) inputLeases.delete(params.location); }
    }

    function location(node) {
        const handle = nodeHandle(node);
        const origin = nodeLease(node);
        if (origin) inputLeases.set(handle, origin);
        return handle;
    }

    function decode(value) {
        if (value === null) return undefined;
        if (Array.isArray(value)) return value.map(decode);
        if (typeof value !== "object") return value;
        if (value.$type) return type(value.$type, value.origin);
        if (value.$symbol) return symbol(value.$symbol, value.origin);
        if (value.$signature) return signature(value.$signature, value.origin);
        if (value.$node) return resolveNode(value.$node);
        if (value.$indexInfo) return indexInfo(value);
        if (value.$synthetic) return decodeSyntheticNode(value.$synthetic, new Map(value.symbols.map(([index, symbol]) => [index, decode(symbol)])));
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
    }

    const indexInfos = new Map();
    const indexInfoIds = new WeakMap();
    function indexInfo(value) {
        const key = String(value.$indexInfo);
        let info = indexInfos.get(key);
        if (info) return info;
        info = { keyType: decode(value.keyType), type: decode(value.type), isReadonly: value.isReadonly, declaration: decode(value.declaration) };
        indexInfoIds.set(info, value.$indexInfo);
        if (value.components) info.components = decode(value.components);
        indexInfos.set(key, info);
        return info;
    }

    /** The checker's id of `object`, or undefined for an object it does not own. */
    function ownedHandle(object, kind) {
        const reference = object && objectHandles.get(object);
        return reference?.kind === kind ? reference.id : undefined;
    }

    function handle(object, kind) {
        const reference = objectHandles.get(object);
        if (!reference || reference.kind !== kind) throw new TypeError(`${kind} is not owned by this checker`);
        return reference.id;
    }

    function type(id, origin) {
        return intern(types, id, "type", "getTypeData", data => {
            data.flags = translateBits(data.flags, nativeTypeFlags, TypeFlags);
            if (data.objectFlags !== undefined) data.objectFlags = translateBits(data.objectFlags, nativeObjectFlags, ObjectFlags);
            if ((data.flags & TypeFlags.BigIntLiteral) !== 0) data.value = { negative: data.value.startsWith("-"), base10Value: data.value.replace(/^-/, "") };
            if ((data.flags & TypeFlags.NumberLiteral) !== 0 && typeof data.value === "string") data.value = Number(data.value);
            if ((data.flags & TypeFlags.BooleanLiteral) !== 0) {
                data.intrinsicName = String(data.value);
                delete data.value;
            }
            return data;
        }, object => ({
            getFlags: () => object.flags,
            getSymbol: () => object.symbol,
            getProperties: () => checker.getPropertiesOfType(object),
            getProperty: name => checker.getPropertyOfType(object, name),
            getApparentProperties: () => checker.getAugmentedPropertiesOfType(object),
            getCallSignatures: () => checker.getSignaturesOfType(object, 0),
            getConstructSignatures: () => checker.getSignaturesOfType(object, 1),
            getBaseTypes: () => object.isClassOrInterface() ? checker.getBaseTypes(object) : undefined,
            getStringIndexType: () => checker.getIndexTypeOfType(object, 0),
            getNumberIndexType: () => checker.getIndexTypeOfType(object, 1),
            isNullableType: () => checker.isNullableType(object),
            getNonNullableType: () => checker.getNonNullableType(object),
            getNonOptionalType: () => checker.getNonOptionalType(object),
            getConstraint: () => checker.getBaseConstraintOfType(object),
            getDefault: () => checker.getDefaultFromTypeParameter(object),
            isUnion: () => (object.flags & TypeFlags.Union) !== 0,
            isIntersection: () => (object.flags & TypeFlags.Intersection) !== 0,
            isUnionOrIntersection: () => (object.flags & TypeFlags.UnionOrIntersection) !== 0,
            isLiteral: () => (object.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral | TypeFlags.BigIntLiteral)) !== 0,
            isStringLiteral: () => (object.flags & TypeFlags.StringLiteral) !== 0,
            isNumberLiteral: () => (object.flags & TypeFlags.NumberLiteral) !== 0,
            isTypeParameter: () => (object.flags & TypeFlags.TypeParameter) !== 0,
            isClassOrInterface: () => (object.flags & TypeFlags.Object) !== 0 && (object.objectFlags & ObjectFlags.ClassOrInterface) !== 0,
            isClass: () => (object.flags & TypeFlags.Object) !== 0 && (object.objectFlags & ObjectFlags.Class) !== 0,
            isIndexType: () => (object.flags & TypeFlags.Index) !== 0,
        }), origin, true);
    }

    function symbol(id, origin) {
        return intern(symbols, id, "symbol", "getSymbolData", data => {
            data.flags = translateBits(data.flags, nativeSymbolFlags, SymbolFlags);
            return data;
        }, object => ({
            getFlags: () => object.flags,
            get name() { return symbolName(object); },
            getName: () => symbolName(object),
            getEscapedName: () => object.escapedName,
            getDeclarations: () => object.declarations,
            ...symbolDocumentationMembers(object),
        }), origin, true);
    }

    function signature(id, origin) {
        return intern(signatures, id, "signature", "getSignatureData", data => data, object => ({
            getDeclaration: () => object.declaration,
            getTypeParameters: () => object.typeParameters,
            getParameters: () => object.parameters,
            getReturnType: () => checker.getReturnTypeOfSignature(object),
            ...signatureDocumentationMembers(object, checker),
        }), origin, true);
    }

    function intern(cache, id, kind, method, project, methods, origin, eager = false) {
        const key = String(id);
        const existing = cache.get(key);
        if (existing) {
            const reference = objectHandles.get(existing);
            if (reference.origin === undefined && origin !== undefined) reference.origin = origin;
            return existing;
        }
        let data;
        let operations;
        const load = () => project(query(method, { [kind]: id, origin: objectHandles.get(object).origin }));
        const object = new Proxy({}, {
            get: (_, property) => {
                operations ??= methods(object);
                if (Object.hasOwn(operations, property)) return operations[property];
                data ??= load();
                return data[property];
            },
            ownKeys: () => Reflect.ownKeys(data ??= load()),
            has: (_, property) => property in (data ??= load()) || property in (operations ??= methods(object)),
            getOwnPropertyDescriptor: (_, property) => Object.hasOwn(data ??= load(), property)
                ? { configurable: true, enumerable: true, writable: true, value: data[property] } : undefined,
            set: (_, property, replacement) => Reflect.set(data ??= load(), property, replacement),
        });
        cache.set(key, object);
        objectHandles.set(object, { id, kind, origin });
        if (eager) data = load();
        return object;
    }

    const checker = {};
    for (const method of ["getAnyType", "getStringType", "getNumberType", "getBooleanType", "getVoidType", "getUndefinedType", "getNullType", "getNeverType", "getUnknownType", "getBigIntType", "getESSymbolType"]) {
        checker[method] = () => query(method);
    }
    // Classic public methods take the parse-tree node of a synthesized one (`getParseTreeNode`,
    // optionally with a node test) and answer a default when there is none.
    const parseTree = (node, test) => getParseTreeNode(node, test && (candidate => classicNamespace()[test](candidate)));
    const errorType = () => query("getErrorType");
    for (const [method, test, missing] of [
        ["getTypeAtLocation", undefined, errorType],
        ["getTypeFromTypeNode", "isTypeNode", errorType],
        ["getSymbolAtLocation", undefined, () => undefined],
        ["getShorthandAssignmentValueSymbol", undefined, () => undefined],
        ["getSignatureFromDeclaration", "isFunctionLike", () => undefined],
        ["isOptionalParameter", "isParameter", () => false],
    ]) {
        checker[method] = nodeIn => {
            const node = parseTree(nodeIn, test);
            return node ? query(method, { location: location(node) }) : missing();
        };
    }
    for (const method of ["getDeclaredTypeOfSymbol", "getTypeOfSymbol", "getAliasedSymbol", "getImmediateAliasedSymbol", "getMergedSymbol", "getRootSymbols", "getExportsOfModule", "getFullyQualifiedName"]) {
        checker[method] = object => query(method, { symbol: handle(object, "symbol"), origin: objectHandles.get(object)?.origin });
    }
    for (const method of ["getPropertiesOfType", "getAugmentedPropertiesOfType", "getBaseTypes", "getTypeArguments", "getApparentType", "getNonNullableType", "getNonOptionalType", "isNullableType", "getWidenedType", "getBaseTypeOfLiteralType", "getBaseConstraintOfType", "getDefaultFromTypeParameter", "getConstraintOfTypeParameter", "getAwaitedType", "isArrayType", "isTupleType", "isArrayLikeType"]) {
        checker[method] = object => query(method, { type: handle(object, "type"), origin: objectHandles.get(object)?.origin });
    }
    // Classic compares with its own unknown, undefined and arguments symbols.
    for (const method of ["isUnknownSymbol", "isUndefinedSymbol", "isArgumentsSymbol"]) {
        checker[method] = object => {
            const id = ownedHandle(object, "symbol");
            return id !== undefined && query(method, { symbol: id });
        };
    }
    const meaning = flags => translateBits(flags, SymbolFlags, nativeSymbolFlags);
    checker.getSymbolsInScope = (nodeIn, flags) => {
        const node = parseTree(nodeIn);
        return node ? query("getSymbolsInScope", { location: location(node), meaning: meaning(flags) }) : [];
    };
    let ambientModules;
    checker.getAmbientModules = () => ambientModules ??= query("getAmbientModules");
    checker.tryGetThisTypeAt = (nodeIn, includeGlobalThis, container) => {
        const node = parseTree(nodeIn);
        return node && query("tryGetThisTypeAt", { location: location(node), includeGlobalThis, container: container === undefined ? undefined : location(container) });
    };
    checker.resolveName = (name, node, flags, excludeGlobals) => query("resolveName", { name, location: node === undefined ? undefined : location(node), meaning: meaning(flags), excludeGlobals });
    checker.getResolvedSignatureForSignatureHelp = (node, candidatesOutArray, argumentCount) => {
        const { signature, candidates } = query("getResolvedSignatureForSignatureHelp", { location: location(node), argumentCount });
        if (candidatesOutArray) candidatesOutArray.push(...candidates);
        return signature;
    };
    checker.containsArgumentsReference = declaration => query("containsArgumentsReference", { location: location(declaration) });
    checker.getPromisedTypeOfPromise = (type, errorNode) => query("getPromisedTypeOfPromise", { type: handle(type, "type"), errorNode: errorNode === undefined ? undefined : location(errorNode), origin: objectHandles.get(type)?.origin });
    checker.createArrayType = (elementType, readonly) => query("createArrayType", { type: handle(elementType, "type"), readonly, origin: objectHandles.get(elementType)?.origin });
    for (const method of ["getElementTypeOfArrayType", "getIndexInfosOfType"]) {
        checker[method] = object => query(method, { type: handle(object, "type"), origin: objectHandles.get(object)?.origin });
    }
    checker.getIndexInfoOfType = (type, kind) => query("getIndexInfoOfType", { type: handle(type, "type"), kind, origin: objectHandles.get(type)?.origin });
    // Classic answers with a generator; this iterator reads the same properties eagerly.
    checker.getUnmatchedProperties = (source, target, requireOptionalProperties, matchDiscriminantProperties) => query("getUnmatchedProperties", {
        type: handle(source, "type"), target: handle(target, "type"), requireOptionalProperties, matchDiscriminantProperties, origin: objectHandles.get(source)?.origin,
    }).values();
    // Classic runs the callback with the token set for its checker's own polling. The Rust
    // checker does not poll a classic token yet, so work inside the callback runs to its end.
    checker.runWithCancellationToken = (token, callback) => callback(checker);
    const nodeSymbols = new WeakMap();
    checker[nodeSymbolKey] = (node, local) => {
        const key = local ? "localSymbol" : "symbol";
        let symbols = nodeSymbols.get(node);
        if (!symbols) nodeSymbols.set(node, symbols = {});
        if (!(key in symbols)) symbols[key] = query("getNodeSymbol", { location: location(node), local });
        return symbols[key];
    };
    const typeOf = type => ({ type: handle(type, "type"), origin: objectHandles.get(type)?.origin });
    checker.isImplementationOfOverload = nodeIn => {
        const node = parseTree(nodeIn, "isFunctionLike");
        return node ? query("isImplementationOfOverload", { location: location(node) }) : undefined;
    };
    checker.isValidPropertyAccess = (nodeIn, propertyName) => {
        const node = parseTree(nodeIn, "isPropertyAccessOrQualifiedNameOrImportTypeNode");
        return !!node && query("isValidPropertyAccess", { location: location(node), name: propertyName });
    };
    checker.isValidPropertyAccessForCompletions = (nodeIn, type, property) => {
        const node = parseTree(nodeIn, "isPropertyAccessExpression");
        return !!node && query("isValidPropertyAccessForCompletions", Object.assign(typeOf(type), { location: location(node), symbol: handle(property, "symbol") }));
    };
    checker.isPropertyAccessible = (node, isSuper, isWrite, containingType, property) => query("isPropertyAccessible",
        Object.assign(typeOf(containingType), { location: location(node), isSuper, isWrite, symbol: handle(property, "symbol") }));
    checker.getJsxNamespace = node => query("getJsxNamespace", { location: node === undefined ? undefined : location(node) });
    checker.getTypeArgumentConstraint = nodeIn => {
        const node = parseTree(nodeIn, "isTypeNode");
        return node && query("getTypeArgumentConstraint", { location: location(node) });
    };
    checker.getExportSpecifierLocalTargetSymbol = nodeIn => {
        const node = parseTree(nodeIn, "isExportSpecifier");
        return node ? query("getExportSpecifierLocalTargetSymbol", { location: location(node) }) : undefined;
    };
    // Classic also takes a name string here; the services pass the name node.
    checker.getSuggestedSymbolForNonexistentProperty = (name, containingType) => query("getSuggestedSymbolForNonexistentProperty", Object.assign(typeOf(containingType), { location: location(name) }));
    checker.getCandidateSignaturesForStringLiteralCompletions = (call, editingArgument) => query("getCandidateSignaturesForStringLiteralCompletions", { location: location(call), editingArgument: location(editingArgument) });
    for (const method of ["getExportsAndPropertiesOfModule", "resolveExternalModuleSymbol"]) {
        checker[method] = symbol => query(method, { symbol: handle(symbol, "symbol"), origin: objectHandles.get(symbol)?.origin });
    }
    checker.getParameterType = (signature, index) => query("getParameterType", { signature: handle(signature, "signature"), index, origin: objectHandles.get(signature)?.origin });
    checker.getPromiseType = () => query("getPromiseType");
    for (const method of ["createPromiseType", "getIndexType"]) {
        checker[method] = type => query(method, typeOf(type));
    }
    // Classic's internal `getUnionType(types, unionReduction = UnionReduction.Literal)`.
    checker.getUnionType = (types, reduction = 1) => query("getUnionType", { types: types.map(type => handle(type, "type")), reduction });
    checker.isTypeAssignableTo = (source, target) => query("isTypeAssignableTo", Object.assign(typeOf(source), { target: handle(target, "type") }));
    // Classic checks the file, here without polling the token, and answers its diagnostics.
    checker.getDiagnostics = sourceFile => query("getDiagnostics", { location: sourceFile === undefined ? undefined : location(sourceFile) }).map(lease.diagnostic);
    checker.getGlobalDiagnostics = () => query("getGlobalDiagnostics").map(lease.diagnostic);
    // Classic `nodeBuilder`: Rust's node builder answers with synthesized nodes. The builder
    // takes no symbol tracker, maximum length or verbosity level.
    function build(operation, params, enclosing, flags, internalFlags) {
        return query("nodeBuilder", Object.assign({ operation, location: enclosing === undefined ? undefined : location(enclosing), flags: flags ?? 0, internalFlags: internalFlags ?? 0 }, params));
    }
    const typeParams = type => ({ type: handle(type, "type"), origin: objectHandles.get(type)?.origin });
    const symbolParams = (symbol, flags) => ({ symbol: handle(symbol, "symbol"), meaning: meaning(flags ?? 0) });
    checker.typeToTypeNode = (type, enclosing, flags, internalFlags) => build("typeToTypeNode", typeParams(type), enclosing, flags, internalFlags)[0];
    checker.typeParameterToDeclaration = (parameter, enclosing, flags, internalFlags) => build("typeParameterToDeclaration", typeParams(parameter), enclosing, flags, internalFlags)[0];
    for (const operation of ["symbolToEntityName", "symbolToExpression", "symbolToNode"]) {
        checker[operation] = (symbol, symbolMeaning, enclosing, flags, internalFlags) => build(operation, symbolParams(symbol, symbolMeaning), enclosing, flags, internalFlags)[0];
    }
    checker.symbolToParameterDeclaration = (symbol, enclosing, flags, internalFlags) => build("symbolToParameterDeclaration", symbolParams(symbol), enclosing, flags, internalFlags)[0];
    checker.symbolToTypeParameterDeclarations = (symbol, enclosing, flags, internalFlags) => {
        const nodes = build("symbolToTypeParameterDeclarations", symbolParams(symbol), enclosing, flags, internalFlags);
        return nodes.length ? classicNamespace().factory.createNodeArray(nodes) : undefined;
    };
    checker.signatureToSignatureDeclaration = (signature, kind, enclosing, flags, internalFlags) => build("signatureToSignatureDeclaration", {
        signature: handle(signature, "signature"), kind: nativeSyntaxKind[SyntaxKind[kind]], origin: objectHandles.get(signature)?.origin,
    }, enclosing, flags, internalFlags)[0];
    checker.indexInfoToIndexSignatureDeclaration = (info, enclosing, flags, internalFlags) => {
        const id = indexInfoIds.get(info);
        if (id === undefined) throw new TypeError("index info is not owned by this checker");
        return build("indexInfoToIndexSignatureDeclaration", { indexInfo: id }, enclosing, flags, internalFlags)[0];
    };

    /** Classic `symbolToString` with a writer. */
    function writeSymbol(symbol, enclosing, symbolMeaning, flags = SymbolFormatFlags.AllowAnyNodeKind, writer) {
        let nodeFlags = NodeBuilderFlags.IgnoreErrors;
        let internalFlags = 0;
        if (flags & SymbolFormatFlags.UseOnlyExternalAliasing) nodeFlags |= NodeBuilderFlags.UseOnlyExternalAliasing;
        if (flags & SymbolFormatFlags.WriteTypeParametersOrArguments) nodeFlags |= NodeBuilderFlags.WriteTypeParametersInQualifiedName;
        if (flags & SymbolFormatFlags.UseAliasDefinedOutsideCurrentScope) nodeFlags |= NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope;
        if (flags & symbolFormatDoNotIncludeSymbolChain) internalFlags |= internalDoNotIncludeSymbolChain;
        if (flags & symbolFormatWriteComputedProps) internalFlags |= internalWriteComputedProps;
        const ts = classicNamespace();
        const entity = checker[flags & SymbolFormatFlags.AllowAnyNodeKind ? "symbolToNode" : "symbolToEntityName"](symbol, symbolMeaning, enclosing, nodeFlags, internalFlags);
        const printer = enclosing?.kind === SyntaxKind.SourceFile ? ts.createPrinterWithRemoveCommentsNeverAsciiEscape() : ts.createPrinterWithRemoveComments();
        printer.writeNode(EmitHint.Unspecified, entity, enclosing && ts.getSourceFileOfNode(enclosing), writer);
        return writer;
    }

    /** Classic `typeToString` with a writer. */
    function writeType(type, enclosing, flags = TypeFormatFlags.AllowUniqueESSymbolType | TypeFormatFlags.UseAliasDefinedOutsideCurrentScope, writer, maximumLength) {
        const ts = classicNamespace();
        const noTruncation = !maximumLength && lease.settings.noErrorTruncation || flags & TypeFormatFlags.NoTruncation;
        const typeNode = checker.typeToTypeNode(type, enclosing, (flags & TypeFormatFlags.NodeBuilderFlagsMask) | NodeBuilderFlags.IgnoreErrors | (noTruncation ? NodeBuilderFlags.NoTruncation : 0));
        if (typeNode === undefined) throw new Error("Debug Failure. should always get typenode");
        ts.createPrinterWithRemoveComments().writeNode(EmitHint.Unspecified, typeNode, enclosing && ts.getSourceFileOfNode(enclosing), writer);
        const result = writer.getText();
        const maxLength = noTruncation ? ts.noTruncationMaximumTruncationLength * 2 : ts.defaultMaximumTruncationLength * 2;
        if (maxLength && result && result.length >= maxLength) return result.substr(0, maxLength - "...".length) + "...";
        return result;
    }

    /** Classic `signatureToString` with a writer. */
    function writeSignature(signature, enclosing, flags = TypeFormatFlags.None, kind, writer) {
        const ts = classicNamespace();
        const output = flags & TypeFormatFlags.WriteArrowStyleSignature
            ? (kind === SignatureKind.Construct ? SyntaxKind.ConstructorType : SyntaxKind.FunctionType)
            : (kind === SignatureKind.Construct ? SyntaxKind.ConstructSignature : SyntaxKind.CallSignature);
        const declaration = checker.signatureToSignatureDeclaration(signature, output, enclosing, (flags & TypeFormatFlags.NodeBuilderFlagsMask) | NodeBuilderFlags.IgnoreErrors | NodeBuilderFlags.WriteTypeParametersInQualifiedName);
        ts.createPrinterWithRemoveCommentsOmitTrailingSemicolon().writeNode(EmitHint.Unspecified, declaration, enclosing && ts.getSourceFileOfNode(enclosing), ts.getTrailingSemicolonDeferringWriter(writer));
        return writer;
    }

    checker.writeSymbol = (symbol, enclosing, symbolMeaning, flags, writer) => writeSymbol(symbol, parseTree(enclosing), symbolMeaning, flags, writer).getText();
    checker.writeType = (type, enclosing, flags, writer, maximumLength) => writeType(type, parseTree(enclosing), flags, writer, maximumLength);
    checker.writeSignature = (signature, enclosing, flags, kind, writer) => writeSignature(signature, parseTree(enclosing), flags, kind, writer).getText();
    checker.getReturnTypeOfSignature = signature => query("getReturnTypeOfSignature", { signature: handle(signature, "signature"), origin: objectHandles.get(signature)?.origin });
    checker.getTypeOfSymbolAtLocation = (symbol, locationIn) => {
        const node = parseTree(locationIn);
        return node ? query("getTypeOfSymbolAtLocation", { symbol: handle(symbol, "symbol"), location: location(node) }) : errorType();
    };
    checker.getPropertyOfType = (type, name) => query("getPropertyOfType", { type: handle(type, "type"), name, origin: objectHandles.get(type)?.origin });
    checker.getTypeOfPropertyOfType = (type, name) => query("getTypeOfPropertyOfType", { type: handle(type, "type"), name, origin: objectHandles.get(type)?.origin });
    checker.getSignaturesOfType = (type, kind) => query("getSignaturesOfType", { type: handle(type, "type"), kind, origin: objectHandles.get(type)?.origin });
    checker.getIndexTypeOfType = (type, kind) => query("getIndexTypeOfType", { type: handle(type, "type"), kind, origin: objectHandles.get(type)?.origin });
    checker.getContextualType = (nodeIn, contextFlags = 0) => {
        const node = parseTree(nodeIn, "isExpression");
        return node ? query("getContextualType", { location: location(node), contextFlags }) : undefined;
    };
    checker.getResolvedSignature = node => query("getResolvedSignature", { location: location(node) });
    checker.typeToString = (type, enclosingIn) => {
        const enclosing = parseTree(enclosingIn);
        return query("typeToString", { type: handle(type, "type"), location: enclosing && location(enclosing), origin: objectHandles.get(type)?.origin });
    };
    checker.symbolToString = symbol => query("symbolToString", { symbol: handle(symbol, "symbol") });
    checker.signatureToString = signature => query("signatureToString", { signature: handle(signature, "signature"), origin: objectHandles.get(signature)?.origin });
    return checker;
}
