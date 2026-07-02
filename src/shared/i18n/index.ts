import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Lang, LangStrings, EN, ES } from './translations';

// ── Config file location ──────────────────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.n1nja', 'config.json');

interface N1njaConfig {
  language?: Lang;
}

// ── Module-level language state ───────────────────────────────────────────────
let _lang: Lang = 'en';

/**
 * Loads the report language. Precedence:
 *   1. N1NJA_LANG env var ('en' | 'es') — handy for `npx` usage with no install step.
 *   2. ~/.n1nja/config.json (written by the installer).
 *   3. English default.
 * Call once at server startup.
 */
export function loadLanguageConfig(): void {
  const envLang = process.env.N1NJA_LANG?.toLowerCase();
  if (envLang === 'es' || envLang === 'en') {
    _lang = envLang;
    return;
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const config: N1njaConfig = JSON.parse(raw);
      if (config.language === 'es' || config.language === 'en') {
        _lang = config.language;
      }
    }
  } catch {
    // Silently fall back to English
  }
}

/**
 * Override language programmatically (useful for testing).
 */
export function setLanguage(lang: Lang): void {
  _lang = lang;
}

export function getLanguage(): Lang {
  return _lang;
}

/**
 * Returns the current translation strings.
 */
export function t(): LangStrings {
  return _lang === 'es' ? ES : EN;
}
