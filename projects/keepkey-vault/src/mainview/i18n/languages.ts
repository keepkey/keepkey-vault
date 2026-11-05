export const LANGUAGE_STORAGE_KEY = 'keepkey-vault-lang'
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '简体中文' },
  { code: 'ko', label: '한국어' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'it', label: 'Italiano' },
  { code: 'pl', label: 'Polski' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'th', label: 'ไทย' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'vi', label: 'Tiếng Việt' },
] as const
export type AppLanguage = typeof LANGUAGES[number]['code']
export const SUPPORTED_LANGUAGES = LANGUAGES.map(l => l.code)

export function supportedLanguage(value: unknown): AppLanguage | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const [canonical] = Intl.getCanonicalLocales(value)
    const language = canonical?.split('-')[0]
    // The shipped Chinese catalog is Simplified; do not label it Traditional.
    if (language === 'zh' && (/-Hant(?:-|$)/i.test(canonical) || (!/-Hans(?:-|$)/i.test(canonical) && /-(?:TW|HK|MO)(?:-|$)/i.test(canonical)))) return undefined
    return SUPPORTED_LANGUAGES.find(code => code === language)
  } catch { return undefined }
}

export function detectLanguage(saved: unknown, browserLanguages: readonly string[]): AppLanguage {
  return supportedLanguage(saved) || browserLanguages.map(supportedLanguage).find(Boolean) || 'en'
}
