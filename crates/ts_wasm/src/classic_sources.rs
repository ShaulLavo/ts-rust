use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Value, json};
use ts_goport::api::encoder;
use ts_goport::core::Node;
use ts_goport::flags::ScriptKind;
use ts_goport::frontend::parser::{
    ExternalModuleIndicatorOptions, ParsedSourceFile, SourceFileParseOptions,
};
use ts_goport::frontend::tspath::Path;
use ts_goport::project::{self, FileHandle, ParseCache, ParseCacheKey, RefCountCacheOptions};
use ts_goport::scanner_util::{go_string_from_bytes, go_string_from_utf8};

thread_local! {
    /// The source leases of one instance. Every session of the instance and
    /// every document registry in it share them, so a parse keeps one lease
    /// and one JavaScript source file wherever it appears.
    static SOURCES: RefCell<Sources> = RefCell::default();
}

/// Runs `action` on the instance's source leases. The borrow lasts only for
/// the call, so no host callback may run inside `action`.
pub fn with_sources<R>(action: impl FnOnce(&mut Sources) -> R) -> R {
    SOURCES.with(|sources| action(&mut sources.borrow_mut()))
}

/// Source objects retain just their parsed file version, independently of programs.
#[derive(Default)]
pub struct Sources {
    next_id: u32,
    files: HashMap<u32, Source>,
    identities: HashMap<(usize, u32), u32>,
    /// Documents by file id. A document is one `createLanguageServiceSourceFile`
    /// parse, so it keeps its lease for every parse target.
    documents: HashMap<usize, u32>,
}

struct Source {
    file: Rc<ParsedSourceFile>,
    language_version: u32,
    version: Vec<u16>,
    document: Option<Document>,
}

/// The parse cache entry a document owns. Programs that use the document
/// acquire the same entry, so the parse lives while any of them holds it.
#[derive(Clone)]
pub struct Document {
    pub cache: Rc<ParseCache>,
    pub key: ParseCacheKey,
    pub handle: Rc<dyn FileHandle>,
}

/// A document as a program build acquires it.
pub struct DocumentLease {
    pub document: Document,
    pub version: Vec<u16>,
}

impl Sources {
    fn next(&mut self) -> u32 {
        self.next_id = self
            .next_id
            .checked_add(1)
            .expect("source file lease exhausted");
        self.next_id
    }

    pub fn retain(
        &mut self,
        file: &Rc<ParsedSourceFile>,
        language_version: u32,
        version: &[u16],
    ) -> u32 {
        if let Some(&id) = self.documents.get(&file.root.file_index()) {
            return id;
        }
        let key = (file.root.file_index(), language_version);
        if let Some(&id) = self.identities.get(&key) {
            return id;
        }
        let id = self.next();
        self.files.insert(
            id,
            Source {
                file: file.clone(),
                language_version,
                version: version.to_vec(),
                document: None,
            },
        );
        self.identities.insert(key, id);
        id
    }

    fn insert_document(
        &mut self,
        file: Rc<ParsedSourceFile>,
        language_version: u32,
        version: Vec<u16>,
        document: Document,
    ) -> u32 {
        let id = self.next();
        self.documents.insert(file.root.file_index(), id);
        self.files.insert(
            id,
            Source {
                file,
                language_version,
                version,
                document: Some(document),
            },
        );
        id
    }

    /// The document of lease `id`, for a program build that acquires it.
    pub fn document(&self, id: u32) -> Option<DocumentLease> {
        let source = self.files.get(&id)?;
        Some(DocumentLease {
            document: source.document.clone()?,
            version: source.version.clone(),
        })
    }

    pub fn release(&mut self, id: u32) {
        if let Some(source) = self.files.remove(&id) {
            let file_id = source.file.root.file_index();
            if let Some(document) = source.document {
                self.documents.remove(&file_id);
                document.cache.deref(&document.key);
            } else {
                self.identities.remove(&(file_id, source.language_version));
            }
        }
        ts_goport::ast::release_file_version_pins_later();
    }

