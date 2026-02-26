import type common from "./locales/en/common.json"
import type nav from "./locales/en/nav.json"
import type dashboard from "./locales/en/dashboard.json"
import type send from "./locales/en/send.json"
import type receive from "./locales/en/receive.json"
import type asset from "./locales/en/asset.json"
import type settings from "./locales/en/settings.json"
import type device from "./locales/en/device.json"
import type setup from "./locales/en/setup.json"
import type update from "./locales/en/update.json"
import type appstore from "./locales/en/appstore.json"
import type dialogs from "./locales/en/dialogs.json"

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "common"
		resources: {
			common: typeof common
			nav: typeof nav
			dashboard: typeof dashboard
			send: typeof send
			receive: typeof receive
			asset: typeof asset
			settings: typeof settings
			device: typeof device
			setup: typeof setup
			update: typeof update
			appstore: typeof appstore
			dialogs: typeof dialogs
		}
	}
}
