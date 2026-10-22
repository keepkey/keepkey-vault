/**
 * Canonical docs.keepkey.com articles linked from in-app screens.
 *
 * One table so every dialog links the same way and the slugs stay a single
 * contract with the docs repo (BitHighlander/keepkey-docs-v8). The pages
 * quote the wizard copy verbatim, so a user landing there recognises the
 * screen they came from. Add new screens here — never inline a URL literal.
 */
const DOCS = 'https://docs.keepkey.com/docs'
const DESKTOP = `${DOCS}/desktop`
const SETUP = `${DESKTOP}/setup`

/** One video in the docs player (docs.keepkey.com/watch); the hash picks it. */
export const watch = (id: string) => `https://docs.keepkey.com/watch#${id}`

export const DOCS_LINKS = {
	/** Docs home (non-video). */
	docsHome: DOCS,
	/** The full video series. */
	watchAll: 'https://docs.keepkey.com/watch',

	// ── Desktop features ──────────────────────────────────────────────
	performance: `${DESKTOP}/performance`,
	portfolio: `${DESKTOP}/portfolio`,
	reports: `${DESKTOP}/portfolio#reports--tax-export`,
	audit: `${DESKTOP}/portfolio#all-chains-grey-rows-and-audit`,
	activity: `${DESKTOP}/portfolio#activity`,
	watchOnly: `${DESKTOP}/portfolio#watch-only-mode`,
	send: `${DESKTOP}/send-receive#send`,
	receive: `${DESKTOP}/send-receive#receive`,
	verifyOnDevice: `${DESKTOP}/verify-on-device`,
	swap: `${DESKTOP}/swap`,
	addressBook: `${DESKTOP}/address-book`,
	explore: `${DESKTOP}/explore`,
	pin: `${DESKTOP}/pin`,
	passphrase: `${DESKTOP}/passphrase`,
	firmware: `${DESKTOP}/firmware`,
	bip85: `${DESKTOP}/bip85`,
	wipeDevice: `${DESKTOP}/wipe-device`,
	missingCoins: `${DESKTOP}/troubleshooting#my-coins-are-missing-or-show-0`,
	linuxTips: `${DESKTOP}/linux-tips`,
	addressTypes: `${DOCS}/learn/address-types`,
	clearSigning: `${DOCS}/learn/clear-signing`,
	stayingSafe: `${DOCS}/learn/staying-safe`,

	// ── Settings sections ─────────────────────────────────────────────
	settings: `${DESKTOP}/settings`,
	settingsDevice: `${DESKTOP}/settings#device-overview`,
	settingsSecurity: `${DESKTOP}/settings#security`,
	settingsSigningPolicy: `${DESKTOP}/settings#signing-policy`,
	settingsApplication: `${DESKTOP}/settings#application-settings`,
	settingsFeatureFlags: `${DESKTOP}/settings#feature-flags`,
	settingsApi: `${DESKTOP}/settings#api-servers`,
	settingsPairing: `${DESKTOP}/settings#pairing-and-bearer-tokens`,

	/** Hub page covering the whole setup flow. */
	setupHub: SETUP,

	// ── Tutorial cards ────────────────────────────────────────────────
	pinScrambled: `${SETUP}/pin-scrambled`,
	recoveryWords: `${SETUP}/recovery-words`,
	cipherRecovery: `${SETUP}/cipher-recovery`,
	deviceScreen: `${SETUP}/device-screen`,
	appConnections: `${SETUP}/app-connections`,
	hiddenWallets: `${SETUP}/hidden-wallets`,

	// ── Wizard steps ──────────────────────────────────────────────────
	createOrRecover: `${SETUP}/create-or-recover`,
	creatingWallet: `${SETUP}/creating-wallet`,
	deviceName: `${SETUP}/device-name`,
	verifyBackup: `${SETUP}/verify-backup`,

	/** Section anchor, not a page — why more words don't add entropy. */
	seedLengthEntropy: `${SETUP}/create-or-recover#seed-length-and-entropy`,
} as const

export type DocsLink = (typeof DOCS_LINKS)[keyof typeof DOCS_LINKS]
