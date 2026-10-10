import { optionDeclarations } from "./classic-options.js";

const declarations = new Map(optionDeclarations.map(declaration => [declaration.name, declaration]));

function enumName(values, value) {
    for (const [name, member] of Object.entries(values)) if (member === value) return name;
    return value;
}

function convert(declaration, value) {
    if (declaration.kind === "enum") return enumName(declaration.values, value);
    if (declaration.kind === "list" && Array.isArray(value) && declaration.element) return value.map(element => convert(declaration.element, element));
    return value;
}

/**
 * A classic `CompilerOptions` object as tsconfig `compilerOptions`: enum values by their
 * declared names, `lib` entries by their option names. Fields that are no compiler option
 * (`configFilePath`, `pathsBasePath`, `configFile`) are left out.
 */
export function compilerOptionsToJson(options) {
    const result = {};
    for (const [name, value] of Object.entries(options ?? {})) {
        const declaration = declarations.get(name);
        if (value === undefined || !declaration) continue;
        result[name] = convert(declaration, value);
    }
    return result;
}
