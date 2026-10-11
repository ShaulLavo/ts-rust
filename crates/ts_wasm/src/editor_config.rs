use std::rc::Rc;

use ts_goport::core::Diagnostic;
use ts_goport::frontend::compiler::CompilerHost;
use ts_goport::frontend::tsoptions::{
    self, ExtendedConfigCache, ExtendedConfigCacheEntry, ParseConfigHost, ParsedCommandLine,
    TsConfigSourceFile,
};
use ts_goport::frontend::tspath::{self, Path};
use ts_goport::options::CompilerOptions;

use crate::editor_host::EditorHost;

pub struct EditorConfig<'a> {
    host: &'a EditorHost,
}

impl<'a> EditorConfig<'a> {
    pub fn new(host: &'a EditorHost) -> Self {
        Self { host }
    }

    pub fn read(
        &self,
        file_name: &str,
        options: Option<&CompilerOptions>,
        host: &dyn ParseConfigHost,
    ) -> (Option<ParsedCommandLine>, Vec<Diagnostic>) {
        let path = tspath::to_path(
            file_name,
            &host.get_current_directory(),
            host.fs().use_case_sensitive_file_names(),
        );
        self.read_path(file_name, &path, options, host)
    }

    pub fn read_path(
        &self,
        file_name: &str,
        path: &Path,
        options: Option<&CompilerOptions>,
        host: &dyn ParseConfigHost,
    ) -> (Option<ParsedCommandLine>, Vec<Diagnostic>) {
        let (source, errors, found) = self.read_source(file_name, path);
        if !found {
            return (None, errors);
        }
        let needs_syntax_diagnostics =
            ts_goport::frontend::parser::parsed_source_file_diagnostics(source.source_file)
                .is_empty();
        let mut config = tsoptions::parse_json_source_file_config_file_content(
            source,
            host,
            &tspath::get_directory_path(file_name),
            options,
            None,
            file_name,
            &[],
            Some(self),
        );
        if needs_syntax_diagnostics {
            config.errors.extend(errors);
        }
        (Some(config), Vec::new())
    }

    fn read_source(
        &self,
        file_name: &str,
        path: &Path,
    ) -> (TsConfigSourceFile, Vec<Diagnostic>, bool) {
        let (text, mut errors) = tsoptions::try_read_file(
            file_name,
            &mut |name| self.host.fs().read_file(name),
            Vec::new(),
        );
        let found = errors.is_empty();
        let parsed = self.host.parse_json(file_name, path, text);
        ts_goport::program::publish_parsed_files(&self.host.get_current_directory());
        errors.extend(parsed.diagnostics.iter().cloned());
        (
            TsConfigSourceFile {
                source_file: parsed.root,
                path: parsed.path().clone(),
                file_name: parsed.file_name().into(),
                ..Default::default()
            },
            errors,
            found,
        )
    }
}

impl ExtendedConfigCache for EditorConfig<'_> {
    fn get_extended_config_for_cycle(
        &self,
        file_name: &str,
        path: &Path,
        resolution_stack: &[Path],
        host: &dyn ParseConfigHost,
    ) -> Rc<ExtendedConfigCacheEntry> {
        self.get_extended_config(file_name, path, resolution_stack, host)
    }

    fn get_extended_config(
        &self,
        file_name: &str,
        path: &Path,
        resolution_stack: &[Path],
        host: &dyn ParseConfigHost,
    ) -> Rc<ExtendedConfigCacheEntry> {
        let (mut source, mut errors, _) = self.read_source(file_name, path);
        if !errors.is_empty() {
            return Rc::new(ExtendedConfigCacheEntry {
                extended_result: Some(Rc::new(source)),
                errors,
                ..Default::default()
            });
        }
        let (config, parse_errors) = tsoptions::parse_config(
            None,
            Some(&mut source),
            host,
            &tspath::get_directory_path(file_name),
            &tspath::get_base_file_name(file_name),
            resolution_stack,
            Some(self),
        );
        errors.extend(parse_errors);
        Rc::new(ExtendedConfigCacheEntry {
            extended_result: Some(Rc::new(source)),
            extended_config: Some(Rc::new(config)),
            errors,
        })
    }
}