    pub fn response(&self, id: u32) -> Result<Value, String> {
        let source = self
            .files
            .get(&id)
            .ok_or("source file lease has been released")?;
        let file = &source.file;
        let (bytes, _) =
            encoder::encode_parsed_source_file(file).map_err(|error| error.to_string())?;
        Ok(
            json!({"source": id, "fileId": file.root.file_index(), "languageVersion": source.language_version, "version": {"$string": source.version}, "fileName": file.file_name(), "data": bytes}),
        )
    }

    pub fn resolve(&self, location: &Value) -> Result<Node, String> {
        if location.is_null() {
            return Ok(Node::NIL);
        }
        let source = location["source"]
            .as_u64()
            .ok_or("source file lease is required")?;
        let source = u32::try_from(source).map_err(|error| error.to_string())?;
        let file = &self
            .files
            .get(&source)
            .ok_or("node source file lease has been released")?
            .file;
        let name = location["fileName"]
            .as_str()
            .ok_or("node fileName is required")?;
        if name != file.file_name() {
            return Err("node fileName does not match the source file lease".into());
        }
        let index = location["index"].as_u64().ok_or("node index is required")?;
        let index = usize::try_from(index).map_err(|error| error.to_string())?;
        let table = encoder::get_node_index_table(file.root);
        let node = table
            .nodes
            .get(index)
            .copied()
            .ok_or("node index is outside the source file")?;
        if node.is_nil() || Some(node.kind() as u64) != location["nativeKind"].as_u64() {
            return Err("node handle does not match the source file".into());
        }
        Ok(node)
    }

    pub fn origin(&self, id: u32) -> Option<(usize, u32)> {
        let source = self.files.get(&id)?;
        Some((source.file.root.file_index(), source.language_version))
    }

    pub fn find(&self, file_id: usize) -> Option<u32> {
        if let Some(&id) = self.documents.get(&file_id) {
            return Some(id);
        }
        let mut matches = self
            .files
            .iter()
            .filter(|(_, source)| source.file.root.file_index() == file_id);
        let (&id, _) = matches.next()?;
        matches.next().is_none().then_some(id)
    }
}

/// `createLanguageServiceSourceFile`: one new parse of `text`, with a lease of
/// its own. Its parse cache is the document's alone, so two documents with
/// the same text stay two source files, as two classic parses do.
pub fn parse_document(request: &Value, text: &[u8]) -> Result<Value, String> {
    crate::language_service::ensure_runtime();
    let file_name = request["fileName"]
        .as_str()
        .ok_or("document fileName is required")?;
    let path = request["path"]
        .as_str()
        .ok_or("document path is required")?;
    let script_kind = request["scriptKind"]
        .as_i64()
        .and_then(|kind| i32::try_from(kind).ok())
        .filter(|kind| (0..=7).contains(kind))
        .ok_or("document scriptKind must be a classic ScriptKind")?;
    let language_version = request["languageVersion"]
        .as_u64()
        .and_then(|version| u32::try_from(version).ok())
        .ok_or("document languageVersion is required")?;
    let version: Vec<u16> =
        serde_json::from_value(request["version"].clone()).map_err(|error| error.to_string())?;
    let options = SourceFileParseOptions {
        file_name: go_string_from_utf8(file_name.to_string()),
        path: Path(go_string_from_utf8(path.to_string())),
        external_module_indicator_options: ExternalModuleIndicatorOptions {
            jsx: request["jsx"].as_bool().unwrap_or(false),
            force: request["force"].as_bool().unwrap_or(false),
        },
    };
    let text = go_string_from_bytes(text.to_vec());
    let handle = project::new_cached_file_handle(&options.file_name, text);
    let key = project::new_parse_cache_key(&options, handle.hash(), ScriptKind(script_kind));
    let cache = project::new_parse_cache(RefCountCacheOptions {
        disable_deletion: false,
    });
    let parsed = cache.acquire(key.clone(), handle.clone());
    let document = Document { cache, key, handle };
    with_sources(|sources| {
        let id = sources.insert_document(parsed.file, language_version, version, document);
        sources.response(id)
    })
}
