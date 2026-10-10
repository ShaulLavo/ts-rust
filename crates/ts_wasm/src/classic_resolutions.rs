use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use serde_json::{Value, json};
use ts_goport::astdata::SyntaxKind;
use ts_goport::frontend::compiler::NewProgram;
use ts_goport::frontend::module::{
    INFERRED_TYPES_CONTAINING_FILE, ModeAwareCacheKey, ResolvedTypeReferenceDirective,
};
use ts_goport::frontend::tsoptions::{get_default_lib_file_name, get_lib_file_name};
use ts_goport::frontend::tspath::{combine_paths, get_directory_path};
use ts_goport::program::{PackageId, ResolvedModule};

/// A program's module, type reference and library resolutions in the shapes of classic
/// `resolvedModules`, `resolvedTypeReferenceDirectiveNames`, `getAutomaticTypeDirectiveResolutions`
/// and `resolvedLibReferences`. Each resolution is one entry of `resolutions`, so one
/// resolution that several names share stays one object.
///
/// The port keeps its caches in hash maps; each file's entries come back in classic's
/// insertion order, the order of the names the file resolves (helpers and JSX imports,
/// imports, module augmentations; type reference directives).
pub fn resolutions(program: &NewProgram) -> Value {
    let mut table = Table::default();
    let processed = &program.processed_files;
    let mut modules = Vec::new();
    let mut type_references = Vec::new();
    for file in program.get_source_files() {
        let path = file.path();
        if let Some(cache) = processed.resolved_modules.get(path) {
            let mut names = Vec::new();
            if processed
                .import_helpers_import_specifiers
                .as_ref()
                .is_some_and(|specifiers| specifiers.contains_key(path))
            {
                names.push("tslib".to_owned());
            }
            if let Some(jsx) = processed
                .jsx_runtime_import_specifiers
                .as_ref()
                .and_then(|specifiers| specifiers.get(path))
            {
                names.push(jsx.module_reference.clone());
            }
            names.extend(file.imports.iter().map(|node| node.text().to_owned()));
            names.extend(
                file.module_augmentations
                    .iter()
                    .filter(|node| node.kind() == SyntaxKind::StringLiteral)
                    .map(|node| node.text().to_owned()),
            );
            let entries = ordered(cache, &names)
                .into_iter()
                .map(|(key, resolution)| {
                    json!([key.name, mode(key.mode.0), table.module(resolution)])
                })
                .collect::<Vec<_>>();
            modules.push(json!([path.0, entries]));
        }
        if let Some(cache) = processed.type_resolutions_in_file.get(path) {
            let names = file
                .type_reference_directives
                .iter()
                .map(|reference| reference.file_name.clone())
                .collect::<Vec<_>>();
            let entries = ordered(cache, &names)
                .into_iter()
                .map(|(key, resolution)| {
                    json!([key.name, mode(key.mode.0), table.type_reference(resolution)])
                })
                .collect::<Vec<_>>();
            type_references.push(json!([path.0, entries]));
        }
    }
    let options = program.options();
    let containing_directory = if options.config_file_path.is_empty() {
        program.get_current_directory()
    } else {
        get_directory_path(&options.config_file_path)
    };
    let inferred = program.to_path(&combine_paths(
        &containing_directory,
        &[INFERRED_TYPES_CONTAINING_FILE],
    ));
    let automatic = processed
        .type_resolutions_in_file
        .get(&inferred)
        .map(|cache| {
            ordered(cache, options.types.as_deref().unwrap_or_default())
                .into_iter()
                .map(|(key, resolution)| {
                    json!([key.name, mode(key.mode.0), table.type_reference(resolution)])
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // Classic records a library resolution only for `lib` entries and `/// <reference lib>`
    // directives: the default library of a program without `lib` is a root file.
    let default_library = options
        .lib
        .is_none()
        .then(|| get_default_lib_file_name(options));
    let file_order = program
        .get_source_files()
        .iter()
        .enumerate()
        .map(|(index, file)| (file.path().0.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut libraries = processed
        .lib_files
        .values()
        .filter(|library| default_library.as_deref() != Some(library.name.as_str()))
        .map(|library| {
            let option = options.lib.as_ref().and_then(|names| {
                names
                    .iter()
                    .position(|name| get_lib_file_name(name).0 == library.name)
            });
            let file = file_order.get(&program.to_path(&library.path).0).copied();
            (
                (option.is_none(), option, file, library.name.clone()),
                library,
            )
        })
        .collect::<Vec<_>>();
    libraries.sort_by(|(left, _), (right, _)| left.cmp(right));
    let libraries = libraries
        .into_iter()
        .map(|(_, library)| json!([library.name, library.path, library.replaced]))
        .collect::<Vec<_>>();
    json!({
        "resolutions": table.values,
        "modules": modules,
        "typeReferences": type_references,
        "automatic": automatic,
        "libraries": libraries,
    })
}

/// The entries of `cache` in the order `names` first mentions them, then the rest by name.
fn ordered<'a, T>(
    cache: &'a HashMap<ModeAwareCacheKey, T, impl std::hash::BuildHasher>,
    names: &[String],
) -> Vec<(&'a ModeAwareCacheKey, &'a T)> {
    let mut entries = cache.iter().collect::<Vec<_>>();
    entries.sort_by_key(|(key, _)| {
        let index = names.iter().position(|name| *name == key.name);
        (index.unwrap_or(usize::MAX), key.name.clone(), key.mode.0)
    });
    entries
}

/// Classic `ResolutionMode` is undefined where the port has `None`.
fn mode(value: i32) -> Value {
    if value == 0 {
        Value::Null
    } else {
        json!(value)
    }
}

#[derive(Default)]
struct Table {
    values: Vec<Value>,
    indices: HashMap<usize, usize>,
}

impl Table {
    fn intern(&mut self, key: usize, value: impl FnOnce() -> Value) -> usize {
        *self.indices.entry(key).or_insert_with(|| {
            self.values.push(value());
            self.values.len() - 1
        })
    }

    /// Classic `ResolvedModuleWithFailedLookupLocations`. The port keeps no failed lookup
    /// or affecting locations.
    fn module(&mut self, resolution: &Arc<ResolvedModule>) -> usize {
        self.intern(Arc::as_ptr(resolution) as usize, || {
            let mut result = json!({});
            if resolution.is_resolved() {
                let mut module = json!({
                    "resolvedFileName": resolution.resolved_file_name,
                    "extension": resolution.extension,
                    "isExternalLibraryImport": resolution.is_external_library_import,
                    "resolvedUsingTsExtension": resolution.resolved_using_ts_extension,
                });
                if !resolution.original_path.is_empty() {
                    module["originalPath"] = json!(resolution.original_path);
                }
                if let Some(package) = package_id(&resolution.package_id) {
                    module["packageId"] = package;
                }
                result["resolvedModule"] = module;
            }
            if !resolution.alternate_result.is_empty() {
                result["alternateResult"] = json!(resolution.alternate_result);
            }
            result
        })
    }

    /// Classic `ResolvedTypeReferenceDirectiveWithFailedLookupLocations`.
    fn type_reference(&mut self, resolution: &Rc<ResolvedTypeReferenceDirective>) -> usize {
        self.intern(Rc::as_ptr(resolution) as usize, || {
            let mut result = json!({});
            if resolution.is_resolved() {
                let mut directive = json!({
                    "primary": resolution.primary,
                    "resolvedFileName": resolution.resolved_file_name,
                    "isExternalLibraryImport": resolution.is_external_library_import,
                });
                if !resolution.original_path.is_empty() {
                    directive["originalPath"] = json!(resolution.original_path);
                }
                if let Some(package) = package_id(&resolution.package_id) {
                    directive["packageId"] = package;
                }
                result["resolvedTypeReferenceDirective"] = directive;
            }
            result
        })
    }
}

fn package_id(package: &PackageId) -> Option<Value> {
    if package.name.is_empty() {
        return None;
    }
    let mut result = json!({
        "name": package.name,
        "subModuleName": package.sub_module_name,
        "version": package.version,
    });
    if !package.peer_dependencies.is_empty() {
        result["peerDependencies"] = json!(package.peer_dependencies);
    }
    Some(result)
}
