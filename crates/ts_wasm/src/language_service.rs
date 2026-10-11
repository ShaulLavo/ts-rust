//! A message-driven editor host. The native server's thread and timer loops are not needed here.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use serde_json::Value;
use ts_goport::api::proto::new_diagnostic_responses;
use ts_goport::ast::FileText;
use ts_goport::core::Diagnostic;
use ts_goport::execute::tsc::{System, new_os_system};
use ts_goport::frontend::compiler::{self, ProgramOptions};
use ts_goport::frontend::json::{MarshalerTo, UnmarshalerFrom, json_marshal, json_unmarshal};
use ts_goport::frontend::tsoptions::command_line_option::CompilerOptionsValue;
use ts_goport::frontend::tsoptions::parsed_command_line::new_parsed_command_line;
use ts_goport::frontend::tsoptions::parsing_helpers::CompilerOptionsParser;
use ts_goport::frontend::tsoptions::tsconfig_p1::{
    COMMAND_LINE_COMPILER_OPTIONS_MAP, convert_options_from_json,
};
use ts_goport::frontend::tsoptions::{self, ParsedCommandLine};
use ts_goport::frontend::tspath;
use ts_goport::frontend::vfs::{Fs, OsOverride, install_os_override};
use ts_goport::gostd::{Context, GoError, context};
use ts_goport::ls::{self, lsconv, lsutil};
use ts_goport::lsp::lsproto;
use ts_goport::options::Tristate;
use ts_goport::program::ls_program;
use ts_goport::scanner_util::go_string_from_utf8;
use ts_goport::sourcemap;

use crate::host;

enum ServiceError {
    Parse(String),
    InvalidParams(String),
    MethodNotFound(String),
    Internal(String),
    Configuration { message: String, diagnostics: Value },
}

impl From<String> for ServiceError {
    fn from(message: String) -> Self {
        Self::InvalidParams(message)
    }
}
impl From<&str> for ServiceError {
    fn from(message: &str) -> Self {
        Self::InvalidParams(message.into())
    }
}
impl ServiceError {
    fn response(self) -> String {
        let (code, message, data) = match self {
            Self::Parse(message) => (-32700, message, Value::Null),
            Self::InvalidParams(message) => (-32602, message, Value::Null),
            Self::MethodNotFound(method) => (
                -32601,
                format!("unsupported language service method: {method}"),
                Value::Null,
            ),
            Self::Internal(message) => (-32603, message, Value::Null),
            Self::Configuration {
                message,
                diagnostics,
            } => (
                -32602,
                message,
                serde_json::json!({"diagnostics": diagnostics}),
            ),
        };
        serde_json::json!({"error": {"code": code, "message": message, "data": data}}).to_string()
    }
}

fn check_config(diagnostics: &[Diagnostic]) -> Result<(), ServiceError> {
    if !diagnostics
        .iter()
        .any(|diagnostic| diagnostic.category() == ts_goport::diagnostics::Category::Error)
    {
        return Ok(());
    }
    let diagnostics = new_diagnostic_responses(diagnostics);
    let message = diagnostics
        .iter()
        .map(|diagnostic| format!("TS{}: {}", diagnostic.code, diagnostic.text))
        .collect::<Vec<_>>()
        .join("\n");
    let json = json_marshal(&diagnostics, &[])
        .map_err(|error| ServiceError::Internal(error.to_string()))?;
    let diagnostics =
        serde_json::from_str(&json).map_err(|error| ServiceError::Internal(error.to_string()))?;
    Err(ServiceError::Configuration {
        message,
        diagnostics,
    })
}

