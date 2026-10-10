import { nodeHandle, nodeLease } from "./classic-ast.js";
import { SyntaxKind, TypeFlags, ObjectFlags, SymbolFlags, nativeTypeFlags, nativeObjectFlags, nativeSymbolFlags } from "./classic-enums.js";

function translateBits(flags, source, destination) {
    let result = 0;
    for (const [name, bit] of Object.entries(source)) {
        if (typeof bit !== "number" || bit === 0 || (bit & (bit - 1)) !== 0) continue;
        if ((flags & bit) !== 0) result |= destination[name] ?? 0;
    }
    return result;
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
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
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
        }), origin, true);
    }

    function signature(id, origin) {
        return intern(signatures, id, "signature", "getSignatureData", data => data, object => ({
            getDeclaration: () => object.declaration,
            getTypeParameters: () => object.typeParameters,
            getParameters: () => object.parameters,
            getReturnType: () => checker.getReturnTypeOfSignature(object),
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
    for (const method of ["getTypeAtLocation", "getTypeFromTypeNode"]) {
        checker[method] = node => query(method, { location: location(node) });
    }
    // Classic `getParseTreeNode` of a missing node is undefined, and these answer it.
    for (const [method, missing] of [["getSymbolAtLocation", undefined], ["getShorthandAssignmentValueSymbol", undefined], ["getSignatureFromDeclaration", undefined], ["isOptionalParameter", false]]) {
        checker[method] = node => node === undefined ? missing : query(method, { location: location(node) });
    }
    for (const method of ["getDeclaredTypeOfSymbol", "getTypeOfSymbol", "getAliasedSymbol", "getImmediateAliasedSymbol", "getMergedSymbol", "getRootSymbols", "getExportsOfModule", "getFullyQualifiedName"]) {
        checker[method] = object => query(method, { symbol: handle(object, "symbol"), origin: objectHandles.get(object)?.origin });
    }
    for (const method of ["getPropertiesOfType", "getAugmentedPropertiesOfType", "getBaseTypes", "getTypeArguments", "getApparentType", "getNonNullableType", "getNonOptionalType", "isNullableType", "getWidenedType", "getBaseTypeOfLiteralType", "getBaseConstraintOfType", "getDefaultFromTypeParameter", "getConstraintOfTypeParameter", "getAwaitedType", "isArrayType", "isTupleType", "isArrayLikeType"]) {
        checker[method] = object => query(method, { type: handle(object, "type"), origin: objectHandles.get(object)?.origin });
    }
    checker.getReturnTypeOfSignature = signature => query("getReturnTypeOfSignature", { signature: handle(signature, "signature"), origin: objectHandles.get(signature)?.origin });
    checker.getTypeOfSymbolAtLocation = (symbol, node) => query("getTypeOfSymbolAtLocation", { symbol: handle(symbol, "symbol"), location: location(node) });
    checker.getPropertyOfType = (type, name) => query("getPropertyOfType", { type: handle(type, "type"), name, origin: objectHandles.get(type)?.origin });
    checker.getTypeOfPropertyOfType = (type, name) => query("getTypeOfPropertyOfType", { type: handle(type, "type"), name, origin: objectHandles.get(type)?.origin });
    checker.getSignaturesOfType = (type, kind) => query("getSignaturesOfType", { type: handle(type, "type"), kind, origin: objectHandles.get(type)?.origin });
    checker.getIndexTypeOfType = (type, kind) => query("getIndexTypeOfType", { type: handle(type, "type"), kind, origin: objectHandles.get(type)?.origin });
    checker.getContextualType = (node, contextFlags = 0) => query("getContextualType", { location: location(node), contextFlags });
    checker.getResolvedSignature = node => query("getResolvedSignature", { location: location(node) });
    checker.typeToString = (type, enclosing) => query("typeToString", { type: handle(type, "type"), location: enclosing && location(enclosing), origin: objectHandles.get(type)?.origin });
    checker.symbolToString = symbol => query("symbolToString", { symbol: handle(symbol, "symbol") });
    checker.signatureToString = signature => query("signatureToString", { signature: handle(signature, "signature"), origin: objectHandles.get(signature)?.origin });
    return checker;
}
