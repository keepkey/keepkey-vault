import { supportedLanguage } from '../mainview/i18n/languages'
import { messageKey } from '../shared/message-key'
import en from '../mainview/i18n/locales/en/ui.json'
import es from '../mainview/i18n/locales/es/ui.json'
import fr from '../mainview/i18n/locales/fr/ui.json'
import de from '../mainview/i18n/locales/de/ui.json'
import ja from '../mainview/i18n/locales/ja/ui.json'
import zh from '../mainview/i18n/locales/zh/ui.json'
import ko from '../mainview/i18n/locales/ko/ui.json'
import pt from '../mainview/i18n/locales/pt/ui.json'
import ru from '../mainview/i18n/locales/ru/ui.json'
import it from '../mainview/i18n/locales/it/ui.json'
import pl from '../mainview/i18n/locales/pl/ui.json'
import nl from '../mainview/i18n/locales/nl/ui.json'
import th from '../mainview/i18n/locales/th/ui.json'
import tr from '../mainview/i18n/locales/tr/ui.json'
import vi from '../mainview/i18n/locales/vi/ui.json'

const resources: Record<string,Record<string,string>> = {en, es, fr, de, ja, zh, ko, pt, ru, it, pl, nl, th, tr, vi}
export function backendText(language: string | null | undefined, source: string, values: Record<string,string|number> = {}): string {
  const translated = resources[supportedLanguage(language) || 'en']?.[messageKey(source)] || source
  return translated.replace(/{{\s*(\w+)\s*}}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]))
}
