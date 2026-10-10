use std::cell::{Cell, OnceCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use serde_json::{Value, json};
use ts_goport::api::proto::{DiagnosticResponse, new_diagnostic_response};
use ts_goport::core::{Diagnostic, Node};
use ts_goport::frontend::compiler::NewProgram;
use ts_goport::gostd::Context;
use ts_goport::program::ls_program;

/// The native program release is independent of the Rust `Rc` shell.
/// Active services and exported graphs therefore share this release owner.
pub struct ProgramOwner {
    pub program: Rc<NewProgram>,
    pub checker: OnceCell<crate::classic_checker::ClassicChecker>,
    pub parse_target: Cell<Option<u32>>,
    pub metadata: HashMap<String, crate::classic_metadata::SourceMetadata>,
}

impl Drop for ProgramOwner {
    fn drop(&mut self) {
        self.checker.take();
        ls_program::release_program(&self.program);
    }
}

#[derive(Default)]
pub struct Graphs {
    next_id: u32,
    programs: HashMap<u32, Rc<ProgramOwner>>,
    identities: HashMap<usize, (Weak<ProgramOwner>, u32)>,
}

impl Graphs {
    pub fn retain(&mut self, owner: &Rc<ProgramOwner>) -> u32 {
        self.identities
            .retain(|_, (owner, _)| owner.strong_count() > 0);
        let key = Rc::as_ptr(owner) as usize;
        if let Some((_, id)) = self.identities.get(&key) {
            self.programs.insert(*id, owner.clone());
            return *id;
        }
        self.next_id = self
            .next_id
            .checked_add(1)
            .expect("program handle exhausted");
        self.programs.insert(self.next_id, owner.clone());
        self.identities
            .insert(key, (Rc::downgrade(owner), self.next_id));
        self.next_id
    }

    pub fn release(&mut self, id: u32) {
        self.programs.remove(&id);
    }

    pub fn request(&mut self, context: &Context, request: &Value) -> Result<Value, String> {
        let id = request["program"]
            .as_u64()
            .ok_or("program handle is required")?;
        let id = u32::try_from(id).map_err(|error| error.to_string())?;
        let owner = self
            .programs
            .get(&id)
            .cloned()
            .ok_or("program handle has been released")?;
        let program = &owner.program;
        let _guard = ls_program::enter(program);
        let method = request["method"]
            .as_str()
            .ok_or("graph method is required")?;
        match method {
            "setParseTarget" => {
                let target = request["target"]
                    .as_u64()
                    .ok_or("parse target is required")?;
                let target = u32::try_from(target).map_err(|error| error.to_string())?;
                if owner.parse_target.get().is_none() {
                    owner.parse_target.set(Some(target));
                }
                Ok(Value::Null)
            }
            "getRootFileNames" => Ok(json!(program.command_line().file_names())),
            "getSourceFileNames" => Ok(json!(
                program
                    .get_source_files()
                    .iter()
                    .map(|file| file.file_name())
                    .collect::<Vec<_>>()
            )),
            "getCurrentDirectory" => Ok(json!(program.get_current_directory())),
            "getImpliedNodeFormatForEmit"
            | "getEmitModuleFormatOfFile"
            | "getDefaultResolutionModeForFile"
            | "getModeForUsageLocation" => resolution_mode(program, method, request),
            "getMissingFilePaths" => Ok(json!(
                program
                    .processed_files
                    .missing_files
                    .iter()
                    .map(|name| (program.to_path(name).0, name))
                    .collect::<Vec<_>>()
            )),
            "getSourceFile" => Self::source_file(&owner, &request["fileName"]),
            "getSyntacticDiagnostics"
            | "getSemanticDiagnostics"
            | "getSuggestionDiagnostics"
            | "getGlobalDiagnostics"
            | "getDeclarationDiagnostics"
            | "getConfigFileParsingDiagnostics"
            | "getOptionsDiagnostics" => {
                diagnostics(program, context, method, &request["fileName"])
            }
            _ => {
                let location = crate::classic_sources::with_sources(|sources| {
                    sources.resolve(&request["location"])
                })?;
                let checker = owner
                    .checker
                    .get_or_init(|| crate::classic_checker::ClassicChecker::new(program, context));
                let mut result = checker.request(location, request)?;
                let origin = request["origin"]
                    .as_u64()
                    .or_else(|| request["location"]["source"].as_u64());
                let origin = origin
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                crate::classic_sources::with_sources(|sources| {
                    self.attach_node_provenance(sources, &mut result, origin)
                })?;
                Ok(result)
            }
        }
    }

    fn attach_node_provenance(
        &self,
        sources: &mut crate::classic_sources::Sources,
        value: &mut Value,
        origin: Option<u32>,
    ) -> Result<(), String> {
        if value.get("$symbol").is_some()
            || value.get("$signature").is_some()
            || value.get("$type").is_some()
        {
            if let Some(origin) = origin {
                value["origin"] = json!(origin);
            }
            return Ok(());
        }
        if let Some(node) = value.get_mut("$node") {
            let file_id = node["fileId"]
                .as_u64()
                .ok_or("node file identity is missing")?;
            let same_origin = origin.filter(|&id| {
                sources
                    .origin(id)
                    .is_some_and(|(file, _)| file as u64 == file_id)
            });
            let retained =
                sources.find(usize::try_from(file_id).map_err(|error| error.to_string())?);
            let id = if let Some(id) = same_origin.or(retained) {
                id
            } else {
                let name = node["fileName"]
                    .as_str()
                    .ok_or("node file name is missing")?;
                let (file, target, version) = self
                    .programs
                    .values()
                    .find_map(|owner| {
                        let file = owner.program.get_source_file(name)?;
                        if file.root.file_index() as u64 != file_id {
                            return None;
                        }
                        let version = owner
                            .metadata
                            .get(name)
                            .map_or_else(Vec::new, |metadata| metadata.version.clone());
                        Some((file, owner.parse_target.get().unwrap_or(1), version))
                    })
                    .ok_or("node source file has been released")?;
                sources.retain(&file, target, &version)
            };
            node["source"] = json!(id);
            return Ok(());
        }
        match value {
            Value::Array(values) => {
                for value in values {
                    self.attach_node_provenance(sources, value, origin)?;
                }
            }
            Value::Object(values) => {
                for value in values.values_mut() {
                    self.attach_node_provenance(sources, value, origin)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn source_file(owner: &ProgramOwner, name: &Value) -> Result<Value, String> {
        let program = &owner.program;
        let name = name.as_str().ok_or("fileName must be a string")?;
        let Some(file) = program.get_source_file(name) else {
            return Ok(Value::Null);
        };
        let version = owner
            .metadata
            .get(name)
            .map_or(&[][..], |metadata| metadata.version.as_slice());
        let mut result = crate::classic_sources::with_sources(|sources| {
            let id = sources.retain(&file, owner.parse_target.get().unwrap_or(1), version);
            sources.response(id)
        })?;
        result["defaultLibrary"] = json!(program.is_source_file_default_library(file.path()));
        result["externalLibrary"] = json!(program.is_source_file_from_external_library(&file));
        Ok(result)
    }
}

/// A program's resolution mode for a file, or for a usage location in it.
fn resolution_mode(program: &NewProgram, method: &str, request: &Value) -> Result<Value, String> {
    let name = request["fileName"]
        .as_str()
        .ok_or("fileName must be a string")?;
    let file = program
        .get_source_file(name)
        .ok_or("file is not part of the program")?;
    let mode = match method {
        "getImpliedNodeFormatForEmit" => program.get_implied_node_format_for_emit(&*file),
        "getEmitModuleFormatOfFile" => program.get_emit_module_format_of_file(&*file),
        "getDefaultResolutionModeForFile" => program.get_default_resolution_mode_for_file(&*file),
        _ => {
            let location = crate::classic_sources::with_sources(|sources| {
                sources.resolve(&request["location"])
            })?;
            program.get_mode_for_usage_location(&*file, location)
        }
    };
    // Classic `ResolutionMode` is undefined where the port has `None`.
    Ok(if mode.0 == 0 {
        Value::Null
    } else {
        json!(mode.0)
    })
}

fn diagnostics(
    program: &NewProgram,
    context: &Context,
    method: &str,
    name: &Value,
) -> Result<Value, String> {
    let file = match name.as_str() {
        Some(name) => {
            program
                .get_source_file(name)
                .ok_or("file is not part of the program")?
                .root
        }
        None => Node::NIL,
    };
    let diagnostics = match method {
        "getSyntacticDiagnostics" => ls_program::get_syntactic_diagnostics(program, context, file),
        "getSemanticDiagnostics" => ls_program::get_semantic_diagnostics(program, context, file),
        "getSuggestionDiagnostics" => {
            ls_program::get_suggestion_diagnostics(program, context, file)
        }
        "getDeclarationDiagnostics" => {
            ls_program::get_declaration_diagnostics(program, context, file)
        }
        "getGlobalDiagnostics" => ls_program::get_global_diagnostics(program, context),
        "getConfigFileParsingDiagnostics" => {
            program.command_line().get_config_file_parsing_diagnostics()
        }
        "getOptionsDiagnostics" => ls_program::get_program_diagnostics(program),
        _ => unreachable!(),
    };
    Ok(Value::Array(diagnostics.iter().map(diagnostic).collect()))
}

pub(crate) fn diagnostic(value: &Diagnostic) -> Value {
    diagnostic_response(&new_diagnostic_response(value))
}

fn message_chain(value: &DiagnosticResponse) -> Value {
    let mut result =
        json!({"messageText": value.text, "category": value.category.0, "code": value.code});
    if !value.message_chain.is_empty() {
        result["next"] = Value::Array(value.message_chain.iter().map(message_chain).collect());
    }
    result
}

fn diagnostic_response(value: &DiagnosticResponse) -> Value {
    let mut result = json!({"category": value.category.0, "code": value.code});
    result["messageText"] = if value.message_chain.is_empty() {
        json!(value.text)
    } else {
        message_chain(value)
    };
    if !value.file_name.is_empty() {
        result["fileName"] = json!(value.file_name);
        result["start"] = json!(value.pos);
        result["length"] = json!(value.end - value.pos);
    }
    if !value.source.is_empty() {
        result["source"] = json!(value.source);
    }
    if value.reports_unnecessary {
        result["reportsUnnecessary"] = Value::Bool(true);
    }
    if value.reports_deprecated {
        result["reportsDeprecated"] = Value::Bool(true);
    }
    if !value.related_information.is_empty() {
        result["relatedInformation"] = Value::Array(
            value
                .related_information
                .iter()
                .map(diagnostic_response)
                .collect(),
        );
    }
    result
}