#[derive(Clone, Copy, serde::Deserialize)]
enum Method {
    #[serde(rename = "textDocument/hover")]
    Hover,
    #[serde(rename = "textDocument/completion")]
    Completion,
    #[serde(rename = "textDocument/definition")]
    Definition,
    #[serde(rename = "textDocument/typeDefinition")]
    TypeDefinition,
    #[serde(rename = "textDocument/references")]
    References,
    #[serde(rename = "textDocument/rename")]
    Rename,
    #[serde(rename = "textDocument/implementation")]
    Implementation,
    #[serde(rename = "textDocument/documentHighlight")]
    DocumentHighlight,
    #[serde(rename = "textDocument/diagnostic")]
    Diagnostic,
    #[serde(rename = "textDocument/signatureHelp")]
    SignatureHelp,
    #[serde(rename = "textDocument/documentSymbol")]
    DocumentSymbol,
    #[serde(rename = "textDocument/codeAction")]
    CodeAction,
    #[serde(rename = "textDocument/formatting")]
    Formatting,
    #[serde(rename = "textDocument/rangeFormatting")]
    RangeFormatting,
    #[serde(rename = "textDocument/semanticTokens/full")]
    SemanticTokensFull,
    #[serde(rename = "textDocument/semanticTokens/range")]
    SemanticTokensRange,
}

/// Installs the host file system once per instance. Sessions pass their
/// current directory and case sensitivity with each request instead.
pub fn ensure_runtime() {
    if !ts_goport::frontend::vfs::os_override_installed() {
        install_os_override(OsOverride {
            fs: Arc::new(|| Rc::new(host::HostFs::new()) as Rc<dyn Fs>),
            current_directory: "/".into(),
        });
    }
    ts_goport::ast::set_editor_process();
}

/// The roots and options of a classic `createProgram` call, in place of tsc arguments.
#[derive(Clone)]
struct ProgramConfig {
    root_names: Vec<String>,
    options: Value,
    /// Classic `defaultLibraryPath`: the directory of the host's default library,
    /// whose files the compiler host supplies like any other file.
    default_library_path: Option<String>,
}

pub struct Service {
    cwd: String,
    args: Vec<String>,
    program_config: Option<ProgramConfig>,
    context: Context,
    case_sensitive: bool,
    /// Whether builds take source files from the host's documents.
    documents: bool,
    language: Option<ls::LanguageService>,
    program_owner: Option<Rc<crate::classic_graph::ProgramOwner>>,
    /// Kept until the next build acquires its parses, so unchanged files reuse them.
    previous_owner: Option<Rc<crate::classic_graph::ProgramOwner>>,
    graphs: crate::classic_graph::Graphs,
    retired: bool,
}

impl Service {
    fn new(request: &Value) -> Result<Self, ServiceError> {
        let cwd = request.get("cwd").and_then(Value::as_str).unwrap_or("/");
        if !cwd.starts_with('/') {
            return Err("cwd must be an absolute path".into());
        }
        let args: Vec<String> =
            serde_json::from_value(request["args"].clone()).map_err(|error| error.to_string())?;
        let capabilities = decode::<lsproto::ClientCapabilities>(
            request
                .get("capabilities")
                .unwrap_or(&serde_json::json!({})),
        )?;
        let context = lsproto::with_client_capabilities(
            &context::background(),
            Arc::new(lsproto::ClientCapabilities::resolve(Some(&capabilities))),
        );
        let case_sensitive = !request["caseInsensitive"].as_bool().unwrap_or(false);
        ensure_runtime();
        Ok(Self {
            cwd: cwd.into(),
            args,
            program_config: None,
            context,
            case_sensitive,
            documents: request["documents"].as_bool().unwrap_or(false),
            language: None,
            program_owner: None,
            previous_owner: None,
            graphs: crate::classic_graph::Graphs::default(),
            retired: false,
        })
    }

    fn invalidate(&mut self) {
        let Some(language) = self.language.take() else {
            return;
        };
        drop(language);
        self.previous_owner = self.program_owner.take();
    }

    fn release_unused(&mut self) {
        self.previous_owner.take();
        crate::classic_metadata::with_pools(crate::classic_metadata::ParsePools::prune);
    }

