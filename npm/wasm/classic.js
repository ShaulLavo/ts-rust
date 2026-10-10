// The classic TypeScript 6.0.3 API with the Rust compiler underneath: the published
// services code (classic-services.js, see scripts/generate-classic-services.mjs) whose
// compiler entry points run in Rust. Node entry; the module is ready when the import is.
import { loadModule } from "./node.js";
import { useCompiledModule } from "./classic-module.js";
import { createClassicServices } from "./classic-services.js";
import { createProgram } from "./classic-create-program.js";
import { createLanguageServiceSourceFile, createSourceFile, getSetExternalModuleIndicator, updateLanguageServiceSourceFile } from "./classic-registry.js";

useCompiledModule(await loadModule());

const ts = createClassicServices({
    createProgram,
    createSourceFile,
    createLanguageServiceSourceFile,
    updateLanguageServiceSourceFile,
    getSetExternalModuleIndicator,
    guard(name) {
        throw new Error(`classic ${name} is not part of this compiler; the Rust compiler does this work`);
    },
});

export default ts;
export const { createLanguageService, createDocumentRegistry, ScriptSnapshot, OperationCanceledException } = ts;
