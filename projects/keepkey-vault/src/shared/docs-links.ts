/**
 * Canonical docs.keepkey.com articles linked from in-app screens.
 *
 * One table so every dialog links the same way and the slugs stay a single
 * contract with the docs repo (BitHighlander/keepkey-docs-v8). The pages
 * quote the wizard copy verbatim, so a user landing there recognises the
 * screen they came from. Add new screens here — never inline a URL literal.
 */
const SETUP = 'https://docs.keepkey.com/docs/desktop/setup'

export const DOCS_LINKS = {
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