    fn language(&mut self) -> Result<&ls::LanguageService, ServiceError> {
        if self.retired {
            return Err("language service is disposed".into());
        }
        if self.language.is_none() {
            let (language, metadata) = build_language(
                &self.cwd,
                &self.args,
                self.program_config.as_ref(),
                self.case_sensitive,
                self.documents,
            )?;
            self.program_owner = Some(Rc::new(crate::classic_graph::ProgramOwner {
                program: language.program.clone(),
                checker: std::cell::OnceCell::new(),
                parse_target: std::cell::Cell::new(None),
                metadata,
            }));
            self.language = Some(language);
            self.release_unused();
        }
        self.language
            .as_ref()
            .ok_or_else(|| ServiceError::Internal("language service is unavailable".into()))
    }

    /// The subset of `paths` the current program could not load.
    fn missing_files(&self, paths: &Value) -> Result<String, ServiceError> {
        let Some(language) = self.language.as_ref() else {
            return Ok("[]".into());
        };
        let paths: Vec<String> =
            serde_json::from_value(paths.clone()).map_err(|error| error.to_string())?;
        let program = &language.program;
        let missing: Vec<&String> = paths
            .iter()
            .filter(|path| program.is_missing_path(&program.to_path(path)))
            .collect();
        serde_json::to_string(&missing).map_err(|error| ServiceError::Internal(error.to_string()))
    }

    fn request(&mut self, method: &str, params: &Value) -> Result<String, ServiceError> {
        let method: Method = serde_json::from_value(Value::String(method.into()))
            .map_err(|_| ServiceError::MethodNotFound(method.into()))?;
        let mut params = params.clone();
        let context = self.context.clone();
        let language = self.language()?;
        let _guard = language.enter_program();
        normalize_document(language, &mut params)?;
        dispatch(language, &context, method, &params)
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.invalidate();
        self.previous_owner.take();
    }
}

/// The language-service sessions of one instance. Each session borrows on its own, so a
/// host callback of one session's build can query another session's programs, as classic
/// compiler hosts query the old program.
#[derive(Default)]
struct Sessions {
    next_id: u32,
    services: HashMap<u32, Rc<RefCell<Service>>>,
}

thread_local! {
    static SESSIONS: RefCell<Sessions> = RefCell::default();
}

/// Handles one request: JSON, optionally followed by NUL and a WTF-8 payload.
///
/// Source and document actions belong to the instance and never borrow the
/// sessions, so a document registry can parse while a session's build is
/// waiting on its compiler host.
pub fn receive(input: &[u8]) -> String {
    let (json, payload) = match input.iter().position(|&byte| byte == 0) {
        Some(at) => (&input[..at], &input[at + 1..]),
        None => (input, &[][..]),
    };
    let result = serde_json::from_slice::<Value>(json)
        .map_err(|error| ServiceError::Parse(error.to_string()))
        .and_then(|request| instance_command(&request, payload));
    match result {
        Ok(result) => format!("{{\"result\":{result}}}"),
        Err(error) => error.response(),
    }
}

fn lease_id(request: &Value, field: &str, message: &'static str) -> Result<u32, ServiceError> {
    let id = request[field].as_u64().ok_or(message)?;
    u32::try_from(id).map_err(|error| error.to_string().into())
}

