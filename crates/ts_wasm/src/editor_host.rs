use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ts_goport::contentmapper::{Mapper, Project, SourceFiles};
use ts_goport::diagnostics::Message;
use ts_goport::flags::ScriptKind;
use ts_goport::frontend::compiler::CompilerHost;
use ts_goport::frontend::parser::{ParsedSourceFile, SourceFileParseOptions};
use ts_goport::frontend::tsoptions::ParsedCommandLine;
use ts_goport::frontend::tspath::Path;
use ts_goport::frontend::vfs::Fs;
use ts_goport::gostd::GoError;
use ts_goport::project::{self, HashedSourceFile, ParseCache, ParseCacheKey};

/// The native parse cache owns each file version before the program publishes it.
pub struct EditorHost {
    inner: Rc<dyn CompilerHost>,
    cache: Rc<ParseCache>,
    acquired: RefCell<HashMap<ParseCacheKey, HashedSourceFile>>,
}

impl EditorHost {
    pub fn new(inner: Rc<dyn CompilerHost>, cache: Rc<ParseCache>) -> Self {
        Self {
            inner,
            cache,
            acquired: RefCell::default(),
        }
    }

    pub fn parse_json(&self, file_name: &str, path: &Path, text: String) -> Rc<ParsedSourceFile> {
        self.acquire_parse(
            &SourceFileParseOptions {
                file_name: file_name.into(),
                path: path.clone(),
                ..Default::default()
            },
            text,
            ScriptKind::JSON,
        )
    }

    fn acquire_parse(
        &self,
        options: &SourceFileParseOptions,
        text: String,
        kind: ScriptKind,
    ) -> Rc<ParsedSourceFile> {
        let file = project::new_cached_file_handle(&options.file_name, text);
        let key = project::new_parse_cache_key(options, file.hash(), kind);
        if let Some(parsed) = self.acquired.borrow().get(&key) {
            return parsed.file.clone();
        }
        let parsed = self.cache.acquire(key.clone(), file);
        let source = parsed.file.clone();
        self.acquired.borrow_mut().insert(key, parsed);
        source
    }
}

impl CompilerHost for EditorHost {
    fn fs(&self) -> Rc<dyn Fs> {
        self.inner.fs()
    }
    fn default_library_path(&self) -> String {
        self.inner.default_library_path()
    }
    fn get_current_directory(&self) -> String {
        self.inner.get_current_directory()
    }
    fn trace(&self, message: &'static Message, args: Vec<String>) {
        self.inner.trace(message, args);
    }

    fn get_source_file(&self, options: &SourceFileParseOptions) -> Option<Rc<ParsedSourceFile>> {
        let (text, found) = self.inner.fs().read_file(&options.file_name);
        if !found {
            return None;
        }
        Some(self.acquire_parse(options, text, ScriptKind::UNKNOWN))
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
        crate::editor_config::EditorConfig::new(self)
            .read_path(file_name, path, None, &EditorParseConfigHost(self))
            .0
            .map(Rc::new)
    }

    fn prefetch_parses(&self) -> bool {
        false
    }
    fn prefetch_content_mapped(&self) -> bool {
        false
    }

    fn release(&self) {
        for (key, _) in self.acquired.borrow_mut().drain() {
            self.cache.deref(&key);
        }
        self.inner.release();
    }
}

impl Drop for EditorHost {
    fn drop(&mut self) {
        self.release();
    }
}

struct EditorParseConfigHost<'a>(&'a EditorHost);

impl ts_goport::frontend::tsoptions::ParseConfigHost for EditorParseConfigHost<'_> {
    fn fs(&self) -> Rc<dyn Fs> {
        self.0.fs()
    }
    fn get_current_directory(&self) -> String {
        self.0.get_current_directory()
    }
}
