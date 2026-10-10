use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ts_goport::project::{self, ParseCache};

/// The version of a file a program loaded. Bundled libraries have none.
#[derive(Clone, Default)]
pub struct SourceMetadata {
    pub version: Vec<u16>,
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

thread_local! {
    /// Parse pools of the bundled libraries, shared by every session of the instance.
    static POOLS: RefCell<ParsePools> = RefCell::default();
}

pub fn with_pools<R>(action: impl FnOnce(&mut ParsePools) -> R) -> R {
    POOLS.with(|pools| action(&mut pools.borrow_mut()))
}
