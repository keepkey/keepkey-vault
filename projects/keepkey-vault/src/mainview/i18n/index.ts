import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import resourcesToBackend from "i18next-resources-to-backend"

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

const STORAGE_KEY = "keepkey-vault-lang"

const savedLang = localStorage.getItem(STORAGE_KEY) || "en"

i18n
	.use(initReactI18next)
	.use(
		resourcesToBackend((language: string, namespace: string) => {
			// English is bundled synchronously above – skip dynamic import
			if (language === "en") return undefined
			return import(`./locales/${language}/${namespace}.json`)
		}),
	)
	.init({
		lng: savedLang,
		fallbackLng: "en",
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
			},
		},
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	})

// Persist language changes
i18n.on("languageChanged", (lng) => {
	localStorage.setItem(STORAGE_KEY, lng)
})

export default i18n
