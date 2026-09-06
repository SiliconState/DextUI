//! Money as integer cents (never floats), RFC-4180 CSV, ISO-ish dates, and
//! confined paths under the session cwd (no symlinks, no traversal).
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Amount in minor units (cents). Parses "$1,234.56", "1234.56", "-12", "(12.50)".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Money(pub i64);

impl Money {
    pub fn parse(s: &str) -> Option<Money> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        let neg_paren = t.starts_with('(') && t.ends_with(')');
        let mut cleaned: String = t
            .trim_matches(|c| c == '(' || c == ')')
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            .collect();
        if cleaned.is_empty() || cleaned == "-" || cleaned == "." {
            return None;
        }
        let neg = cleaned.starts_with('-') || neg_paren;
        cleaned = cleaned.trim_start_matches('-').to_string();
        if cleaned.contains('-') {
            return None;
        }
        let (whole, frac) = match cleaned.split_once('.') {
            Some((w, f)) => (w, f),
            None => (cleaned.as_str(), ""),
        };
        if frac.len() > 2 && frac[2..].chars().any(|c| c != '0') {
            // more than cents precision: round half up on the third digit
        }
        let whole_v: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
        let mut f = frac.to_string();
        while f.len() < 3 {
            f.push('0');
        }
        let cents_raw: i64 = f[..2].parse().ok()?;
        let round_up = f.as_bytes()[2] >= b'5';
        let mut cents = whole_v.checked_mul(100)?.checked_add(cents_raw)?;
        if round_up {
            cents += 1;
        }
        Some(Money(if neg { -cents } else { cents }))
    }
    pub fn from_f64(v: f64) -> Money {
        Money((v * 100.0).round() as i64)
    }
    pub fn fmt(&self, symbol: &str) -> String {
        let neg = self.0 < 0;
        let abs = self.0.unsigned_abs();
        let whole = abs / 100;
        let cents = abs % 100;
        let mut digits = whole.to_string();
        let mut out = String::new();
        while digits.len() > 3 {
            let tail = digits.split_off(digits.len() - 3);
            out = format!(",{tail}{out}");
        }
        format!("{}{symbol}{digits}{out}.{cents:02}", if neg { "-" } else { "" })
    }
    /// Plain "1234.56" for CSV / JSON.
    pub fn plain(&self) -> String {
        let neg = self.0 < 0;
        let abs = self.0.unsigned_abs();
        format!("{}{}.{:02}", if neg { "-" } else { "" }, abs / 100, abs % 100)
    }
    pub fn as_f64(&self) -> f64 {
        self.0 as f64 / 100.0
    }
}

// ---------- CSV ----------

pub fn csv_escape(field: &str) -> String {
    if field.contains(',') || field.contains('"') || field.contains('\n') || field.contains('\r') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

pub fn csv_row(fields: &[&str]) -> String {
    fields.iter().map(|f| csv_escape(f)).collect::<Vec<_>>().join(",")
}

/// RFC-4180 parse (quotes, doubled quotes, CRLF). Blank lines skipped.
pub fn csv_parse(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cell.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                cell.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == ',' {
            row.push(std::mem::take(&mut cell));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut cell));
            if row.iter().any(|x| !x.trim().is_empty()) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else {
            cell.push(c);
        }
        i += 1;
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        if row.iter().any(|x| !x.trim().is_empty()) {
            rows.push(row);
        }
    }
    rows
}

// ---------- dates ----------

