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
use ts_goport::project::{self, HashedSourceFile, ParseCache, ParseCacheKey};

use crate::classic_metadata::{ParsePools, SourceMetadata};

struct ParsedLease {
    cache: Rc<ParseCache>,
    parsed: HashedSourceFile,
}

/// Parse-cache leases assign file versions before the program publishes its AST.
pub struct EditorHost {
    inner: Rc<dyn CompilerHost>,
    pools: Rc<RefCell<ParsePools>>,
    target: i32,
    acquired: RefCell<HashMap<ParseCacheKey, ParsedLease>>,
    metadata: RefCell<HashMap<String, SourceMetadata>>,
    metadata_error: RefCell<Option<String>>,
}

impl EditorHost {
    pub fn new(inner: Rc<dyn CompilerHost>, pools: Rc<RefCell<ParsePools>>, target: i32) -> Self {
        Self {
            inner,
            pools,
            target,
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

    fn read_metadata(&self, path: &str) -> Option<SourceMetadata> {
        match SourceMetadata::read(path) {
            Ok(metadata) => Some(metadata),
            Err(error) => {
                self.metadata_error.replace(Some(error));
                None
            }
        }
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
        let text = crate::host::read_source_snapshot(&options.file_name)?;
        let metadata = self.read_metadata(&options.file_name)?;
        let file = project::new_cached_file_handle(&options.file_name, text);
        let key = project::new_parse_cache_key(options, file.hash(), metadata.script_kind.native());
        if let Some(parsed) = self.acquired.borrow().get(&key) {
            return Some(parsed.parsed.file.clone());
        }
        let cache = self.pools.borrow_mut().get(self.target, metadata.snapshot);
        let parsed = cache.acquire(key.clone(), file);
        let source = parsed.file.clone();
        self.metadata
            .borrow_mut()
            .insert(options.file_name.clone(), metadata);
        self.acquired
            .borrow_mut()
            .insert(key, ParsedLease { cache, parsed });
        Some(source)
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
        for (key, lease) in self.acquired.borrow_mut().drain() {
            lease.cache.deref(&key);
        }
        self.inner.release();
    }
}

impl Drop for EditorHost {
    fn drop(&mut self) {
        self.release();
    }
}
