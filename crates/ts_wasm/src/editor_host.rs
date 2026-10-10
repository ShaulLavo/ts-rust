use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ts_goport::contentmapper::{Mapper, Project, SourceFiles};
use ts_goport::diagnostics::Message;
use ts_goport::frontend::compiler::CompilerHost;
use ts_goport::frontend::parser::{ParsedSourceFile, SourceFileParseOptions};
use ts_goport::frontend::tsoptions::ParsedCommandLine;
use ts_goport::frontend::tspath::Path;
use ts_goport::frontend::vfs::Fs;
use ts_goport::gostd::GoError;
use ts_goport::project::{self, ParseCache, ParseCacheKey};
use ts_goport::scanner_util::go_string_bytes;

use crate::classic_metadata::SourceMetadata;
use crate::host::{self, Op};

struct ParsedLease {
    cache: Rc<ParseCache>,
    key: ParseCacheKey,
}

/// Program builds load bundled libraries from the instance's parse pools. A
/// session with documents loads every other file from its compiler host's
/// documents (`createLanguageServiceSourceFile`); one without reads files.
pub struct EditorHost {
    inner: Rc<dyn CompilerHost>,
    target: i32,
    documents: bool,
    default_library_path: Option<String>,
    acquired: RefCell<HashMap<String, ParsedLease>>,
    metadata: RefCell<HashMap<String, SourceMetadata>>,
    metadata_error: RefCell<Option<String>>,
}

impl EditorHost {
    pub fn new(
        inner: Rc<dyn CompilerHost>,
        target: i32,
        documents: bool,
        default_library_path: Option<String>,
    ) -> Self {
        Self {
            inner,
            target,
            documents,
            default_library_path,
            acquired: RefCell::new(HashMap::new()),
            metadata: RefCell::new(HashMap::new()),
            metadata_error: RefCell::new(None),
        }
    }

    pub fn metadata(&self) -> HashMap<String, SourceMetadata> {
        self.metadata.borrow().clone()
    }

    pub fn take_metadata_error(&self) -> Option<String> {
        self.metadata_error.borrow_mut().take()
    }

    fn pooled(&self, options: &SourceFileParseOptions, text: &str) -> Rc<ParsedSourceFile> {
        let file = project::new_cached_file_handle(&options.file_name, text.to_owned());
        let key = project::new_parse_cache_key(
            options,
            file.hash(),
            ts_goport::flags::ScriptKind::UNKNOWN,
        );
        let cache = crate::classic_metadata::with_pools(|pools| pools.get(self.target, 0));
        let source = cache.acquire(key.clone(), file).file;
        self.metadata
            .borrow_mut()
            .insert(options.file_name.clone(), SourceMetadata::default());
        self.remember(&options.file_name, ParsedLease { cache, key });
        source
    }

    /// Asks the host's compiler host for the file. The host acquires it from
    /// its document registry, which parses it in this instance, and answers
    /// with the document's lease.
    fn document(&self, options: &SourceFileParseOptions) -> Option<Rc<ParsedSourceFile>> {
        let request = serde_json::json!({
            "fileName": options.file_name,
            "path": options.path.0,
            "jsx": options.external_module_indicator_options.jsx,
            "force": options.external_module_indicator_options.force,
        });
        let reply = host::call(Op::GetSourceFile, &go_string_bytes(&request.to_string())).ok()?;
        let id = std::str::from_utf8(&reply).ok()?.parse::<u32>();
        let Ok(id) = id else {
            self.metadata_error.replace(Some(
                "compiler host returned a source file this compiler does not own".into(),
            ));
            return None;
        };
        let Some(lease) = crate::classic_sources::with_sources(|sources| sources.document(id))
        else {
            self.metadata_error
                .replace(Some("compiler host returned a released source file".into()));
            return None;
        };
        let document = lease.document;
        let source = document
            .cache
            .acquire(document.key.clone(), document.handle.clone())
            .file;
        self.metadata.borrow_mut().insert(
            options.file_name.clone(),
            SourceMetadata {
                version: lease.version,
            },
        );
        self.remember(
            &options.file_name,
            ParsedLease {
                cache: document.cache,
                key: document.key,
            },
        );
        Some(source)
    }

    fn remember(&self, file_name: &str, lease: ParsedLease) {
        if let Some(previous) = self
            .acquired
            .borrow_mut()
            .insert(file_name.to_owned(), lease)
        {
            previous.cache.deref(&previous.key);
        }
    }
}

impl CompilerHost for EditorHost {
    fn fs(&self) -> Rc<dyn Fs> {
        self.inner.fs()
    }

    fn default_library_path(&self) -> String {
        self.default_library_path
            .clone()
            .unwrap_or_else(|| self.inner.default_library_path())
    }

    fn get_current_directory(&self) -> String {
        self.inner.get_current_directory()
    }

    fn trace(&self, message: &'static Message, args: Vec<String>) {
        self.inner.trace(message, args);
    }

    fn get_source_file(&self, options: &SourceFileParseOptions) -> Option<Rc<ParsedSourceFile>> {
        if let Some(text) = ts_goport::frontend::bundled::bundled_text(&options.file_name) {
            return Some(self.pooled(options, text));
        }
        if self.documents {
            return self.document(options);
        }
        let text = host::read_source_snapshot(&options.file_name)?;
        Some(self.pooled(options, &text))
    }

    fn get_content_mapped_source_files(
        &self,
        options: &SourceFileParseOptions,
        mapper: &Rc<Mapper>,
    ) -> Result<SourceFiles, GoError> {
        self.inner.get_content_mapped_source_files(options, mapper)
    }

    fn content_mapper_project(&self) -> Option<Rc<dyn Project>> {
        self.inner.content_mapper_project()
    }

    fn get_resolved_project_reference(
        &self,
        file_name: &str,
        path: &Path,
    ) -> Option<Rc<ParsedCommandLine>> {
        self.inner.get_resolved_project_reference(file_name, path)
    }

    fn prefetch_parses(&self) -> bool {
        false
    }

    fn prefetch_content_mapped(&self) -> bool {
        false
    }

    fn release(&self) {
        for (_, lease) in self.acquired.borrow_mut().drain() {
            lease.cache.deref(&lease.key);
        }
        self.inner.release();
    }
}

impl Drop for EditorHost {
    fn drop(&mut self) {
        self.release();
    }
}