/// Normalise common forms to `YYYY-MM-DD`: ISO, `DD/MM/YYYY` or `MM/DD/YYYY`
/// (ambiguous → month-first unless day > 12), `5 Sep 2026`, `Sep 5, 2026`.
pub fn parse_date(s: &str) -> Option<String> {
    let t = s.trim();
    let iso: Vec<&str> = t.split(|c| c == '-' || c == '/' || c == '.').collect();
    if iso.len() == 3 && iso[0].len() == 4 {
        let (y, m, d) = (iso[0].parse::<u32>().ok()?, iso[1].parse::<u32>().ok()?, iso[2].parse::<u32>().ok()?);
        return valid(y, m, d);
    }
    if iso.len() == 3 && iso[2].len() == 4 {
        let (a, b, y) = (iso[0].parse::<u32>().ok()?, iso[1].parse::<u32>().ok()?, iso[2].parse::<u32>().ok()?);
        let (m, d) = if a > 12 { (b, a) } else { (a, b) };
        return valid(y, m, d);
    }
    let words: Vec<&str> = t.split(|c: char| c == ' ' || c == ',').filter(|w| !w.is_empty()).collect();
    if words.len() == 3 {
        let month = |w: &str| -> Option<u32> {
            let m = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
            let l = w.to_ascii_lowercase();
            m.iter().position(|x| l.starts_with(x)).map(|p| p as u32 + 1)
        };
        if let (Some(m), Ok(d), Ok(y)) = (month(words[0]), words[1].parse::<u32>(), words[2].parse::<u32>()) {
            return valid(y, m, d);
        }
        if let (Ok(d), Some(m), Ok(y)) = (words[0].parse::<u32>(), month(words[1]), words[2].parse::<u32>()) {
            return valid(y, m, d);
        }
    }
    None
}

fn valid(y: u32, m: u32, d: u32) -> Option<String> {
    if !(1970..=2200).contains(&y) || !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

pub fn days_in_month(y: u32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 },
        _ => 0,
    }
}

/// Days since 1970-01-01 for a `YYYY-MM-DD` string (civil-from-days inverse).
pub fn day_number(iso: &str) -> Option<i64> {
    let p: Vec<i64> = iso.split('-').filter_map(|x| x.parse().ok()).collect();
    if p.len() != 3 {
        return None;
    }
    let (y, m, d) = (p[0], p[1], p[2]);
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

pub fn from_day_number(z: i64) -> String {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn add_days(iso: &str, days: i64) -> Option<String> {
    day_number(iso).map(|n| from_day_number(n + days))
}

/// Today as `YYYY-MM-DD` (UTC) from the system clock.
pub fn today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    from_day_number(secs.div_euclid(86_400))
}

pub fn month_of(iso: &str) -> &str {
    if iso.len() >= 7 { &iso[..7] } else { iso }
}

// ---------- paths ----------

/// Resolve `rel` under `root`: no absolute paths, no `..`, no symlink on any
/// existing component. Returns the absolute path (may not exist yet).
pub fn confined(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err(format!("path must be relative to the folder: {rel}"));
    }
    let mut at = root.to_path_buf();
    for comp in p.components() {
        at.push(comp);
        if let Ok(md) = fs::symlink_metadata(&at) {
            if md.file_type().is_symlink() {
                return Err(format!("symlink refused: {}", at.display()));
            }
        }
    }
    Ok(at)
}

/// Create a real directory (not through a symlink) if missing.
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(md) if md.is_dir() && !md.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!("{} exists and is not a real directory", path.display())),
        Err(_) => fs::create_dir_all(path).map_err(|e| format!("create {}: {e}", path.display())),
    }
}

/// Atomic text write (temp + rename) that never follows a symlink target.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Ok(md) = fs::symlink_metadata(path) {
        if md.file_type().is_symlink() {
            return Err(format!("symlink refused: {}", path.display()));
        }
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

pub fn read_text(path: &Path, cap: usize) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(_) => Ok(None),
        Ok(md) if md.file_type().is_symlink() => Err(format!("symlink refused: {}", path.display())),
        Ok(md) if !md.is_file() => Err(format!("not a file: {}", path.display())),
        Ok(md) if md.len() as usize > cap => Err(format!("{} exceeds {cap} bytes", path.display())),
        Ok(_) => fs::read_to_string(path).map(Some).map_err(|e| format!("read {}: {e}", path.display())),
    }
}

// ---------- view fences ----------

/// A ```chart fence DextUI renders interactively (bar/hbar/line/donut).
pub fn chart_fence(kind: &str, title: &str, labels: &[String], values: &[f64], unit: &str) -> String {
    let spec = serde_json::json!({ "type": kind, "title": title, "labels": labels, "values": values, "unit": unit });
    format!("```chart\n{}\n```", spec)
}

