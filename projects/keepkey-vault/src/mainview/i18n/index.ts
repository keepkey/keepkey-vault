import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import resourcesToBackend from "i18next-resources-to-backend"
import { detectLanguage, LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES, supportedLanguage } from './languages'

// English locale files – bundled synchronously so they are always available
import common from "./locales/en/common.json"
import nav from "./locales/en/nav.json"
import dashboard from "./locales/en/dashboard.json"
import send from "./locales/en/send.json"
import receive from "./locales/en/receive.json"
import asset from "./locales/en/asset.json"
import settings from "./locales/en/settings.json"
import device from "./locales/en/device.json"
import setup from "./locales/en/setup.json"
import update from "./locales/en/update.json"
import appstore from "./locales/en/appstore.json"
import dialogs from "./locales/en/dialogs.json"
import swap from "./locales/en/swap.json"
import staking from "./locales/en/staking.json"
import names from "./locales/en/names.json"
import addressbook from "./locales/en/addressbook.json"
import ui from './locales/en/ui.json'

function detectInitialLang(): string {
	let saved: string | null = null
	try { saved = localStorage.getItem(LANGUAGE_STORAGE_KEY) } catch { /* blocked storage must not disable browser detection */ }
	return detectLanguage(saved, typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language]))
}

const savedLang = detectInitialLang()
const localeModules = import.meta.glob(['./locales/*/*.json', '!./locales/en/*.json'])

function updateLanguageMetadata(lng: string) {
	const language = supportedLanguage(lng) || 'en'
	if (typeof document !== 'undefined') {
		document.documentElement.lang = language
		document.documentElement.dir = i18n.dir(language)
	}
	try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language) } catch { /* blocked storage */ }
}

// Register before init: its initial languageChanged event can be synchronous.
i18n.on('languageChanged', updateLanguageMetadata)

i18n
	.use(initReactI18next)
	.use(
		resourcesToBackend((language: string, namespace: string) => {
			// English is bundled synchronously above – skip dynamic import
			if (language === "en") return undefined
			const load = localeModules[`./locales/${language}/${namespace}.json`]
			if (!load) return {}
			return load()
		}),
	)
	.init({
		lng: savedLang,
		fallbackLng: "en",
		supportedLngs: SUPPORTED_LANGUAGES,
		load: 'languageOnly',
		partialBundledLanguages: true,
		defaultNS: "common",
		ns: [
			"common",
			"nav",
			"dashboard",
			"send",
			"receive",
			"asset",
			"settings",
			"device",
			"setup",
			"update",
			"appstore",
			"dialogs",
			"swap",
			"staking",
			"names",
			"addressbook",
			"ui",
		],
		resources: {
			en: {
				common,
				nav,
				dashboard,
				send,
				receive,
				asset,
				settings,
				device,
				setup,
				update,
				appstore,
				dialogs,
				swap,
				staking,
				names,
				addressbook,
				ui,
			},
		},
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	})

export default i18n
