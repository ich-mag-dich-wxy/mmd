use std::cell::OnceCell;
use std::collections::HashMap;

/// Common MMD facial expression (morph) names with English-Japanese mappings.
/// These cover the standard morph names found in most MMD models.
pub const MORPHS: &[&str] = &[
    // Vowels / mouth shapes
    "a",
    "i",
    "u",
    "e",
    "o",
    // Emotions
    "smile",
    "laugh",
    "angry",
    "troubled",
    "sad",
    "grin",
    "serious",
    "surprised",
    "heart",
    // Eyes
    "blink",
    "wink",
    "wink_r",
    "wink_l",
    "half_close",
    "squint",
    "surprised_eye",
    "smile_eye",
    // Eyebrows
    "brow_normal",
    "brow_angry",
    "brow_troubled",
    "brow_sad",
    // Other
    "mouth_open",
    "tears",
    "blush",
    "tooth",
    "tongue",
];

/// Database of facial expression morphs with bilingual (English/Japanese) name mappings.
pub struct MorphDatabase {
    translations: HashMap<String, String>, // English -> Japanese
    all_morphs: Vec<String>,
}

impl MorphDatabase {
    fn new() -> Self {
        let translations = Self::build_translations();
        let all_morphs: Vec<String> = translations.keys().cloned().collect();
        Self {
            translations,
            all_morphs,
        }
    }

    fn build_translations() -> HashMap<String, String> {
        let mut map = HashMap::new();
        // Vowels / mouth shapes
        map.insert("a".to_string(), "あ".to_string());
        map.insert("i".to_string(), "い".to_string());
        map.insert("u".to_string(), "う".to_string());
        map.insert("e".to_string(), "え".to_string());
        map.insert("o".to_string(), "お".to_string());
        // Emotions
        map.insert("smile".to_string(), "笑い".to_string());
        map.insert("laugh".to_string(), "笑い".to_string());
        map.insert("angry".to_string(), "怒り".to_string());
        map.insert("troubled".to_string(), "困る".to_string());
        map.insert("sad".to_string(), "悲しい".to_string());
        map.insert("grin".to_string(), "にやり".to_string());
        map.insert("serious".to_string(), "真面目".to_string());
        map.insert("surprised".to_string(), "びっくり".to_string());
        map.insert("heart".to_string(), "はぁと".to_string());
        // Eyes
        map.insert("blink".to_string(), "瞬き".to_string());
        map.insert("wink".to_string(), "ウインク".to_string());
        map.insert("wink_r".to_string(), "ウインク右".to_string());
        map.insert("wink_l".to_string(), "ウインク左".to_string());
        map.insert("half_close".to_string(), "半目".to_string());
        map.insert("squint".to_string(), "じと目".to_string());
        map.insert("surprised_eye".to_string(), "びっくり目".to_string());
        map.insert("smile_eye".to_string(), "笑い目".to_string());
        // Eyebrows
        map.insert("brow_normal".to_string(), "眉通常".to_string());
        map.insert("brow_angry".to_string(), "眉怒り".to_string());
        map.insert("brow_troubled".to_string(), "眉困る".to_string());
        map.insert("brow_sad".to_string(), "眉哀".to_string());
        // Other
        map.insert("mouth_open".to_string(), "口開け".to_string());
        map.insert("tears".to_string(), "涙".to_string());
        map.insert("blush".to_string(), "照れ".to_string());
        map.insert("tooth".to_string(), "歯".to_string());
        map.insert("tongue".to_string(), "舌".to_string());
        map
    }

    /// Get all known morph names (English).
    pub fn morphs(&self) -> &[String] {
        &self.all_morphs
    }

    /// Get the Japanese name for an English morph name.
    pub fn japanese_name(&self, name: &str) -> Option<&str> {
        self.translations.get(name).map(|s| s.as_str())
    }

    /// Get the English name for a Japanese morph name.
    pub fn english_name(&self, name: &str) -> Option<&str> {
        self.translations
            .iter()
            .find(|(_, v)| *v == name)
            .map(|(k, _)| k.as_str())
    }

    /// Check if a morph name (English or Japanese) is known.
    pub fn is_known_morph(&self, name: &str) -> bool {
        self.translations.contains_key(name)
            || self.translations.values().any(|v| v == name)
    }

    /// Convert a morph name (English or Japanese) to its Japanese form.
    /// If the name is unknown, return it as-is (many models have custom morphs).
    pub fn to_japanese(&self, name: &str) -> String {
        // If it's already Japanese, return as-is
        if self.english_name(name).is_some() {
            return name.to_string();
        }
        // If it's English, translate to Japanese
        if let Some(jp) = self.japanese_name(name) {
            return jp.to_string();
        }
        // Unknown morph - return as-is (allows custom morphs)
        name.to_string()
    }

    /// Convert a morph name (English or Japanese) to its English form.
    /// If the name is unknown, return it as-is.
    pub fn to_english(&self, name: &str) -> String {
        // If it's Japanese, translate to English
        if let Some(en) = self.english_name(name) {
            return en.to_string();
        }
        // If it's already English, return as-is
        if self.translations.contains_key(name) {
            return name.to_string();
        }
        // Unknown morph - return as-is
        name.to_string()
    }
}

thread_local! {
    static MORPH_DB: OnceCell<MorphDatabase> = OnceCell::new();
}

pub fn with_morph_db<T>(f: impl FnOnce(&MorphDatabase) -> T) -> T {
    MORPH_DB.with(|db| f(db.get_or_init(|| MorphDatabase::new())))
}
