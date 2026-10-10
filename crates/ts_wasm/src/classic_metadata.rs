use std::collections::HashMap;
use std::rc::Rc;

use ts_goport::flags::ScriptKind;
use ts_goport::project::{self, ParseCache};

#[derive(Clone, Copy, Default, serde::Deserialize)]
pub enum SourceKind {
    #[default]
    Unknown,
    #[serde(rename = "JS")]
    JavaScript,
    #[serde(rename = "JSX")]
    JavaScriptJsx,
    #[serde(rename = "TS")]
    TypeScript,
    #[serde(rename = "TSX")]
    TypeScriptJsx,
    External,
    #[serde(rename = "JSON")]
    Json,
    Deferred,
}

impl SourceKind {
    pub fn native(self) -> ScriptKind {
        match self {
            Self::Unknown => ScriptKind::UNKNOWN,
            Self::JavaScript => ScriptKind::JS,
            Self::JavaScriptJsx => ScriptKind::JSX,
            Self::TypeScript => ScriptKind::TS,
            Self::TypeScriptJsx => ScriptKind::TSX,
            Self::External => ScriptKind(5),
            Self::Json => ScriptKind::JSON,
            Self::Deferred => ScriptKind(7),
        }
    }
}

#[derive(Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub snapshot: u32,
    pub version: Vec<u16>,
    pub script_kind: SourceKind,
}

impl SourceMetadata {
    pub fn read(path: &str) -> Result<Self, String> {
        if ts_goport::frontend::bundled::bundled_text(path).is_some() {
            return Ok(Self::default());
        }
        let bytes = ts_goport::scanner_util::go_string_bytes(path);
        match crate::host::call(crate::host::Op::SourceMetadata, &bytes) {
            Ok(data) => serde_json::from_slice(&data).map_err(|error| error.to_string()),
            Err(error) if error.is_empty() => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }
}

#[derive(Default)]
pub struct ParsePools {
    caches: HashMap<(i32, u32), Rc<ParseCache>>,
}

impl ParsePools {
    pub fn get(&mut self, target: i32, snapshot: u32) -> Rc<ParseCache> {
        self.caches
            .entry((target, snapshot))
            .or_insert_with(|| {
                project::new_parse_cache(project::RefCountCacheOptions {
                    disable_deletion: false,
                })
            })
            .clone()
    }

    pub fn prune(&mut self) {
        self.caches.retain(|_, cache| Rc::strong_count(cache) > 1);
    }
}