fn instance_command(request: &Value, payload: &[u8]) -> Result<String, ServiceError> {
    match request["action"].as_str() {
        Some("parseDocument") => crate::classic_sources::parse_document(request, payload)
            .map(|value| value.to_string())
            .map_err(ServiceError::InvalidParams),
        Some("source") => {
            let id = lease_id(request, "source", "source file lease is required")?;
            crate::classic_sources::with_sources(|sources| sources.response(id))
                .map(|value| value.to_string())
                .map_err(ServiceError::InvalidParams)
        }
        Some("sourceIdentifiers") => {
            let id = lease_id(request, "source", "source file lease is required")?;
            crate::classic_sources::with_sources(|sources| sources.identifiers(id))
                .map(|value| value.to_string())
                .map_err(ServiceError::InvalidParams)
        }
        Some("releaseSource") => {
            let id = lease_id(request, "source", "source file lease is required")?;
            crate::classic_sources::with_sources(|sources| sources.release(id));
            crate::classic_metadata::with_pools(crate::classic_metadata::ParsePools::prune);
            Ok("null".into())
        }
        Some("open") => SESSIONS.with(|sessions| {
            let service = Service::new(request)?;
            let mut sessions = sessions.borrow_mut();
            sessions.next_id = sessions
                .next_id
                .checked_add(1)
                .ok_or("language service sessions exhausted")?;
            let id = sessions.next_id;
            sessions.services.insert(id, Rc::new(RefCell::new(service)));
            Ok(id.to_string())
        }),
        Some(_) => {
            let id = lease_id(request, "session", "language service session is required")?;
            if request["action"] == "close" {
                let closed = SESSIONS.with(|sessions| sessions.borrow_mut().services.remove(&id));
                drop(closed);
                return Ok("null".into());
            }
            let service = SESSIONS
                .with(|sessions| sessions.borrow().services.get(&id).cloned())
                .ok_or("language service is disposed")?;
            let mut service = service
                .try_borrow_mut()
                .map_err(|_| "language service cannot reenter a host callback")?;
            let case_sensitive = host::case_sensitive();
            host::set_case_sensitive(service.case_sensitive);
            let result = command(&mut service, request);
            host::set_case_sensitive(case_sensitive);
            result
        }
        None => Err("unknown language service action".into()),
    }
}

fn command(service: &mut Service, request: &Value) -> Result<String, ServiceError> {
    match request["action"].as_str() {
        Some("retire") => {
            service.invalidate();
            service.retired = true;
            service.release_unused();
            Ok("null".into())
        }
        Some("invalidate") => {
            service.invalidate();
            Ok("null".into())
        }
        Some("configureProgram") => {
            let root_names: Vec<String> = serde_json::from_value(request["rootNames"].clone())
                .map_err(|error| error.to_string())?;
            if !request["options"].is_object() {
                return Err("program options must be an object".into());
            }
            service.invalidate();
            service.program_config = Some(ProgramConfig {
                root_names: root_names.into_iter().map(go_string_from_utf8).collect(),
                options: request["options"].clone(),
                default_library_path: request["defaultLibraryPath"]
                    .as_str()
                    .map(|path| go_string_from_utf8(path.to_owned())),
            });
            Ok("null".into())
        }
        Some("configure") => {
            let args: Vec<String> = serde_json::from_value(request["args"].clone())
                .map_err(|error| error.to_string())?;
            service.invalidate();
            service.args = args;
            service.program_config = None;
            Ok("null".into())
        }
        Some("request") => {
            let method = request["method"]
                .as_str()
                .ok_or("method must be a string")?;
            service.request(method, &request["params"])
        }
        Some("missingFiles") => service.missing_files(&request["paths"]),
        Some(action) => graph_command(service, action, request),
        None => Err("unknown language service action".into()),
    }
}

/// Actions on retained programs and source files exported to the classic facade.
fn graph_command(
    service: &mut Service,
    action: &str,
    request: &Value,
) -> Result<String, ServiceError> {
    match Some(action) {
        Some("getProgram") => {
            service.language()?;
            let owner = service
                .program_owner
                .as_ref()
                .ok_or("program is unavailable")?;
            owner.checker.get_or_init(|| {
                crate::classic_checker::ClassicChecker::new(&owner.program, &service.context)
            });
            Ok(service.graphs.retain(owner).to_string())
        }
        Some("graph") => service
            .graphs
            .request(&service.context, request)
            .map(|value| value.to_string())
            .map_err(ServiceError::InvalidParams),
        Some("releaseProgram") => {
            let id = lease_id(request, "program", "program handle is required")?;
            service.graphs.release(id);
            crate::classic_metadata::with_pools(crate::classic_metadata::ParsePools::prune);
            Ok("null".into())
        }
        _ => Err("unknown language service action".into()),
    }
}

