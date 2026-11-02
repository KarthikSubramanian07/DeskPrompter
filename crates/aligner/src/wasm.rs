//! JavaScript bindings. Shapes match `apps/web/src/core/contracts.ts`.

use wasm_bindgen::prelude::*;

use crate::tracker::Tracker;

fn to_js<T: serde::Serialize>(v: &T) -> JsValue {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap_or(JsValue::NULL)
}

/// Parse a script into display blocks and tokens, as `ParsedScript` JSON.
/// (The TypeScript wrapper `JSON.parse`s it: much faster than building every
/// token object across the wasm boundary.)
#[wasm_bindgen(js_name = parseScriptJson)]
pub fn parse_script_json(text: &str) -> String {
    crate::parse::parse_script(text).to_json()
}

/// Voice-follow aligner for one script.
#[wasm_bindgen]
pub struct Aligner {
    inner: Tracker,
}

#[wasm_bindgen]
impl Aligner {
    #[wasm_bindgen(constructor)]
    pub fn new(script: &str) -> Aligner {
        Aligner {
            inner: Tracker::new(script),
        }
    }

    #[wasm_bindgen(getter, js_name = wordCount)]
    pub fn word_count(&self) -> u32 {
        self.inner.word_count()
    }

    /// Feed the recognizer's hypothesis for the current utterance. Returns `AlignResult`.
    pub fn feed(&mut self, text: &str, is_final: bool) -> JsValue {
        to_js(&self.inner.feed(text, is_final))
    }

    #[wasm_bindgen(js_name = setCursor)]
    pub fn set_cursor(&mut self, wi: i32) {
        self.inner.set_cursor(wi);
    }

    /// Diagnostic: why the last feed decided what it did.
    #[wasm_bindgen(getter)]
    pub fn reason(&self) -> String {
        self.inner.reason.to_string()
    }
}
