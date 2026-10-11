import { sharedInstance } from "./classic-instance.js";

let compiled;

/** Sets the compiled module that classic entry points run. The package entry sets it while loading. */
export function useCompiledModule(module) {
    if (!(module instanceof WebAssembly.Module)) throw new TypeError("expected a compiled WebAssembly module");
    compiled = module;
}

export function compiledModuleOrUndefined() {
    return compiled;
}

export function compiledModule() {
    if (!compiled) throw new Error("the TypeScript compiler module is not loaded");
    return compiled;
}

/** The instance classic registries and services of the loaded module share. */
export function classicInstance() {
    return sharedInstance(compiledModule());
}

let namespace;

/** Sets the classic `ts` namespace whose utilities program objects use; the package entry sets it. */
export function useClassicNamespace(ts) {
    namespace = ts;
}

/** The classic namespace: its utilities, never its compiler, which is guarded. */
export function classicNamespace() {
    if (!namespace) throw new Error("the classic TypeScript namespace is not loaded");
    return namespace;
}

/** The classic namespace when the package entry has loaded it. */
export function classicNamespaceOrUndefined() {
    return namespace;
}