fn build_language(
    cwd: &str,
    args: &[String],
    program_config: Option<&ProgramConfig>,
    case_sensitive: bool,
    documents: bool,
) -> Result<
    (
        ls::LanguageService,
        HashMap<String, crate::classic_metadata::SourceMetadata>,
    ),
    ServiceError,
> {
    let _ = host::take_read_failure();
    let sys = new_os_system().map_err(|status| {
        ServiceError::Internal(format!("cannot initialize host: {}", status.code()))
    })?;
    let config = match program_config {
        Some(config) => program_command_line(cwd, case_sensitive, config)?,
        None => read_config(args, &SessionConfigHost { fs: sys.fs(), cwd })?,
    };
    let host =
        compiler::new_compiler_host(cwd, sys.fs(), &sys.default_library_path(), None, None, None);
    let host = Rc::new(crate::editor_host::EditorHost::new(
        host,
        config.compiler_options().target.0,
        documents,
        program_config.and_then(|config| config.default_library_path.clone()),
    ));
    let program = ls_program::new_program(
        ProgramOptions {
            host: host.clone(),
            config: Rc::new(config),
            use_source_of_project_reference: false,
            single_threaded: Tristate::True,
            typings_location: String::new(),
            project_name: cwd.into(),
            create_module_resolver: None,
            skip_module_resolution: false,
        },
        None,
    );
    if host::take_read_failure() {
        ls_program::release_program(&program);
        return Err(ServiceError::Internal(
            "a host callback failed during the build".into(),
        ));
    }
    if let Some(error) = host.take_metadata_error() {
        ls_program::release_program(&program);
        return Err(ServiceError::InvalidParams(error));
    }
    let metadata = host.metadata();
    let fs = program.host().fs();
    let line_maps = RefCell::new(HashMap::<String, Rc<lsconv::LSPLineMap>>::new());
    let texts = Rc::downgrade(&program);
    let converters = lsconv::new_converters(lsproto::PositionEncodingKind::UTF16, move |name| {
        if let Some(lines) = line_maps.borrow().get(name).cloned() {
            return Some(lines);
        }
        let text = match texts
            .upgrade()
            .and_then(|program| program.get_source_file(name))
        {
            Some(file) => file.text().to_owned(),
            None => host::read_source_snapshot(name)?,
        };
        let lines = lsconv::compute_lsp_line_starts(&text);
        line_maps.borrow_mut().insert(name.into(), lines.clone());
        Some(lines)
    });
    let host = Rc::new(LanguageHost { fs, converters });
    Ok((
        ls::new_language_service(ls::autoimport::ProjectID(cwd.into()), program, host, ""),
        metadata,
    ))
}

/// A tsconfig-form JSON value as the option converter reads it.
fn options_value(value: &Value) -> CompilerOptionsValue {
    match value {
        Value::Null => CompilerOptionsValue::Nil,
        Value::Bool(value) => CompilerOptionsValue::Bool(*value),
        Value::Number(value) => CompilerOptionsValue::Number(value.as_f64().unwrap_or_default()),
        Value::String(value) => CompilerOptionsValue::String(go_string_from_utf8(value.clone())),
        Value::Array(values) => {
            CompilerOptionsValue::List(values.iter().map(options_value).collect())
        }
        Value::Object(values) => CompilerOptionsValue::Map(
            values
                .iter()
                .map(|(key, value)| (key.clone(), options_value(value)))
                .collect(),
        ),
    }
}

