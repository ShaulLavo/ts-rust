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