/// A ```csv fence (rendered as a sortable table by DextUI's csv extension).
pub fn csv_fence(header: &[&str], rows: &[Vec<String>]) -> String {
    let mut out = String::from("```csv\n");
    out.push_str(&csv_row(header));
    out.push('\n');
    for r in rows {
        let refs: Vec<&str> = r.iter().map(|s| s.as_str()).collect();
        out.push_str(&csv_row(&refs));
        out.push('\n');
    }
    out.push_str("```");
    out
}

/// Escape a string for inclusion in a markdown table cell / HTML text node.
pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ---------- live panels (TS dashboard baked with per-run data) ----------

/// JSON safe for an inline `<script>` context: `<`, `>`, `&`, U+2028/2029
/// escaped as \uXXXX so a payload can never close the script tag or break out.
pub fn json_for_script(data: &serde_json::Value) -> String {
    serde_json::to_string(data)
        .unwrap_or_else(|_| "null".into())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Where the pack lives: dext exports `DEXT_PACK_<NAME>_DIR` for runtimes;
/// fall back to the executable's parent (bin/ → pack root).
pub fn pack_dir(env_key: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var(env_key) {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    exe.parent()?.parent().map(|p| p.to_path_buf())
}

/// Copy the pack's built panel (`ui/panel.html`, from build-panel.mjs) into
/// the session state dir with `@@PACK_DATA@@` replaced by `data`. Returns
/// None (not an error) when the pack ships no panel.
pub fn write_panel(pack: &Path, state_dir: &Path, data: &serde_json::Value) -> Result<Option<PathBuf>, String> {
    let template = pack.join("ui").join("panel.html");
    let text = match read_text(&template, 1024 * 1024)? {
        Some(t) => t,
        None => return Ok(None),
    };
    if !text.contains("@@PACK_DATA@@") {
        return Err("ui/panel.html has no @@PACK_DATA@@ marker — rebuild the panel".into());
    }
    let html = text.replacen("@@PACK_DATA@@", &json_for_script(data), 1);
    let out = state_dir.join("panel.html");
    write_atomic(&out, &html)?;
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_parse_and_format() {
        assert_eq!(Money::parse("$1,234.56"), Some(Money(123456)));
        assert_eq!(Money::parse("1234.5"), Some(Money(123450)));
        assert_eq!(Money::parse("-12"), Some(Money(-1200)));
        assert_eq!(Money::parse("(12.50)"), Some(Money(-1250)));
        assert_eq!(Money::parse("0.005"), Some(Money(1)));
        assert_eq!(Money::parse("abc"), None);
        assert_eq!(Money(123456).fmt("$"), "$1,234.56");
        assert_eq!(Money(-5).fmt("€"), "-€0.05");
        assert_eq!(Money(100000).plain(), "1000.00");
    }

    #[test]
    fn csv_roundtrip() {
        let row = csv_row(&["a,b", "he said \"hi\"", "plain"]);
        assert_eq!(row, "\"a,b\",\"he said \"\"hi\"\"\",plain");
        let parsed = csv_parse(&format!("{row}\r\nx,y,z\n\n"));
        assert_eq!(parsed, vec![vec!["a,b", "he said \"hi\"", "plain"], vec!["x", "y", "z"]]);
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("2026-09-05"), Some("2026-09-05".into()));
        assert_eq!(parse_date("05/09/2026"), Some("2026-05-09".into()));
        assert_eq!(parse_date("25/09/2026"), Some("2026-09-25".into()));
        assert_eq!(parse_date("Sep 5, 2026"), Some("2026-09-05".into()));
        assert_eq!(parse_date("5 September 2026"), Some("2026-09-05".into()));
        assert_eq!(parse_date("2026-02-30"), None);
        assert_eq!(add_days("2026-01-31", 1), Some("2026-02-01".into()));
        assert_eq!(add_days("2024-02-28", 1), Some("2024-02-29".into()));
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(from_day_number(day_number("2026-09-05").unwrap()), "2026-09-05");
    }

    #[test]
    fn confinement() {
        let root = std::env::temp_dir();
        assert!(confined(&root, "../x").is_err());
        assert!(confined(&root, "/etc").is_err());
        assert!(confined(&root, "a/b.csv").unwrap().ends_with("a/b.csv"));
    }
}