/// The command line of a classic program: its roots, and its options as tsconfig
/// `compilerOptions` resolved against the current directory.
#[allow(clippy::unnecessary_wraps)]
fn program_command_line(
    cwd: &str,
    case_sensitive: bool,
    config: &ProgramConfig,
) -> Result<ParsedCommandLine, ServiceError> {
    let mut options = ts_goport::options::CompilerOptions::default();
    // Classic's internal `allowNonTsExtensions` has no declaration, so the converter does not
    // know it; the program reads it as Go's option of the same name.
    let mut json = config.options.clone();
    let allow_non_ts_extensions = json
        .as_object_mut()
        .and_then(|options| options.remove("allowNonTsExtensions"));
    let (_, errors) = convert_options_from_json(
        &COMMAND_LINE_COMPILER_OPTIONS_MAP,
        &options_value(&json),
        cwd,
        CompilerOptionsParser {
            compiler_options: &mut options,
        },
    );
    match allow_non_ts_extensions {
        Some(Value::Bool(true)) => options.allow_non_ts_extensions = Tristate::True,
        Some(Value::Bool(false)) => options.allow_non_ts_extensions = Tristate::False,
        _ => {}
    }
    // An option this compiler does not know is a configuration diagnostic of the program,
    // as classic programs report removed options, so the program still builds.
    let mut command_line = new_parsed_command_line(
        Rc::new(options),
        config.root_names.clone(),
        None,
        tspath::ComparePathsOptions {
            use_case_sensitive_file_names: case_sensitive,
            current_directory: cwd.into(),
        },
    );
    command_line.errors = errors;
    Ok(command_line)
}

/// The configuration host of a session: the instance's file system with the
/// session's current directory.
struct SessionConfigHost<'a> {
    fs: Rc<dyn Fs>,
    cwd: &'a str,
}

impl tsoptions::ParseConfigHost for SessionConfigHost<'_> {
    fn fs(&self) -> Rc<dyn Fs> {
        self.fs.clone()
    }

    fn get_current_directory(&self) -> String {
        self.cwd.into()
    }
}

fn read_config(
    args: &[String],
    host: &SessionConfigHost<'_>,
) -> Result<ParsedCommandLine, ServiceError> {
    let parsed = tsoptions::parse_command_line(args, host);
    check_config(&parsed.get_config_file_parsing_diagnostics())?;
    let options = parsed.compiler_options();
    if options.project.is_empty() {
        return Ok(parsed);
    }
    let mut path = tspath::get_normalized_absolute_path(&options.project, host.cwd);
    if host.fs.directory_exists(&path) {
        path = tspath::combine_paths(&path, &["tsconfig.json"]);
    }
    let (config, errors) =
        tsoptions::get_parsed_command_line_of_config_file(&path, Some(options), None, host, None);
    check_config(&errors)?;
    let config = config.ok_or_else(|| {
        ServiceError::Internal(format!("project configuration was not returned: {path}"))
    })?;
    check_config(&config.get_config_file_parsing_diagnostics())?;
    Ok(config)
}

struct LanguageHost {
    fs: Rc<dyn Fs>,
    converters: Rc<lsconv::Converters>,
}

impl ls::Host for LanguageHost {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.fs.use_case_sensitive_file_names()
    }
    fn read_file(&self, path: &str) -> (FileText, bool) {
        let (text, found) = self.fs.read_file(path);
        (FileText::Shared(Arc::from(text)), found)
    }
    fn converters(&self) -> Rc<lsconv::Converters> {
        self.converters.clone()
    }
    fn get_preferences(&self, _: &str) -> lsutil::UserPreferences {
        let mut preferences = lsutil::new_default_user_preferences();
        preferences.include_completions_for_module_exports = Tristate::False;
        preferences
    }
    fn get_ecma_line_info(&self, _: &str) -> Option<Rc<sourcemap::lineinfo::ECMALineInfo>> {
        None
    }
    fn auto_import_registry(&self) -> Option<Rc<ls::autoimport::Registry>> {
        None
    }
    fn read_directory(
        &self,
        cwd: &str,
        path: &str,
        extensions: &[String],
        excludes: &[String],
        includes: &[String],
        depth: i32,
    ) -> Vec<String> {
        ts_goport::frontend::vfs::read_directory(
            &*self.fs, cwd, path, extensions, excludes, includes, depth,
        )
    }
    fn get_directories(&self, path: &str) -> Vec<String> {
        self.fs.get_accessible_entries(path).directories
    }
    fn directory_exists(&self, path: &str) -> bool {
        self.fs.directory_exists(path)
    }
    fn file_exists(&self, path: &str) -> bool {
        self.fs.file_exists(path)
    }
}

