import type { ReactNode } from "react"
import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { useFiat } from "../lib/fiat-context"
import { generateQRSvg } from "../lib/qr"
import { ZCASH_V2_CSS } from "./zcash-v2-styles"

/** Validate Zcash recipient: unified (u1...), Sapling (zs1...), or transparent (t1.../t3...) */
function validateZcashRecipient(addr: string): { valid: boolean; error?: string } {
	const s = addr.trim()
	if (!s) return { valid: false }
	if (s.startsWith('u1') && s.length >= 70) return { valid: true }
	if (s.startsWith('zs1') && s.length >= 70) return { valid: true }
	const BASE58 = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/
	if ((s.startsWith('t1') || s.startsWith('t3')) && s.length === 35 && BASE58.test(s)) return { valid: true }
	return { valid: false, error: 'invalidZcashRecipient' }
}

/** KeepKey didn't support Zcash shielded before this block — safe skip point */
const KEEPKEY_RELEASE_BLOCK = 3282941

type SidecarStatus = "checking" | "ready" | "not_running" | "initializing"
type ScanState = "idle" | "scanning" | "done"
type Page = "overview" | "send" | "shield" | "receive" | "scan" | "history"

interface ScanProgress {
	percent: number
	scannedHeight: number
	tipHeight: number
	blocksPerSec: number
	etaSeconds: number
}

