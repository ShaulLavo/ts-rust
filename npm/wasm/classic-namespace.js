// Environment-neutral classic namespace setup. Only the entry's loader reads the
// module; the published services' compiler entry points delegate to Rust.
import { useClassicNamespace, useCompiledModule } from "./classic-module.js";
import { createClassicServices } from "./classic-services.js";
import { createProgram } from "./classic-create-program.js";
import { createLanguageServiceSourceFile, createSourceFile, getSetExternalModuleIndicator, updateLanguageServiceSourceFile } from "./classic-registry.js";

export function createClassicNamespace(module) {
    useCompiledModule(module);
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
    useClassicNamespace(ts);
    return ts;
}