fn normalize_document(
    language: &ls::LanguageService,
    params: &mut Value,
) -> Result<(), ServiceError> {
    let uri = params
        .pointer("/textDocument/uri")
        .and_then(Value::as_str)
        .ok_or("textDocument.uri must be a file URI")?;
    let parsed = ts_goport::gostd::url::parse(uri).map_err(|error| error.error())?;
    if parsed.scheme != "file" || !parsed.path.starts_with('/') {
        return Err("textDocument.uri must be a file URI".into());
    }
    let uri = lsproto::DocumentUri(uri.into());
    let (_, file) = language.try_get_program_and_file(&uri.file_name());
    if file.is_nil() {
        return Err("document is not part of the program".into());
    }
    let text = language
        .program
        .get_source_file(&uri.file_name())
        .ok_or("document is not part of the program")?
        .text()
        .to_owned();
    let lines = lsconv::compute_lsp_line_starts(&text);
    if let Some(position) = params.get_mut("position") {
        normalize_position(&text, &lines, position)?;
    }
    if let Some(range) = params.get_mut("range") {
        normalize_range(&text, &lines, range)?;
    }
    let Some(diagnostics) = params
        .pointer_mut("/context/diagnostics")
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    for diagnostic in diagnostics {
        if !diagnostic.is_object() {
            return Err("diagnostics must contain diagnostic objects".into());
        }
        let range = diagnostic
            .get_mut("range")
            .ok_or("diagnostic range is required")?;
        normalize_range(&text, &lines, range)?;
    }
    Ok(())
}

fn normalize_range(
    text: &str,
    lines: &lsconv::LSPLineMap,
    range: &mut Value,
) -> Result<(), ServiceError> {
    normalize_position(
        text,
        lines,
        range.get_mut("start").ok_or("range start is required")?,
    )?;
    normalize_position(
        text,
        lines,
        range.get_mut("end").ok_or("range end is required")?,
    )?;
    let start = (
        range["start"]["line"].as_u64(),
        range["start"]["character"].as_u64(),
    );
    let end = (
        range["end"]["line"].as_u64(),
        range["end"]["character"].as_u64(),
    );
    if start > end {
        return Err("range end must be at or after its start".into());
    }
    Ok(())
}

fn normalize_position(
    text: &str,
    lines: &lsconv::LSPLineMap,
    position: &mut Value,
) -> Result<(), ServiceError> {
    let line = position["line"]
        .as_u64()
        .ok_or("line must be a nonnegative integer")?;
    let character = position["character"]
        .as_u64()
        .ok_or("character must be a nonnegative integer")?;
    let index = usize::try_from(line).map_err(|error| error.to_string())?;
    let start = *lines
        .line_starts
        .get(index)
        .ok_or("line is outside the document")?;
    let start =
        usize::try_from(start).map_err(|error| ServiceError::Internal(error.to_string()))?;
    let end = lines
        .line_starts
        .get(index + 1)
        .copied()
        .map(usize::try_from)
        .transpose()
        .map_err(|error| ServiceError::Internal(error.to_string()))?
        .unwrap_or(text.len());
    let maximum = text[start..end]
        .trim_end_matches(['\r', '\n'])
        .encode_utf16()
        .count();
    let maximum =
        u64::try_from(maximum).map_err(|error| ServiceError::Internal(error.to_string()))?;
    position["character"] = Value::from(character.min(maximum));
    Ok(())
}

