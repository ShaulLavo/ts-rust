use serde_json::{Value, json};
use ts_goport::frontend::json::{MarshalerTo, json_marshal};
use ts_goport::frontend::json_ext::LspAny;
use ts_goport::scanner_util::{GoUnit, contains_go_string_marker, go_unit_at};

pub fn json_value(value: &impl MarshalerTo) -> Result<Value, String> {
    let json = json_marshal(value, &[]).map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| error.to_string())
}

pub fn from_any(value: LspAny) -> Value {
    match value {
        LspAny::Null => Value::Null,
        LspAny::Bool(value) => Value::Bool(value),
        LspAny::Number(value) => json!(value),
        LspAny::String(value) => string_value(&value),
        LspAny::Array(values) => Value::Array(values.into_iter().map(from_any).collect()),
        LspAny::Object(values) => Value::Object(values.into_iter().map(|(key, value)| (key, from_any(value))).collect()),
    }
}

pub fn string_value(value: &str) -> Value {
    if !contains_go_string_marker(value) {
        return json!(value);
    }
    let mut units = Vec::<u16>::new();
    let mut offset = 0;
    while offset < value.len() {
        let (unit, size) = go_unit_at(value, offset);
        offset += size;
        match unit {
            GoUnit::Char(character) => units.extend_from_slice(character.encode_utf16(&mut [0; 2])),
            GoUnit::Surrogate(point) => units.push(u16::try_from(point).expect("GoUnit surrogate must fit in a UTF-16 code unit")),
            GoUnit::InvalidByte(_) => units.push(0xfffd),
        }
    }
    json!({"$string": units})
}