function formatEta(seconds: number): string {
	if (seconds <= 0) return "calculating…"
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) {
		const m = Math.floor(seconds / 60)
		const s = seconds % 60
		return s > 0 ? `${m}m ${s}s` : `${m}m`
	}
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatZec(zatoshis: number): string {
	return (zatoshis / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0"
}

// Each tab gets a small SVG glyph + accent color so the nav reads at a glance.
// Colors are pulled from the design palette: gold = primary, green = inbound,
// copper = outbound, blue/violet/teal for navigation actions.
const ICO_OVERVIEW = (
	<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
		<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/>
		<rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>
	</svg>
)
const ICO_SEND = (
	<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M14 2 L7 9"/><path d="M14 2 L9 14 L7 9 L2 7 Z"/>
	</svg>
)
const ICO_SHIELD = (
	<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
		<path d="M8 1.5 L13 3.5 V8 C13 11 10.5 13.5 8 14.5 C5.5 13.5 3 11 3 8 V3.5 Z"/>
	</svg>
)
const ICO_RECEIVE = (
	<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M8 2 V11"/><path d="M4 7 L8 11 L12 7"/><path d="M3 14 H13"/>
	</svg>
)
const ICO_SYNC = (
	<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M2 8 A6 6 0 0 1 13 5"/><path d="M13 2 V5 H10"/>
		<path d="M14 8 A6 6 0 0 1 3 11"/><path d="M3 14 V11 H6"/>
	</svg>
)
const ICO_HISTORY = (
	<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="8" cy="8" r="6"/><path d="M8 4 V8 L11 10"/>
	</svg>
)

const NAV_TABS: Array<{ id: Page; label: string; icon: ReactNode; color: string }> = [
	{ id: "overview", label: "Overview", icon: ICO_OVERVIEW, color: "#c9a368" /* gold */ },
	{ id: "send",     label: "Send",     icon: ICO_SEND,     color: "#d97757" /* copper */ },
	{ id: "shield",   label: "Shield",   icon: ICO_SHIELD,   color: "#6ee787" /* green */ },
	{ id: "receive",  label: "Receive",  icon: ICO_RECEIVE,  color: "#7aa6f0" /* blue */ },
	{ id: "scan",     label: "Sync",     icon: ICO_SYNC,     color: "#b794f4" /* violet */ },
	{ id: "history",  label: "History",  icon: ICO_HISTORY,  color: "#56d4d4" /* teal */ },
]

let stylesInjected = false
function ensureStylesInjected() {
	if (stylesInjected || typeof document === "undefined") return
	stylesInjected = true
	const link = document.createElement("link")
	link.rel = "stylesheet"
	link.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
	document.head.appendChild(link)
	const style = document.createElement("style")
	style.setAttribute("data-zcash-v2", "")
	style.textContent = ZCASH_V2_CSS
	document.head.appendChild(style)
}

export function ZcashPrivacyTab() {
	const { t } = useTranslation("asset")
	const { locale: fiatLocale } = useFiat()

	useEffect(() => { ensureStylesInjected() }, [])

	const [page, setPage] = useState<Page>("overview")

	const [status, setStatus] = useState<SidecarStatus>("checking")
	const [orchardAddress, setOrchardAddress] = useState<string | null>(null)
	const [balance, setBalance] = useState<{
		confirmed: number; pending: number
		notes_unspent?: number; spendable_confirmed?: number
		spendable_notes_count?: number; min_confirmations?: number
	} | null>(null)
	const [syncedTo, setSyncedTo] = useState<number | null>(null)
	const [scanState, setScanState] = useState<ScanState>("idle")
	const [scanResult, setScanResult] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	const [recipient, setRecipient] = useState("")
	const [amount, setAmount] = useState("")
	const [memo, setMemo] = useState("")
	const [sending, setSending] = useState(false)
	const [sendResult, setSendResult] = useState<string | null>(null)
	const [sendError, setSendError] = useState<string | null>(null)
	const [sendStep, setSendStep] = useState<string | null>(null)
	// Fires true whenever the device emits a ButtonRequest mid-signing —
	// flips the TxFlowStatus headline from "Signing on device" to
	// "Press the button on your KeepKey". Auto-clears 6s after the last
	// request (we don't get an explicit "button pressed" event from
	// hdwallet, so we assume the user has pressed if no new request lands).
	const [awaitingButton, setAwaitingButton] = useState(false)
	const awaitingButtonTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const [shieldAmount, setShieldAmount] = useState("")
	const [shielding, setShielding] = useState(false)
	const [shieldResult, setShieldResult] = useState<string | null>(null)
	const [shieldError, setShieldError] = useState<string | null>(null)
	const [shieldStep, setShieldStep] = useState<string | null>(null)

	const [deshieldRecipient, setDeshieldRecipient] = useState("")
	// User's own transparent ZEC address (m/44'/133'/0'/0/0). Lazily fetched
	// once the sidecar is ready so the Unshield form can prefill the recipient
	// — the common case is users moving funds back to their own t-addr, not
	// sending to a third party. They can still paste a different address.
	const [myTransparentAddr, setMyTransparentAddr] = useState<string | null>(null)
	const tAddrPrefilledRef = useRef(false)
	// Confirmed-mature transparent ZEC balance (≥10 conf, in zatoshis) — what
	// the shield builder can actually spend. Drives the Shield card's
	// "Available" line + Max button. `pending` covers UTXOs still under the
	// 10-conf gate (e.g. fresh deshield-back); shown separately so users can
	// see why the chain-level balance differs from what's shieldable now.
	const [transparentBalanceZat, setTransparentBalanceZat] = useState<number | null>(null)
	const [transparentPendingZat, setTransparentPendingZat] = useState<number>(0)
	const [transparentBalanceLoading, setTransparentBalanceLoading] = useState(false)
	const [deshieldAmount, setDeshieldAmount] = useState("")
	const [deshielding, setDeshielding] = useState(false)
	const [deshieldResult, setDeshieldResult] = useState<string | null>(null)
	const [deshieldError, setDeshieldError] = useState<string | null>(null)
	const [deshieldStep, setDeshieldStep] = useState<string | null>(null)

	const [transactions, setTransactions] = useState<Array<{
		id: number; value: number; block_height: number; tx_index: number
		is_spent: boolean; memo: string | null; nullifier: string
		txid: string | null; action_index: number
	}>>([])
	const [loadingTxs, setLoadingTxs] = useState(false)
	const [backfilling, setBackfilling] = useState(false)
	const [backfillResult, setBackfillResult] = useState<string | null>(null)
	const [historyFilter, setHistoryFilter] = useState<"all" | "received" | "spent" | "memo">("all")

	const deshieldRecipientValidation = useMemo(() => {
		if (!deshieldRecipient) return null
		const s = deshieldRecipient.trim()
		const BASE58 = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/
		if ((s.startsWith('t1') || s.startsWith('t3')) && s.length === 35 && BASE58.test(s)) return { valid: true }
		return { valid: false, error: 'deshieldRequiresTransparent' }
	}, [deshieldRecipient])

	const recipientValidation = useMemo(() => {
		if (!recipient) return null
		return validateZcashRecipient(recipient)
	}, [recipient])

	useEffect(() => onRpcMessage("shield-progress", (payload: { step: string; detail?: string }) => {
		setShieldStep(payload.step)
		if (payload.step === "complete" && payload.detail) {
			setShieldResult(payload.detail); setShielding(false); setShieldStep(null)
		}
	}), [])

	useEffect(() => onRpcMessage("deshield-progress", (payload: { step: string; detail?: string }) => {
		setDeshieldStep(payload.step)
		if (payload.step === "complete" && payload.detail) {
			setDeshieldResult(payload.detail); setDeshielding(false); setDeshieldStep(null)
		}
	}), [])

	useEffect(() => onRpcMessage("send-progress", (payload: { step: string; detail?: string }) => {
		setSendStep(payload.step)
		if (payload.step === "complete" && payload.detail) {
			setSendResult(payload.detail); setSending(false); setSendStep(null)
		}
	}), [])

	useEffect(() => onRpcMessage("device-button-request", () => {
		setAwaitingButton(true)
		if (awaitingButtonTimeoutRef.current) clearTimeout(awaitingButtonTimeoutRef.current)
		awaitingButtonTimeoutRef.current = setTimeout(() => setAwaitingButton(false), 6000)
	}), [])

	// Clear awaitingButton whenever any tx phase transitions — keeps the state
	// honest after a flow finishes or moves into broadcasting.
	useEffect(() => {
		if (sendStep !== "signing" && shieldStep !== "signing" && deshieldStep !== "signing") {
			setAwaitingButton(false)
			if (awaitingButtonTimeoutRef.current) {
				clearTimeout(awaitingButtonTimeoutRef.current)
				awaitingButtonTimeoutRef.current = null
			}
		}
	}, [sendStep, shieldStep, deshieldStep])

	const [needsScan, setNeedsScan] = useState(false)
	const [scanInFlight, setScanInFlight] = useState(false)

	const refreshBalance = useCallback(async () => {
		try {
			const bal = await rpcRequest<{
				confirmed: number; pending: number; synced_to?: number | null
				notes_unspent?: number; spendable_confirmed?: number
				spendable_notes_count?: number; min_confirmations?: number
			}>("zcashShieldedBalance", undefined, 10000)
			setBalance({
				confirmed: bal.confirmed, pending: bal.pending,
				notes_unspent: bal.notes_unspent,
				spendable_confirmed: bal.spendable_confirmed,
				spendable_notes_count: bal.spendable_notes_count,
				min_confirmations: bal.min_confirmations,
			})
			if (bal.synced_to != null) { setSyncedTo(bal.synced_to); setNeedsScan(false) }
			else setNeedsScan(true)
		} catch { /* not available yet */ }
	}, [])

	const loadTransactions = useCallback(async () => {
		setLoadingTxs(true)
		try {
			const result = await rpcRequest<{ transactions: typeof transactions }>(
				"zcashGetTransactions", undefined, 30000
			)
			setTransactions(result.transactions || [])
		} catch { /* not available yet */ }
		setLoadingTxs(false)
	}, [])

	useEffect(() => {
		let cancelled = false
		;(async () => {
			try {
				const r = await rpcRequest<{
					ready: boolean; fvk_loaded: boolean; address: string | null
					synced_to?: number | null
				}>("zcashShieldedStatus", undefined, 5000)
				if (cancelled) return
				if (!r.ready) { setStatus("not_running"); return }
				if (r.synced_to != null) { setSyncedTo(r.synced_to); setNeedsScan(false) }
				else setNeedsScan(true)
				if (r.fvk_loaded && r.address) {
					setOrchardAddress(r.address); setStatus("ready")
					refreshBalance(); loadTransactions(); return
				}
				setStatus("initializing")
				const initRes = await rpcRequest<{ fvk: any; address: string }>(
					"zcashShieldedInit", { account: 0 }, 60000
				)
				if (cancelled) return
				setOrchardAddress(initRes.address); setStatus("ready")
				refreshBalance(); loadTransactions()
			} catch (e: any) {
				if (cancelled) return
				console.error("[ZcashPrivacyTab] Auto-init failed:", e)
				setStatus("not_running")
			}
		})()
		return () => { cancelled = true }
	}, [refreshBalance, loadTransactions])

	// First time the user lands on the Shield page, prefill the Unshield "To"
	// field with their own t-addr. Most users unshield back to themselves; the
	// field stays editable for the third-party case.
	useEffect(() => {
		if (page !== "shield") return
		if (tAddrPrefilledRef.current) return
		if (!myTransparentAddr) return
		if (deshieldRecipient) return
		setDeshieldRecipient(myTransparentAddr)
		tAddrPrefilledRef.current = true
	}, [page, myTransparentAddr, deshieldRecipient])

	// Lazily fetch the user's transparent ZEC address once the privacy engine
	// is ready. Uses btcGetAddress (no display) — same path the shield builder
	// derives from. Cached for the session; UI prefills the Unshield "To" field
	// the first time the user opens the Shield page.
	useEffect(() => {
		if (status !== "ready" || myTransparentAddr) return
		let cancelled = false
		;(async () => {
			try {
				const result = await rpcRequest<{ address?: string } | string>("btcGetAddress", {
					addressNList: [0x80000000 + 44, 0x80000000 + 133, 0x80000000, 0, 0],
					coin: "Zcash",
					scriptType: "p2pkh",
					showDisplay: false,
				}, 30000)
				if (cancelled) return
				const addr = typeof result === "string" ? result : result?.address
				if (addr) setMyTransparentAddr(addr)
			} catch (e) {
				console.warn("[ZcashPrivacyTab] failed to derive own t-addr:", e)
			}
		})()
		return () => { cancelled = true }
	}, [status, myTransparentAddr])

	// Refresh transparent ZEC balance using zcashTransparentBalance — same
	// Pioneer ListUnspent the shield builder uses, scoped to the single
	// m/44'/133'/0'/0/0 t-addr it sweeps. Chain-level getBalance sums the whole
	// xpub (every derived address), which produced an inflated Max that the
	// shield call then rejected with "Insufficient transparent balance".
	const refreshTransparentBalance = useCallback(async () => {
		setTransparentBalanceLoading(true)
		try {
			const r = await rpcRequest<{
				address: string; balanceZat: number; pendingZat: number
				matureCount: number; pendingCount: number
			}>("zcashTransparentBalance", undefined, 20000)
			setTransparentBalanceZat(Number.isFinite(r.balanceZat) && r.balanceZat >= 0 ? r.balanceZat : 0)
			setTransparentPendingZat(Number.isFinite(r.pendingZat) && r.pendingZat >= 0 ? r.pendingZat : 0)
			if (r.address && !myTransparentAddr) setMyTransparentAddr(r.address)
		} catch (e) {
			console.warn("[ZcashPrivacyTab] failed to fetch shieldable t-addr balance:", e)
			setTransparentBalanceZat(null)
			setTransparentPendingZat(0)
		}
		setTransparentBalanceLoading(false)
	}, [myTransparentAddr])

	useEffect(() => {
		if (status !== "ready") return
		if (page !== "shield") return
		if (transparentBalanceZat != null) return
		refreshTransparentBalance()
	}, [status, page, transparentBalanceZat, refreshTransparentBalance])

	const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
	const smoothPercent = useRef(0)
	const [displayPercent, setDisplayPercent] = useState(0)

	useEffect(() => onRpcMessage("scan-progress", (payload: ScanProgress) => {
		setScanProgress(payload)
		setScanInFlight(payload.percent < 100)
		if (payload.percent >= 100) { refreshBalance(); loadTransactions() }
	}), [refreshBalance, loadTransactions])

	useEffect(() => {
		if (!scanProgress) return
		const target = scanProgress.percent
		if (target <= smoothPercent.current) smoothPercent.current = 0
		const id = setInterval(() => {
			const diff = target - smoothPercent.current
			if (diff < 0.05) {
				smoothPercent.current = target; setDisplayPercent(target); clearInterval(id)
			} else {
				smoothPercent.current += diff * 0.3; setDisplayPercent(smoothPercent.current)
			}
		}, 50)
		return () => clearInterval(id)
	}, [scanProgress])

	useEffect(() => {
		if (scanState !== "scanning") {
			setScanProgress(null); smoothPercent.current = 0; setDisplayPercent(0)
		}
	}, [scanState])

	const [scanFromHeight, setScanFromHeight] = useState("")
	const [advancedScanOpen, setAdvancedScanOpen] = useState(false)

	const handleScan = useCallback(async (startHeight?: number, fullRescan?: boolean) => {
		setScanState("scanning"); setScanResult(null)
		try {
			const params: { startHeight?: number; fullRescan?: boolean } = {}
			if (startHeight != null) params.startHeight = startHeight
			if (fullRescan) params.fullRescan = true
			const timeout = startHeight != null ? 300000 : 1800000
			const result = await rpcRequest<{
				balance: number; notes_found: number; new_notes?: number
				synced_to: number; blocks_scanned: number
			}>("zcashShieldedScan", params, timeout)
			setSyncedTo(result.synced_to); setNeedsScan(false)
			const newInRange = result.new_notes ?? 0
			const msg = newInRange > 0
				? `Found ${newInRange} new payment${newInRange === 1 ? "" : "s"}`
				: result.blocks_scanned > 0
					? `Up to date — scanned ${result.blocks_scanned.toLocaleString(fiatLocale)} blocks`
					: `Already up to date`
			setScanResult(msg); setScanState("done")
			refreshBalance(); loadTransactions()
		} catch (e: any) {
			setScanResult(e.message || "Scan failed"); setScanState("idle")
		}
	}, [refreshBalance, loadTransactions, fiatLocale])

	const handleBackfillMemos = useCallback(async () => {
		setBackfilling(true); setBackfillResult(null)
		try {
			const result = await rpcRequest<{ backfilled: number }>(
				"zcashBackfillMemos", undefined, 300000
			)
			setBackfillResult(t("memosBackfilled", { count: result.backfilled }))
			await loadTransactions()
		} catch (e: any) {
			setBackfillResult(e.message || "Failed to fetch memos")
		}
		setBackfilling(false)
	}, [t, loadTransactions])

	const parseZatoshis = (s: string): number => {
		const parts = s.split(".")
		const whole = BigInt(parts[0] || "0") * 100_000_000n
		const fracStr = (parts[1] || "").padEnd(8, "0").slice(0, 8)
		const frac = BigInt(fracStr)
		const big = whole + frac
		if (big <= 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid amount")
		return Number(big)
	}

	const handleSend = useCallback(async () => {
		if (!recipient || !amount) return
		if (recipientValidation && !recipientValidation.valid) {
			setSendError(recipientValidation.error ? t(recipientValidation.error) : t("invalidZcashRecipient"))
			return
		}
		setSending(true); setSendError(null); setSendResult(null); setSendStep("building")
		try {
			const zatoshis = parseZatoshis(amount)
			if (memo && new TextEncoder().encode(memo).length > 512) throw new Error(t("memoTooLong"))
			// 10-min timeout — Halo 2 proof + on-device Orchard signing can run >60s
			const result = await rpcRequest<{ txid: string }>("zcashShieldedSend",
				{ recipient, amount: zatoshis, memo: memo || undefined }, 600000)
			setSendResult(result.txid)
			setRecipient(""); setAmount(""); setMemo("")
			refreshBalance()
		} catch (e: any) { setSendError(e.message || "Send failed") }
		setSending(false); setSendStep(null)
	}, [recipient, amount, memo, recipientValidation, refreshBalance, t])

	const handleShield = useCallback(async () => {
		if (!shieldAmount) return
		setShielding(true); setShieldError(null); setShieldResult(null); setShieldStep("building")
		try {
			const zatoshis = parseZatoshis(shieldAmount)
			const result = await rpcRequest<{ txid: string }>("zcashShieldZec",
				{ amount: zatoshis }, 600000)
			setShieldResult(result.txid); setShieldAmount("")
			refreshBalance(); refreshTransparentBalance()
		} catch (e: any) { setShieldError(e.message || "Shield failed") }
		setShielding(false); setShieldStep(null)
	}, [shieldAmount, refreshBalance, refreshTransparentBalance])

	const handleDeshield = useCallback(async () => {
		if (!deshieldRecipient || !deshieldAmount) return
		if (deshieldRecipientValidation && !deshieldRecipientValidation.valid) {
			setDeshieldError(deshieldRecipientValidation.error ? t(deshieldRecipientValidation.error) : t("invalidAddress"))
			return
		}
		setDeshielding(true); setDeshieldError(null); setDeshieldResult(null); setDeshieldStep("building")
		try {
			const zatoshis = parseZatoshis(deshieldAmount)
			const result = await rpcRequest<{ txid: string }>("zcashDeshieldZec",
				{ recipient: deshieldRecipient, amount: zatoshis }, 600000)
			setDeshieldResult(result.txid)
			setDeshieldRecipient(""); setDeshieldAmount("")
			refreshBalance(); refreshTransparentBalance()
		} catch (e: any) { setDeshieldError(e.message || "Deshield failed") }
		setDeshielding(false); setDeshieldStep(null)
	}, [deshieldRecipient, deshieldAmount, deshieldRecipientValidation, refreshBalance, refreshTransparentBalance, t])

	const copyAddress = useCallback(() => {
		if (!orchardAddress) return
		navigator.clipboard.writeText(orchardAddress)
		setCopied(true); setTimeout(() => setCopied(false), 2000)
	}, [orchardAddress])

	const [verifyingOnDevice, setVerifyingOnDevice] = useState(false)
	const [verifyError, setVerifyError] = useState<string | null>(null)
	const [verifySucceeded, setVerifySucceeded] = useState(false)
	const verifyOnDevice = useCallback(async () => {
		if (!orchardAddress) return
		setVerifyingOnDevice(true); setVerifyError(null); setVerifySucceeded(false)
		try {
			const result = await rpcRequest<{ address: string }>("zcashDisplayAddress", { account: 0 }, 600000)
			if (result.address) setOrchardAddress(result.address)
			setVerifySucceeded(true); setTimeout(() => setVerifySucceeded(false), 4000)
		} catch (e: any) { setVerifyError(e?.message ?? String(e)) }
		finally { setVerifyingOnDevice(false) }
	}, [orchardAddress])

	const spendableMaxZatoshis = useMemo(() => {
		if (!balance) return 0
		const spendable = balance.spendable_confirmed ?? 0
		if (spendable <= 0) return 0
		const nSpends = Math.max(1, balance.spendable_notes_count ?? 1)
		const orchardActions = Math.max(2, nSpends)
		const fee = 5000 * Math.max(2, orchardActions + 1)
		return Math.max(0, spendable - fee)
	}, [balance])

	// Shield max — transparent balance minus the ZIP-317 fee for shielding.
	// Shield is one transparent input → 2 padded Orchard outputs (logical
	// actions = 2 transparent + 2 orchard = 4); fee = 5000 * max(2, 4) = 20000.
	// We round up to 25000 zat (~0.00025 ZEC) for safety against UTXO-set growth.
	const SHIELD_FEE_ZAT = 25_000
	const shieldMaxZatoshis = useMemo(() => {
		if (transparentBalanceZat == null) return 0
		return Math.max(0, transparentBalanceZat - SHIELD_FEE_ZAT)
	}, [transparentBalanceZat])

	const filteredTxs = useMemo(() => {
		switch (historyFilter) {
			case "received": return transactions.filter(tx => !tx.is_spent)
			case "spent": return transactions.filter(tx => tx.is_spent)
			case "memo": return transactions.filter(tx => !!tx.memo)
			default: return transactions
		}
	}, [transactions, historyFilter])

	const recentTxs = transactions.slice(0, 5)

	if (status === "not_running") {
		return (
			<div className="zcash-v2">
				<div className="empty-card">
					<h3>Privacy engine not running</h3>
					<p>{t("zcashCliRequired")}</p>
				</div>
			</div>
		)
	}

	if (status === "checking" || status === "initializing") {
		return (
			<div className="zcash-v2">
				<div className="empty-card">
					<h3>Setting up privacy</h3>
					<p>Deriving the viewing key from your KeepKey. One-time setup, takes a few seconds.</p>
				</div>
			</div>
		)
	}

	const synced = !needsScan && !scanInFlight && syncedTo != null

	return (
		<div className="zcash-v2">
			{/* balance card */}
			<div className="zk-balance">
				<div className="bal-glyph">
					<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
						<path d="M8 1.5 L13 3.5 V8 C13 11 10.5 13.5 8 14.5 C5.5 13.5 3 11 3 8 V3.5 Z"/>
					</svg>
				</div>
				<div className="main">
					<div className="lbl">Shielded balance</div>
					<div className="amount">
						{balance ? formatZec(balance.confirmed) : "—"}
						<span className="ticker">ZEC</span>
						{balance && balance.pending > 0 && (
							<span className="pending">+ {formatZec(balance.pending)} pending</span>
						)}
					</div>
					{scanInFlight && scanProgress ? (
						<div className="syncing">
							<div className="pb"><div className="pb-fill" style={{ width: `${Math.max(displayPercent, 0.5)}%` }} /></div>
							<span>Syncing {Math.floor(displayPercent)}%</span>
						</div>
					) : (
						<div className="sub">
							{syncedTo
								? `Synced to block #${syncedTo.toLocaleString(fiatLocale)}`
								: "Not synced yet"}
						</div>
					)}
				</div>
				<div className="status-pill">
					<span className={`led ${scanInFlight ? "amber" : ""}`} />
					{scanInFlight ? "Syncing" : synced ? "Up to date" : "Idle"}
				</div>
			</div>

			{/* page nav */}
			<nav className="page-nav">
				{NAV_TABS.map(tab => (
					<button key={tab.id}
						data-active={page === tab.id ? "1" : undefined}
						onClick={() => setPage(tab.id as Page)}
					>
						<span className="ico" style={{ color: tab.color }}>{tab.icon}</span>
						{tab.label}
					</button>
				))}
			</nav>

			{/* ===== OVERVIEW ===== */}
			{page === "overview" && (
				<section>
					<div className="quick-actions">
						<button className="quick-action" onClick={() => setPage("send")}>
							<div className="qa-title">Send</div>
							<div className="qa-sub">Pay any Zcash address privately</div>
						</button>
						<button className="quick-action" onClick={() => setPage("receive")}>
							<div className="qa-title">Receive</div>
							<div className="qa-sub">Show your address &amp; QR code</div>
						</button>
						<button className="quick-action" onClick={() => setPage("shield")}>
							<div className="qa-title">Shield / Unshield</div>
							<div className="qa-sub">Move between private &amp; public</div>
						</button>
					</div>

					<div className="card">
						<div className="card-head">
							<div className="title">Recent activity</div>
							<button className="ghost-btn" onClick={() => setPage("history")}>View all →</button>
						</div>
						<div className="recent-list">
							{loadingTxs ? (
								<div className="recent-empty">Loading…</div>
							) : recentTxs.length === 0 ? (
								<div className="recent-empty">No transactions yet</div>
							) : recentTxs.map(tx => (
								<div className="recent-row" key={tx.id}>
									<span className={`pill ${tx.is_spent ? "pill-trans" : "pill-orchard"}`}>
										{tx.is_spent ? "Sent" : "Received"}
									</span>
									<div className="label">
										{tx.memo
											? <>"{tx.memo.slice(0, 60)}{tx.memo.length > 60 ? "…" : ""}"</>
											: <>Block #{tx.block_height.toLocaleString(fiatLocale)}</>}
									</div>
									<div className={`v ${tx.is_spent ? "amount-neg" : "amount-pos"}`}>
										{tx.is_spent ? "−" : "+"}{formatZec(tx.value)} ZEC
									</div>
								</div>
							))}
						</div>
					</div>
				</section>
			)}

			{/* ===== SEND ===== */}
			{page === "send" && (
				<section>
					<div className="page-head">
						<h2>Send ZEC privately</h2>
						<p>Your KeepKey signs the transaction. Recipients and amounts stay encrypted on-chain.</p>
					</div>

					<div className="form-page with-aside">
						<div className="card">
							<div className="card-body">
								<div className="field-grid">
									<div className="field">
										<span className="lbl">To</span>
										<input
											type="text"
											placeholder="Paste a Zcash address (u1… or t1…)"
											value={recipient}
											onChange={e => setRecipient(e.target.value)}
										/>
									</div>
									{recipientValidation && !recipientValidation.valid && recipientValidation.error && (
										<div className="field-err">{t(recipientValidation.error)}</div>
									)}
									<div className="field">
										<span className="lbl">Amount</span>
										<input
											type="text"
											placeholder="0.00000000"
											value={amount}
											onChange={e => setAmount(e.target.value)}
										/>
										<span className="suffix">ZEC</span>
										<button
											className="max"
											onClick={() => setAmount(formatZec(spendableMaxZatoshis))}
											disabled={spendableMaxZatoshis === 0}
										>Max</button>
									</div>
									<div className="field">
										<span className="lbl">Memo</span>
										<input
											type="text"
											placeholder="Optional, encrypted to recipient"
											value={memo}
											onChange={e => setMemo(e.target.value)}
										/>
										<span className="suffix">{new TextEncoder().encode(memo).length}/512</span>
									</div>
								</div>

								<TxFlowStatus step={sendStep} awaitingButton={awaitingButton} kind="send" intent="shielded send" />

								{!sending && (
									<div className="submit-row">
										<div className="submit-hint">
											<div className="kk-glyph">kk</div>
											Verify the recipient and amount on your KeepKey
										</div>
										<button
											className="submit"
											onClick={handleSend}
											disabled={!recipient || !amount || (recipientValidation != null && !recipientValidation.valid)}
										>Send</button>
									</div>
								)}

								{sendResult && <ResultBox kind="ok" title="Sent" txid={sendResult} />}
								{sendError && <ResultBox kind="err" title="Send failed" message={sendError} />}
							</div>
						</div>

						<div className="form-aside">
							<div className="aside-card">
								<h5>Summary</h5>
								<div className="kv"><span>Amount</span><span className="v">{amount || "—"} ZEC</span></div>
								<div className="kv"><span>Network fee</span><span className="v">~0.00005</span></div>
								<div className="kv"><span>Privacy</span><span className="v gold">Maximum</span></div>
							</div>
							<div className="aside-card">
								<h5>Available to send</h5>
								<p style={{ fontFamily: "var(--zk-font-mono)", fontSize: 14, color: "var(--zk-fg)" }}>
									{formatZec(spendableMaxZatoshis)} ZEC
								</p>
								<p style={{ marginTop: 4 }}>After network fee. Notes need {balance?.min_confirmations ?? 10} confirmations.</p>
							</div>
						</div>
					</div>
				</section>
			)}

			{/* ===== SHIELD / UNSHIELD ===== */}
			{page === "shield" && (
				<section>
					<div className="page-head">
						<h2>Shield &amp; Unshield</h2>
						<p>Shielded ZEC hides amounts and recipients. Transparent ZEC is publicly visible like Bitcoin.</p>
					</div>

					<div className="form-page">
						<div className="card">
							<div className="card-head">
								<div className="title" style={{ color: "var(--zk-gold)" }}>Shield → private</div>
								<span className="meta">From your t-addr</span>
							</div>
							<div className="card-body">
								<div className="balance-row">
									<span>Available to shield</span>
									<strong>
										{transparentBalanceLoading
											? "loading…"
											: transparentBalanceZat == null
												? "—"
												: `${formatZec(transparentBalanceZat)} ZEC`}
									</strong>
									{transparentBalanceZat != null && !transparentBalanceLoading && (
										<button className="ghost-btn" onClick={refreshTransparentBalance} title="Refresh">↻</button>
									)}
								</div>
								{transparentPendingZat > 0 && (
									<div className="pending-note">
										+{formatZec(transparentPendingZat)} ZEC pending — UTXOs need 10 confirmations before they can be shielded (reorg safety). Refresh in a few minutes.
									</div>
								)}
								<div className="field-grid">
									<div className="field">
										<span className="lbl">Amount</span>
										<input
											type="text"
											placeholder="0.00000000"
											value={shieldAmount}
											onChange={e => setShieldAmount(e.target.value)}
										/>
										<span className="suffix">ZEC</span>
										<button
											className="max"
											onClick={() => setShieldAmount(formatZec(shieldMaxZatoshis))}
											disabled={shieldMaxZatoshis === 0}
											title={`Reserves ${formatZec(SHIELD_FEE_ZAT)} ZEC for the network fee`}
										>Max</button>
									</div>
								</div>
								<TxFlowStatus step={shieldStep} awaitingButton={awaitingButton} kind="shield" intent="shield transaction" />

								{!shielding && (
									<div className="submit-row">
										<div className="submit-hint">
											<div className="kk-glyph">kk</div>
											Confirm the shield on your KeepKey
										</div>
										<button
											className="submit"
											onClick={handleShield}
											disabled={!shieldAmount}
										>Shield</button>
									</div>
								)}
								{shieldResult && <ResultBox kind="ok" title="Shielded" txid={shieldResult} />}
								{shieldError && <ResultBox kind="err" title="Shield failed" message={shieldError} />}
							</div>
						</div>

						<div className="card">
							<div className="card-head">
								<div className="title" style={{ color: "var(--zk-copper)" }}>Unshield → public</div>
								<span className="meta">Visible on chain</span>
							</div>
							<div className="card-body">
								<div className="balance-row">
									<span>Available shielded</span>
									<strong>
										{balance ? `${formatZec(spendableMaxZatoshis)} ZEC` : "—"}
									</strong>
									{balance && (
										<span className="balance-hint">
											after fee · {balance.spendable_notes_count ?? 0} spendable notes
										</span>
									)}
								</div>
								<div className="field-grid">
									<div className="field">
										<span className="lbl">To</span>
										<input
											type="text"
											placeholder="Transparent address (t1… or t3…)"
											value={deshieldRecipient}
											onChange={e => setDeshieldRecipient(e.target.value)}
										/>
										{myTransparentAddr && deshieldRecipient !== myTransparentAddr && (
											<button
												className="max"
												onClick={() => setDeshieldRecipient(myTransparentAddr)}
												title={`Use your own t-addr: ${myTransparentAddr}`}
											>My t-addr</button>
										)}
									</div>
									{myTransparentAddr && deshieldRecipient === myTransparentAddr && (
										<div className="field-hint">Sending to your own t-addr (m/44'/133'/0'/0/0)</div>
									)}
									{deshieldRecipientValidation && !deshieldRecipientValidation.valid && deshieldRecipientValidation.error && (
										<div className="field-err">{t(deshieldRecipientValidation.error)}</div>
									)}
									<div className="field">
										<span className="lbl">Amount</span>
										<input
											type="text"
											placeholder="0.00000000"
											value={deshieldAmount}
											onChange={e => setDeshieldAmount(e.target.value)}
										/>
										<span className="suffix">ZEC</span>
										<button
											className="max"
											onClick={() => setDeshieldAmount(formatZec(spendableMaxZatoshis))}
											disabled={spendableMaxZatoshis === 0}
										>Max</button>
									</div>
								</div>
								<TxFlowStatus step={deshieldStep} awaitingButton={awaitingButton} kind="unshield" intent="unshield transaction" />

								{!deshielding && (
									<div className="submit-row">
										<div className="submit-hint" style={{ color: "var(--zk-copper)" }}>
											⚠ This will be publicly visible on chain
										</div>
										<button
											className="submit warn"
											onClick={handleDeshield}
											disabled={!deshieldRecipient || !deshieldAmount || (deshieldRecipientValidation != null && !deshieldRecipientValidation.valid)}
										>Unshield</button>
									</div>
								)}
								{deshieldResult && <ResultBox kind="ok" title="Unshielded" txid={deshieldResult} />}
								{deshieldError && <ResultBox kind="err" title="Unshield failed" message={deshieldError} />}
							</div>
						</div>
					</div>
				</section>
			)}

			{/* ===== RECEIVE ===== */}
			{page === "receive" && orchardAddress && (
				<section>
					<div className="page-head">
						<h2>Receive ZEC</h2>
						<p>Share this address. Senders pay into your Orchard pool automatically.</p>
					</div>

					<div className="card">
						<div className="card-body">
							<div className="receive-grid">
								<div className="qr-wrap">
									<div dangerouslySetInnerHTML={{ __html: generateQRSvg(orchardAddress, 4, 0) }} />
								</div>
								<div>
									<div className="addr-eyebrow">Your Zcash address (Unified)</div>
									<div className="addr-box">{orchardAddress}</div>
									<button className="ghost-btn" onClick={copyAddress}>
										{copied ? "✓ Copied" : "Copy address"}
									</button>
								</div>
							</div>
						</div>
					</div>

					{/* Show on device — promoted to a big primary action because verifying
					    the address on the hardware screen is the only way a user can be sure
					    the address shown here wasn't swapped by a compromised host. */}
					<div className="verify-card">
						<div className="verify-head">
							<div className="verify-ico">{ICO_SHIELD}</div>
							<div>
								<div className="verify-title">Always verify before receiving large amounts</div>
								<div className="verify-sub">
									Compare the full address on your KeepKey screen to the one shown above.
									This is the only defense against a compromised computer swapping the address.
									For Zcash, also check the address on the sender's screen — once funds arrive,
									the on-chain trail is private to you.
								</div>
							</div>
						</div>
						<button
							className="submit lg verify-btn"
							onClick={verifyOnDevice}
							disabled={verifyingOnDevice || !orchardAddress}
						>
							<span className="verify-btn-ico">{ICO_SHIELD}</span>
							{verifyingOnDevice
								? "Check your KeepKey screen…"
								: verifySucceeded
									? "✓ Verified on device"
									: "Show address on KeepKey"}
						</button>
						<div className="verify-note">
							⏱ Takes <strong>over 60 seconds</strong> — deriving a Zcash address on the
							KeepKey requires heavy cryptographic computation (Orchard / Halo 2). The
							device will appear busy; this is normal. The full address shows on screen
							when the computation completes.
						</div>
						{verifyError && <div className="field-err" style={{ marginTop: 10 }}>{verifyError}</div>}
					</div>
				</section>
			)}

			{/* ===== SCAN / SYNC ===== */}
			{page === "scan" && (
				<section>
					<div className="page-head">
						<h2>Sync</h2>
						<p>Vault scans the Zcash chain locally to find your incoming payments. Your viewing key never leaves this machine.</p>
					</div>

					<div className="card">
						<div className="sync-status">
							<div className={`ico ${scanInFlight || scanState === "scanning" ? "syncing" : ""}`}>
								{scanInFlight || scanState === "scanning" ? "↻" : "✓"}
							</div>
							<div className="text">
								<div className="title">
									{scanState === "scanning" ? "Scanning…"
										: scanInFlight ? "Catching up…"
										: synced ? "Up to date"
										: "Not synced yet"}
								</div>
								<div className="sub">
									{syncedTo
										? `Block #${syncedTo.toLocaleString(fiatLocale)}`
										: "No blocks scanned"}
									{transactions.length > 0 && ` · ${transactions.length} payment${transactions.length === 1 ? "" : "s"}`}
								</div>
							</div>
						</div>

						{(scanState === "scanning" || scanInFlight) && scanProgress && (
							<div className="sync-progress">
								<div className="pb"><div className="pb-fill" style={{ width: `${Math.max(displayPercent, 0.5)}%` }} /></div>
								<div className="meta">
									<span>{scanProgress.scannedHeight.toLocaleString(fiatLocale)} / {scanProgress.tipHeight.toLocaleString(fiatLocale)}</span>
									<span>{scanProgress.blocksPerSec > 0 ? `${scanProgress.blocksPerSec} blk/s · ${formatEta(scanProgress.etaSeconds)} left` : "calculating…"}</span>
								</div>
							</div>
						)}

						<div className="scan-cta">
							<button
								className="submit alt"
								onClick={() => handleScan()}
								disabled={scanState === "scanning"}
								style={{ flex: 1 }}
							>
								{scanState === "scanning" ? "Scanning…" : "Sync now"}
							</button>
						</div>
					</div>

					{scanResult && (
						<div className={`result-box ${scanState === "done" ? "ok" : "err"}`}>
							<div className="result-msg">{scanResult}</div>
						</div>
					)}

					<div className="advanced">
						<button className="advanced-toggle" onClick={() => setAdvancedScanOpen(o => !o)}>
							<span>Advanced</span>
							<span className="chev">{advancedScanOpen ? "▾" : "▸"}</span>
						</button>
						{advancedScanOpen && (
							<div className="advanced-body">
								<div className="field-grid">
									<div className="field">
										<span className="lbl">From block</span>
										<input
											type="text"
											placeholder={KEEPKEY_RELEASE_BLOCK.toLocaleString(fiatLocale)}
											value={scanFromHeight}
											onChange={e => setScanFromHeight(e.target.value.replace(/\D/g, ""))}
										/>
										<button
											className="max"
											onClick={() => setScanFromHeight(String(KEEPKEY_RELEASE_BLOCK))}
										>KK release</button>
									</div>
									<div style={{ display: "flex", gap: 10 }}>
										<button
											className="submit alt"
											onClick={() => handleScan(scanFromHeight ? parseInt(scanFromHeight, 10) : undefined)}
											disabled={!scanFromHeight || scanState === "scanning"}
											style={{ flex: 1 }}
										>Scan from block</button>
										<button
											className="submit alt"
											onClick={() => handleScan(undefined, true)}
											disabled={scanState === "scanning"}
											style={{ flex: 1 }}
										>Full rescan (~30 min)</button>
									</div>
									<p style={{ margin: 0, fontSize: 11.5, color: "var(--zk-fg-mute)", lineHeight: 1.5 }}>
										KeepKey shielded support shipped at block {KEEPKEY_RELEASE_BLOCK.toLocaleString(fiatLocale)}. Earlier blocks contain no notes for this account.
									</p>
								</div>
							</div>
						)}
					</div>
				</section>
			)}

			{/* ===== HISTORY ===== */}
			{page === "history" && (
				<section>
					<div className="page-head">
						<h2>History</h2>
						<p>Decrypted locally with your viewing key.</p>
					</div>

					<div className="history-controls">
						<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
							{[
								{ id: "all", label: "All" },
								{ id: "received", label: "Received" },
								{ id: "spent", label: "Spent" },
								{ id: "memo", label: "With memo" },
							].map(f => (
								<button key={f.id}
									className="filter-chip"
									data-active={historyFilter === f.id ? "1" : undefined}
									onClick={() => setHistoryFilter(f.id as any)}
								>{f.label}</button>
							))}
						</div>
						<button className="ghost-btn" onClick={handleBackfillMemos} disabled={backfilling}>
							{backfilling ? "Fetching…" : "Fetch memos"}
						</button>
					</div>
					{backfillResult && <div className="field-err" style={{ color: "var(--zk-green)", marginBottom: 12 }}>{backfillResult}</div>}

					<div className="card history-card">
						<table>
							<thead>
								<tr>
									<th style={{ width: 100 }}>Block</th>
									<th style={{ width: 110 }}>Type</th>
									<th>Memo</th>
									<th className="num">Amount</th>
									<th style={{ width: 110 }}>Status</th>
								</tr>
							</thead>
							<tbody>
								{loadingTxs ? (
									<tr><td colSpan={5} style={{ textAlign: "center", color: "var(--zk-fg-mute)", padding: 28 }}>Loading…</td></tr>
								) : filteredTxs.length === 0 ? (
									<tr><td colSpan={5} style={{ textAlign: "center", color: "var(--zk-fg-mute)", padding: 28 }}>No matching transactions</td></tr>
								) : filteredTxs.map(tx => (
									<tr key={tx.id}>
										<td className="block">#{tx.block_height.toLocaleString(fiatLocale)}</td>
										<td>
											<span className="tx-kind">
												<span className={`pill ${tx.is_spent ? "pill-trans" : "pill-orchard"}`}>
													{tx.is_spent ? "Sent" : "Received"}
												</span>
											</span>
										</td>
										<td>
											{tx.memo ? <span className="memo">{tx.memo}</span> : <span style={{ color: "var(--zk-fg-faint)" }}>—</span>}
										</td>
										<td className={`num ${tx.is_spent ? "amount-neg" : "amount-pos"}`}>
											{tx.is_spent ? "−" : "+"}{formatZec(tx.value)} ZEC
										</td>
										<td>
											<span className={`tx-status ${tx.is_spent ? "spent" : "received"}`}>
												{tx.is_spent ? "Sent" : "Received"}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			)}
		</div>
	)
}

/** Prominent in-form status panel shown while a Zcash tx is in flight.
 *
 *   building     — sidecar building PCZT + Halo 2 proof (~5–30s)
 *   signing      — sent to KeepKey, awaiting user approval (USER MUST LOOK AT DEVICE)
 *   broadcasting — pushing raw_tx to lightwalletd
 *
 *  Replaces the tiny "submit-hint" mid-form text the old UI used. The "signing"
 *  state is the one users actually need to act on, so it gets the loudest
 *  treatment: full-card takeover with the device illustration and an explicit
 *  "Look at your KeepKey" call. */
function TxFlowStatus({ step, awaitingButton, kind, intent }: {
	step: string | null
	/** True when the device just emitted a ButtonRequest — user must press it now.
	 *  False when the device is computing silently (proof gen / Orchard sig). */
	awaitingButton: boolean
	/** Visual accent — gold for shield, copper for unshield, blue for send */
	kind: "shield" | "unshield" | "send"
	/** Plain-English description of what the user is doing — used in the title */
	intent: string
}) {
	if (!step || step === "complete") return null
	const accent = kind === "unshield" ? "copper" : kind === "send" ? "blue" : "gold"
	const steps: Array<{ id: string; label: string }> = [
		{ id: "building",     label: "Building proof" },
		{ id: "signing",      label: "Sign on KeepKey" },
		{ id: "broadcasting", label: "Broadcasting" },
	]
	const activeIdx = steps.findIndex(s => s.id === step)
	return (
		<div className={`tx-flow tx-flow-${accent}`}>
			<div className="tx-flow-stepper">
				{steps.map((s, i) => {
					const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "pending"
					return (
						<div key={s.id} className={`tx-flow-step ${state}`}>
							<div className="tx-flow-dot">
								{state === "done" ? "✓" : state === "active" ? <span className="tx-flow-spin" /> : i + 1}
							</div>
							<div className="tx-flow-label">{s.label}</div>
						</div>
					)
				})}
			</div>

			{step === "building" && (
				<div className="tx-flow-body">
					<div className="tx-flow-headline">Building your {intent}…</div>
					<p>The Zcash sidecar is generating a Halo 2 zero-knowledge proof. This is normal cryptographic work — typically 5–30 seconds.</p>
				</div>
			)}

			{step === "signing" && awaitingButton && (
				<div className="tx-flow-body tx-flow-signing tx-flow-press">
					<div className="tx-flow-device tx-flow-device-active">
						<svg viewBox="0 0 64 96" width="56" height="84">
							<rect x="6" y="4" width="52" height="88" rx="8" fill="#1a1a1d" stroke="currentColor" strokeWidth="2"/>
							<rect x="12" y="14" width="40" height="50" rx="2" fill="#0b0b0c" stroke="currentColor" strokeWidth="1"/>
							<rect x="14" y="20" width="36" height="3" fill="currentColor" opacity="0.4"/>
							<rect x="14" y="28" width="28" height="3" fill="currentColor" opacity="0.7"/>
							<rect x="14" y="36" width="32" height="3" fill="currentColor" opacity="0.7"/>
							<circle cx="32" cy="78" r="6" fill="none" stroke="currentColor" strokeWidth="2"/>
							<circle cx="32" cy="78" r="9" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5">
								<animate attributeName="r" values="6;14;6" dur="1.2s" repeatCount="indefinite"/>
								<animate attributeName="opacity" values="0.7;0;0.7" dur="1.2s" repeatCount="indefinite"/>
							</circle>
						</svg>
					</div>
					<div className="tx-flow-headline">Press the button on your KeepKey →</div>
					<p>Confirm the {intent} on the device screen, then press the round button.</p>
				</div>
			)}

			{step === "signing" && !awaitingButton && (
				<div className="tx-flow-body tx-flow-signing">
					<div className="tx-flow-device">
						<svg viewBox="0 0 64 96" width="56" height="84">
							<rect x="6" y="4" width="52" height="88" rx="8" fill="#1a1a1d" stroke="currentColor" strokeWidth="2"/>
							<rect x="12" y="14" width="40" height="50" rx="2" fill="#0b0b0c" stroke="currentColor" strokeWidth="1"/>
							<rect x="14" y="20" width="36" height="3" fill="currentColor" opacity="0.4"/>
							<rect x="14" y="28" width="28" height="3" fill="currentColor" opacity="0.7"/>
							<rect x="14" y="36" width="32" height="3" fill="currentColor" opacity="0.7"/>
							<circle cx="32" cy="78" r="6" fill="none" stroke="currentColor" strokeWidth="1.5"/>
						</svg>
					</div>
					<div className="tx-flow-headline">Signing on device…</div>
					<p>Your KeepKey is computing the Orchard signature. <strong>This may take 60+ seconds</strong> — no input needed yet, just wait.</p>
				</div>
			)}

			{step === "broadcasting" && (
				<div className="tx-flow-body">
					<div className="tx-flow-headline">Broadcasting to the network…</div>
					<p>Almost done. Just pushing the signed transaction to a Zcash node.</p>
				</div>
			)}
		</div>
	)
}

function ResultBox({ kind, title, txid, message }: { kind: "ok" | "err"; title: string; txid?: string; message?: string }) {
	// Blockchair indexes Zcash transactions reliably; mainnet.zcashexplorer.app
	// has been hit-or-miss with newly-broadcast txs.
	const explorerUrl = txid ? `https://blockchair.com/zcash/transaction/${txid}` : null
	const [copied, setCopied] = useState(false)
	const openExplorer = useCallback(async () => {
		if (!explorerUrl) return
		try {
			// System WebView blocks target=_blank — route through Bun, which
			// shells out to the OS-native opener (open / xdg-open / cmd start).
			await rpcRequest("openExternal", { url: explorerUrl }, 5000)
		} catch (e) {
			console.error("[ResultBox] failed to open explorer:", e)
		}
	}, [explorerUrl])
	const copyTxid = useCallback(() => {
		if (!txid) return
		navigator.clipboard.writeText(txid)
		setCopied(true)
		setTimeout(() => setCopied(false), 1800)
	}, [txid])
	return (
		<div className={`result-box ${kind}`}>
			<div className="result-title">{title}</div>
			{txid && (
				<div className="result-txid">
					<span className="txid-hash">{txid}</span>
					<div className="txid-actions">
						{explorerUrl && (
							<button type="button" onClick={openExplorer}>View on explorer ↗</button>
						)}
						<button type="button" className="txid-copy" onClick={copyTxid}>
							{copied ? "✓ Copied" : "Copy txid"}
						</button>
					</div>
				</div>
			)}
			{message && <div className="result-msg">{message}</div>}
		</div>
	)
}