fn decode<T: UnmarshalerFrom + Default>(params: &Value) -> Result<T, ServiceError> {
    let mut result = T::default();
    json_unmarshal(params.to_string().as_bytes(), &mut result, &[])
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn encode<T: MarshalerTo>(result: Result<T, GoError>) -> Result<String, ServiceError> {
    let result = result.map_err(|error| ServiceError::Internal(error.error()))?;
    json_marshal(&result, &[]).map_err(|error| ServiceError::Internal(error.to_string()))
}

fn dispatch(
    language: &ls::LanguageService,
    ctx: &Context,
    method: Method,
    params: &Value,
) -> Result<String, ServiceError> {
    macro_rules! call {
        ($params:ty, $function:ident) => {
            encode(language.$function(ctx, &decode::<$params>(params)?))
        };
    }
    match method {
        Method::Hover => call!(lsproto::HoverParams, provide_hover),
        Method::Completion => {
            let p: lsproto::CompletionParams = decode(params)?;
            encode(language.provide_completion(
                ctx,
                &p.text_document.uri,
                p.position,
                p.context.as_ref(),
            ))
        }
        Method::Definition => {
            let p: lsproto::DefinitionParams = decode(params)?;
            encode(language.provide_definition(ctx, &p.text_document.uri, p.position))
        }
        Method::TypeDefinition => {
            let p: lsproto::TypeDefinitionParams = decode(params)?;
            encode(language.provide_type_definition(ctx, &p.text_document.uri, p.position))
        }
        Method::References => encode(language.provide_references(ctx, &decode(params)?, None)),
        Method::Rename => encode(language.provide_rename(ctx, &decode(params)?, None)),
        Method::Implementation => {
            encode(language.provide_implementations(ctx, &decode(params)?, None))
        }
        Method::DocumentHighlight => {
            let p: lsproto::DocumentHighlightParams = decode(params)?;
            encode(language.provide_document_highlights(ctx, &p.text_document.uri, p.position))
        }
        Method::Diagnostic => {
            let p: lsproto::DocumentDiagnosticParams = decode(params)?;
            encode(language.provide_diagnostics(ctx, &p.text_document.uri))
        }
        Method::SignatureHelp => {
            let p: lsproto::SignatureHelpParams = decode(params)?;
            encode(language.provide_signature_help(
                ctx,
                &p.text_document.uri,
                p.position,
                p.context.as_ref(),
            ))
        }
        Method::DocumentSymbol => {
            let p: lsproto::DocumentSymbolParams = decode(params)?;
            encode(language.provide_document_symbols(ctx, &p.text_document.uri))
        }
        Method::CodeAction => call!(lsproto::CodeActionParams, provide_code_actions),
        Method::Formatting => {
            let p: lsproto::DocumentFormattingParams = decode(params)?;
            let options = p
                .options
                .as_ref()
                .ok_or("formatting options are required")?;
            encode(language.provide_format_document(ctx, &p.text_document.uri, options))
        }
        Method::RangeFormatting => {
            let p: lsproto::DocumentRangeFormattingParams = decode(params)?;
            let options = p
                .options
                .as_ref()
                .ok_or("formatting options are required")?;
            encode(language.provide_format_document_range(
                ctx,
                &p.text_document.uri,
                options,
                p.range,
            ))
        }
        Method::SemanticTokensFull => {
            let p: lsproto::SemanticTokensParams = decode(params)?;
            encode(language.provide_semantic_tokens(ctx, &p.text_document.uri))
        }
        Method::SemanticTokensRange => {
            let p: lsproto::SemanticTokensRangeParams = decode(params)?;
            encode(language.provide_semantic_tokens_range(ctx, &p.text_document.uri, p.range))
        }
    }
}
