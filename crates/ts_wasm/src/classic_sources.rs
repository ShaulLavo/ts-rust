use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Value, json};
use ts_goport::api::encoder;
use ts_goport::core::Node;
use ts_goport::frontend::parser::ParsedSourceFile;

/// Source objects retain just their parsed file version, independently of programs.
#[derive(Default)]
pub struct Sources {
    next_id: u32,
    files: HashMap<u32, Source>,
    identities: HashMap<(usize, u32), u32>,
}

struct Source {
    file: Rc<ParsedSourceFile>,
    language_version: u32,
    version: Vec<u16>,
}

impl Sources {
    pub fn retain(&mut self, file: &Rc<ParsedSourceFile>, language_version: u32, version: &[u16]) -> u32 {
        let key = (file.root.file_index(), language_version);
        if let Some(&id) = self.identities.get(&key) { return id; }
        self.next_id = self.next_id.checked_add(1).expect("source file lease exhausted");
        self.files.insert(self.next_id, Source { file: file.clone(), language_version, version: version.to_vec() });
        self.identities.insert(key, self.next_id);
        self.next_id
    }

    pub fn release(&mut self, id: u32) {
        if let Some(source) = self.files.remove(&id) {
            self.identities.remove(&(source.file.root.file_index(), source.language_version));
        }
        ts_goport::ast::release_file_version_pins_later();
    }

    pub fn response(&self, id: u32) -> Result<Value, String> {
        let source = self.files.get(&id).ok_or("source file lease has been released")?;
        let file = &source.file;
        let (bytes, _) = encoder::encode_parsed_source_file(file).map_err(|error| error.to_string())?;
        Ok(json!({"source": id, "fileId": file.root.file_index(), "languageVersion": source.language_version, "version": {"$string": source.version}, "fileName": file.file_name(), "data": bytes}))
    }

    pub fn resolve(&self, location: &Value) -> Result<Node, String> {
        if location.is_null() {
            return Ok(Node::NIL);
        }
        let source = location["source"].as_u64().ok_or("source file lease is required")?;
        let source = u32::try_from(source).map_err(|error| error.to_string())?;
        let file = &self.files.get(&source).ok_or("node source file lease has been released")?.file;
        let name = location["fileName"].as_str().ok_or("node fileName is required")?;
        if name != file.file_name() {
            return Err("node fileName does not match the source file lease".into());
        }
        let index = location["index"].as_u64().ok_or("node index is required")?;
        let index = usize::try_from(index).map_err(|error| error.to_string())?;
        let table = encoder::get_node_index_table(file.root);
        let node = table.nodes.get(index).copied().ok_or("node index is outside the source file")?;
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
        let mut matches = self.files.iter().filter(|(_, source)| source.file.root.file_index() == file_id);
        let (&id, _) = matches.next()?;
        matches.next().is_none().then_some(id)
    }
}
