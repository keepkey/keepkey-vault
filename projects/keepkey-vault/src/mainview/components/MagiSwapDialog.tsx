/**
 * Magi (VSC) swaps between HIVE, HBD and BTC, on the preflight console.
 *
 * HIVE/HBD out: two device prompts (deposit transfer, then the swap
 * custom_json). Bun holds the quote and its operations; this dialog only ever
 * sends a quoteId, and follows progress through the persisted swap records.
 * HIVE/HBD outputs land in the user's Magi balance, so the dialog checks that
 * balance afterwards and offers a withdrawal to the Hive account.
 *
 * BTC in: Magi gives a BTC deposit address (requested only when the user
 * continues, since it creates a mapping), and the BTC is sent like any other
 * payment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box } from "@chakra-ui/react"
import { useUiTranslation } from "../i18n/ui"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { CHAINS } from "../../shared/chains"
import {
	findMagiRoute, isValidBtcAddress,
	type HiveOpsCapability, type MagiAsset, type MagiQuoteView, type MagiSwapRecord,
} from "../../shared/magi-config"
import { Beam, NumberNode, PreflightList, PreflightStyles, TimelineItem, usePreflightScroll, usePreflightShort, type PreflightRow } from "./preflight/PreflightConsole"
import { AssetIcon } from "./AssetIcon"
import { SpinningDevice } from "./v3/SpinningDevice"
import { OledText } from "./v3/DeviceScreens"

type HiveAsset = "HIVE" | "HBD"
type MagiBalance = { username: string; hive: string; hbd: string }

const CHAIN_OF: Record<MagiAsset, string> = { HIVE: "hive", HBD: "hive", BTC: "bitcoin" }
const QUOTE_DEBOUNCE_MS = 600
const RECORD_POLL_MS = 2000
/** Two device prompts plus up to 90 s waiting for Magi's ledger. */
const EXECUTE_TIMEOUT_MS = 10 * 60_000

const AMOUNT_RE = /^\d+(\.\d{1,3})?$/
const isPositiveAmount = (s: string) => AMOUNT_RE.test(s.trim()) && Number(s) > 0

/** "1.500" → 1.5 for comparisons only; the RPC always receives the string. */
const num = (s: string | undefined) => (s ? Number(s) : 0)

export function MagiSwapDialog({ open, onClose, initialFrom = "HIVE", onSendBtc }: {
	open: boolean
	onClose: () => void
	initialFrom?: MagiAsset
	/** BTC in: hand the deposit address to the BTC send form. Without it the
	 *  dialog only shows the address to copy. */
	onSendBtc?: (address: string) => void
}) {
	const uiText = useUiTranslation()
	const [from, setFrom] = useState<MagiAsset>(initialFrom)
	const [to, setTo] = useState<MagiAsset>(initialFrom === "HBD" ? "HIVE" : initialFrom === "BTC" ? "HIVE" : "HBD")
	const [amount, setAmount] = useState("")
	const [btcAddress, setBtcAddress] = useState("")
	const [capability, setCapability] = useState<HiveOpsCapability | null>(null)
	const [quote, setQuote] = useState<MagiQuoteView | null>(null)
	const [quoting, setQuoting] = useState(false)
	const [quoteError, setQuoteError] = useState<string | null>(null)
	const [running, setRunning] = useState(false)
	const [record, setRecord] = useState<MagiSwapRecord | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [balance, setBalance] = useState<MagiBalance | null>(null)
	const [withdrawing, setWithdrawing] = useState(false)
	const [withdrawn, setWithdrawn] = useState<{ txid: string; amount: string; asset: HiveAsset } | null>(null)
	const [deposit, setDeposit] = useState<{ address: string; assetOut: HiveAsset } | null>(null)
	const [depositLoading, setDepositLoading] = useState(false)
	const [copied, setCopied] = useState(false)
	const quoteSeq = useRef(0)

	const route = findMagiRoute(from, to)
	const btcIn = from === "BTC"
	const needsBtcAddress = to === "BTC"
	const amountOk = isPositiveAmount(amount)
	const btcAddressOk = !needsBtcAddress || isValidBtcAddress(btcAddress)

	const refreshBalance = useCallback(() => {
		rpcRequest<MagiBalance>("magiBalance", undefined, 20000).then(setBalance).catch(() => {})
	}, [])

	// Capability (promptless probe in Bun), the Magi balance and any swap that
	// needs attention, once per open.
	useEffect(() => {
		if (!open) return
		let cancelled = false
		rpcRequest<{ capability: HiveOpsCapability }>("magiCapability", undefined, 20000)
			.then(r => { if (!cancelled) setCapability(r.capability) })
			.catch(() => { if (!cancelled) setCapability("unknown") })
		refreshBalance()
		rpcRequest<MagiSwapRecord[]>("magiRecords", undefined, 10000)
			.then(rs => { if (!cancelled) setRecord(rs.find(r => r.stage === "needs-attention") ?? null) })
			.catch(() => {})
		return () => { cancelled = true }
	}, [open, refreshBalance])

	// BTC out: prefill this KeepKey's first Bitcoin receive address (the same
	// read the asset page makes, no device display). Only once the capability
	// probe says "supported", which implies the PIN is cached, so this never
	// pops a PIN prompt. The user can still replace it.
	const [ownBtcAddress, setOwnBtcAddress] = useState<string | null>(null)
	const ownBtcRequested = useRef(false)
	useEffect(() => {
		if (!open || to !== "BTC" || capability !== "supported" || ownBtcRequested.current) return
		ownBtcRequested.current = true
		const btc = CHAINS.find(c => c.id === "bitcoin")
		if (!btc) return
		rpcRequest<{ address?: string } | string>(btc.rpcMethod, { addressNList: btc.defaultPath, showDisplay: false, coin: btc.coin, scriptType: btc.scriptType }, 60000)
			.then(r => {
				const addr = typeof r === "string" ? r : r?.address
				if (!addr || !isValidBtcAddress(addr)) return
				setOwnBtcAddress(addr)
				setBtcAddress(prev => prev || addr)
			})
			.catch(() => {})
	}, [open, to, capability])

	// Debounced quote for HIVE/HBD-out routes. A late reply for an older input is dropped.
	useEffect(() => {
		setQuote(null); setQuoteError(null)
		if (!open || btcIn || !route || !amountOk || !btcAddressOk || running) { setQuoting(false); return }
		const seq = ++quoteSeq.current
		setQuoting(true)
		const timer = setTimeout(() => {
			rpcRequest<MagiQuoteView>("magiQuote", { from: from as HiveAsset, to, amount: amount.trim(), btcAddress: needsBtcAddress ? btcAddress.trim() : undefined }, 30000)
				.then(q => { if (quoteSeq.current === seq) setQuote(q) })
				.catch(e => { if (quoteSeq.current === seq) setQuoteError(e?.message || String(e)) })
				.finally(() => { if (quoteSeq.current === seq) setQuoting(false) })
		}, QUOTE_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [open, from, to, amount, btcAddress, btcIn, route, amountOk, btcAddressOk, needsBtcAddress, running])

	const pickFrom = (a: MagiAsset) => {
		setFrom(a); setDeposit(null); setError(null)
		if (a === to) setTo(a === "HIVE" ? "HBD" : "HIVE")
		if (a === "BTC" && to === "BTC") setTo("HIVE")
	}
	const pickTo = (a: MagiAsset) => {
		setTo(a); setDeposit(null); setError(null)
		if (a === from) setFrom(a === "HIVE" ? "HBD" : "HIVE")
	}

	const execute = async () => {
		if (!quote || quote.blockReason) return
		setRunning(true); setError(null); setWithdrawn(null)
		const started = Date.now()
		// Bun saves the record at every stage; follow it while the call runs.
		const poll = setInterval(() => {
			rpcRequest<MagiSwapRecord[]>("magiRecords", undefined, 5000)
				.then(rs => { const r = rs.find(x => x.updatedAt >= started); if (r) setRecord(r) })
				.catch(() => {})
		}, RECORD_POLL_MS)
		try {
			const r = await rpcRequest<MagiSwapRecord>("magiExecute", { quoteId: quote.quoteId }, EXECUTE_TIMEOUT_MS)
			setRecord(r)
		} catch (e: any) {
			setError(e?.message || String(e))
			// The record says whether anything moved.
			rpcRequest<MagiSwapRecord[]>("magiRecords", undefined, 5000)
				.then(rs => { const r = rs.find(x => x.updatedAt >= started); if (r) setRecord(r) })
				.catch(() => {})
		} finally {
			clearInterval(poll)
			setRunning(false)
			setQuote(null)
			refreshBalance()
		}
	}

	const retry = async () => {
		if (!record) return
		setRunning(true); setError(null)
		try { setRecord(await rpcRequest<MagiSwapRecord>("magiRetry", { id: record.id }, EXECUTE_TIMEOUT_MS)) }
		catch (e: any) { setError(e?.message || String(e)) }
		finally { setRunning(false); refreshBalance() }
	}

	const withdraw = async (asset: HiveAsset) => {
		setWithdrawing(true); setError(null)
		try {
			setWithdrawn(await rpcRequest<{ txid: string; amount: string; asset: HiveAsset }>("magiWithdraw", { asset }, EXECUTE_TIMEOUT_MS))
			refreshBalance()
		} catch (e: any) { setError(e?.message || String(e)) }
		finally { setWithdrawing(false) }
	}

	const requestDepositAddress = async () => {
		if (to === "BTC") return
		setDepositLoading(true); setError(null)
		try { setDeposit(await rpcRequest<{ address: string; username: string; assetOut: HiveAsset }>("magiBtcDepositAddress", { assetOut: to }, 30000)) }
		catch (e: any) { setError(e?.message || String(e)) }
		finally { setDepositLoading(false) }
	}

	// After a HIVE/HBD-out swap the output sits in the Magi balance; re-read it a few times.
	useEffect(() => {
		if (record?.stage !== "swap-sent" || record.to === "BTC") return
		let n = 0
		const t = setInterval(() => { refreshBalance(); if (++n >= 5) clearInterval(t) }, 4000)
		return () => clearInterval(t)
	}, [record?.stage, record?.to, refreshBalance])

	// Same console as SwapDialog: the columns scroll, the decision row stays put.
	const short = usePreflightShort()
	const leftScroll = usePreflightScroll<HTMLDivElement>()
	const rightScroll = usePreflightScroll<HTMLDivElement>()

	const rows = useMemo<PreflightRow[]>(() => {
		const out: PreflightRow[] = []
		if (!route) return out
		if (route.kind === "hive-ops") {
			if (capability === "supported") out.push({ key: "fw", status: "ok", title: uiText("This KeepKey signs Hive operations") })
			else if (capability === "unsupported") out.push({ key: "fw", status: "block", tag: uiText("blocks"), title: uiText("Firmware can't sign the swap step"), detail: uiText("Needs KeepKey firmware with Hive operation signing (HiveSignOperations). This firmware only signs plain Hive transfers.") })
			else if (capability === "unknown") out.push({ key: "fw", status: "block", tag: uiText("blocks"), title: uiText("Unlock your KeepKey"), detail: uiText("Unlock your KeepKey so Desktop can check whether its firmware signs Hive operations.") })
			out.push({ key: "two", status: "warn", title: uiText("Two confirmations on the KeepKey"), detail: uiText("First the deposit to Magi, then the swap. If the second one doesn't go through, the deposit stays in your Magi balance and you can retry or withdraw it.") })
			if (quote?.blockReason) out.push({ key: "quote", status: "block", tag: uiText("blocks"), title: uiText("Can't swap this amount yet"), detail: quote.blockReason })
			if (quote?.simDeferred) out.push({ key: "sim", status: "warn", title: uiText("Swap checked after the deposit"), detail: uiText("Magi can only simulate the swap once the deposit is in your Magi balance. If it fails then, nothing is lost: the deposit stays there.") })
			if (needsBtcAddress && btcAddress && !btcAddressOk) out.push({ key: "addr", status: "block", tag: uiText("blocks"), title: uiText("Not a Bitcoin address"), detail: uiText("Paste a mainnet Bitcoin address (bc1…, 1… or 3…).") })
		} else {
			out.push({ key: "mkt", status: "warn", title: uiText("Market price after confirmations"), detail: uiText("Magi converts at the market price after the Bitcoin confirmations. Send a small amount first.") })
			// TODO(magi): minimum deposit and confirmation count, from the Magi team.
			out.push({ key: "map", status: "ok", title: uiText("No Hive signature needed"), detail: uiText("You send BTC to an address Magi links to your Hive account.") })
		}
		// The fee shown is the one in the quote: Bun leaves the referral off while
		// the beneficiary's Hive account does not exist, even on BTC outputs.
		if (route.kind === "btc-deposit") out.push({ key: "fee", status: "ok", title: uiText("No referral fee on this route") })
		else if (quote) out.push({ key: "fee", status: "ok", title: quote.referralBps > 0
			? uiText("{{pct}}% referral fee, included in the quote", { pct: (quote.referralBps / 100).toString() })
			: uiText("No referral fee on this route") })
		return out
	}, [route, capability, quote, needsBtcAddress, btcAddress, btcAddressOk, to, uiText])

	if (!open) return null

	const signing = record?.stage === "signing-deposit" || record?.stage === "signing-swap"
	const stepOf = (stage?: MagiSwapRecord["stage"]) => stage === "signing-swap" || stage === "swap-sent" ? 2 : 1
	const blocked = rows.some(r => r.status === "block")
	const canSwap = !!quote && !blocked && !quoting && !running && amountOk && btcAddressOk
	const attention = record?.stage === "needs-attention" ? record : null
	const done = record?.stage === "swap-sent" ? record : null
	const hasBalance = !!balance && (num(balance.hive) > 0 || num(balance.hbd) > 0)

	const goLabel = running ? uiText("Confirm on your KeepKey…")
		: quoting ? uiText("Getting a quote…")
		: !amountOk ? uiText("Enter an amount")
		: needsBtcAddress && !btcAddressOk ? uiText("Enter a Bitcoin address")
		: blocked ? uiText("Can't swap yet")
		: uiText("Swap on KeepKey")

	// The pair as SwapDialog shows it: official logo (no disc), figure, network.
	const side = (asset: MagiAsset, figure: string) => {
		const chain = CHAINS.find(c => c.id === CHAIN_OF[asset])
		return <div>
			<AssetIcon caip={chain?.caip} size={28} alt={asset} bare />
			<b>{figure ? `${figure} ` : ""}{asset}</b>
			<small>{chain?.coin}</small>
		</div>
	}

	const assetButtons = (value: MagiAsset, pick: (a: MagiAsset) => void, label: string) => (
		<div className="kk-pf-modes" role="radiogroup" aria-label={label}>
			{(["HIVE", "HBD", "BTC"] as const).map(a => (
				<button key={a} type="button" role="radio" aria-checked={value === a} aria-selected={value === a} onClick={() => pick(a)} disabled={running}>{a}</button>
			))}
		</div>
	)

	return (
		<Box data-magi-swap position="fixed" inset="0" zIndex={Z.overlay + 1} bg="rgba(0,0,0,0.85)" backdropFilter="blur(8px)"
			display="flex" alignItems="center" justifyContent="center"
			onClick={e => { if (e.target === e.currentTarget && !running) onClose() }}>
			<PreflightStyles />
			<div className="kk-pf kk-pf-sg" role="dialog" aria-modal="true" aria-label={uiText("Swap with Magi")} style={{ width: "min(1000px, 95vw)", maxHeight: "92vh" }}>
				<div className="kk-pf-left kk-pf-split">
					<div className="kk-pf-body kk-pf-scroll" ref={leftScroll}>
					<div className="kk-pf-top">
						<div className="kk-pf-kicker">{uiText("Swap · Magi")}</div>
					</div>
					<div className="kk-pf-amt">
						{side(from, btcIn ? "" : amount || "0")}
						<Beam />
						{side(to, btcIn ? "" : quote?.expectedOut ?? "—")}
					</div>
					{/* While the KeepKey asks, it sits here, large and still, as in every signing screen. */}
					{(signing || running) && (
						<div style={{ display: "grid", gap: 10, justifyItems: "start" }}>
							<SpinningDevice motion="still" scale={short ? 0.8 : 1} label={uiText("KeepKey")}
								screen={<OledText kicker={uiText("STEP {{n}} OF 2", { n: stepOf(record?.stage) })}
									headline={stepOf(record?.stage) === 1 ? `${record?.amountIn ?? amount} ${record?.from ?? from}` : uiText("Swap")}
									sub={stepOf(record?.stage) === 1 ? "vsc.gateway" : "vsc.call"} />} />
							<span className="kk-pf-cap" style={{ maxWidth: "none" }}>{record?.stage === "deposit-sent" ? uiText("Waiting for Magi to credit the deposit…") : uiText("Check the details on your KeepKey, then confirm.")}</span>
						</div>
					)}

					<dl className="kk-pf-facts">
						<div><dt>{uiText("From")}</dt><dd>{assetButtons(from, pickFrom, uiText("From"))}</dd></div>
						<div><dt>{uiText("To")}</dt><dd>{assetButtons(to, pickTo, uiText("To"))}</dd></div>
					</dl>

					{!btcIn && (
						<label className="kk-pf-detail" style={{ display: "grid", gap: 6 }}>
							<span>{uiText("Amount ({{asset}})", { asset: from })}</span>
							<input className="kk-pf-field" inputMode="decimal" value={amount} disabled={running} placeholder="0.000"
								onChange={e => setAmount(e.target.value.replace(",", "."))} />
						</label>
					)}
					{needsBtcAddress && !btcIn && (
						<label className="kk-pf-detail" style={{ display: "grid", gap: 6 }}>
							<span>{uiText("Bitcoin address to receive")}</span>
							<input className="kk-pf-field kk-pf-sm" value={btcAddress} disabled={running} spellCheck={false}
								onChange={e => setBtcAddress(e.target.value.trim())} />
							{ownBtcAddress && btcAddress === ownBtcAddress && <span className="kk-pf-dim">{uiText("This KeepKey's first Bitcoin address. You can paste another.")}</span>}
						</label>
					)}

					{!btcIn && quote && (
						<dl className="kk-pf-facts" aria-live="polite">
							<div><dt>{uiText("You receive about")}</dt><dd>{quote.expectedOut} {to}</dd></div>
							<div><dt>{uiText("At least")}</dt><dd>{quote.minOut} {to}</dd></div>
							<div><dt>{uiText("Route")}</dt><dd>{quote.hops === 2 ? uiText("2 pools on Magi") : uiText("1 pool on Magi")}</dd></div>
							<div><dt>{uiText("Hive account")}</dt><dd>@{quote.username}</dd></div>
						</dl>
					)}
					{quoteError && <p className="kk-pf-detail" role="alert" style={{ color: "var(--rose)" }}>{quoteError}</p>}

					{btcIn && deposit && (
						<dl className="kk-pf-kv">
							<div>
								<dt>{uiText("Send BTC to this Magi deposit address")}</dt>
								<dd title={deposit.address}>{deposit.address}</dd>
								<button type="button" className="kk-pf-copy" onClick={() => { navigator.clipboard.writeText(deposit.address); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
									{copied ? uiText("Copied") : uiText("Copy")}
								</button>
							</div>
						</dl>
					)}

					{error && <p className="kk-pf-detail" role="alert" style={{ color: "var(--rose)" }}>{error}</p>}
					</div>

					{/* ── Decision: pinned, outside the scroll ── */}
					<div className="kk-pf-foot">
					{btcIn ? (
						<div className="kk-pf-actions kk-pf-wrap">
							{!deposit ? (
								<button type="button" className="kk-pf-go" onClick={requestDepositAddress} disabled={depositLoading || to === "BTC"}>
									{depositLoading && <span className="kk-pf-spin" aria-hidden="true" />}{depositLoading ? uiText("Getting the address…") : uiText("Continue")}
								</button>
							) : onSendBtc ? (
								<button type="button" className="kk-pf-go" onClick={() => onSendBtc(deposit.address)}>{uiText("Send BTC from this KeepKey")}</button>
							) : null}
							<button type="button" className="kk-pf-cancel" onClick={onClose}>{uiText("Close")}</button>
						</div>
					) : (
						<div className="kk-pf-actions">
							<button type="button" className="kk-pf-cancel" onClick={onClose} disabled={running}>{uiText("Close")}</button>
							<button type="button" className="kk-pf-go" onClick={execute} disabled={!canSwap} aria-disabled={!canSwap} aria-busy={running || quoting || undefined}>
								{(running || quoting) && <span className="kk-pf-spin" aria-hidden="true" />}{goLabel}
							</button>
						</div>
					)}
					</div>
				</div>

				<div className="kk-pf-right kk-pf-scroll" ref={rightScroll}>
					{(attention || hasBalance) && (
						<div data-magi-balance>
							<h3 className="kk-pf-h">{attention ? uiText("Your {{asset}} is in your Magi balance", { asset: attention.from }) : uiText("Magi balance")}</h3>
							{attention?.attention && <p className="kk-pf-detail">{attention.attention}</p>}
							{balance && (
								<dl className="kk-pf-facts" style={{ marginTop: 8 }}>
									<div><dt>HIVE</dt><dd>{balance.hive}</dd></div>
									<div><dt>HBD</dt><dd>{balance.hbd}</dd></div>
								</dl>
							)}
							<div className="kk-pf-actions kk-pf-wrap" style={{ marginTop: 10 }}>
								{attention && <button type="button" className="kk-pf-outline" onClick={retry} disabled={running || withdrawing || capability !== "supported"}>{uiText("Try the swap again")}</button>}
								{balance && num(balance.hive) > 0 && <button type="button" className="kk-pf-outline" onClick={() => withdraw("HIVE")} disabled={running || withdrawing || capability !== "supported"}>{uiText("Withdraw {{amount}} HIVE to your Hive account", { amount: balance.hive })}</button>}
								{balance && num(balance.hbd) > 0 && <button type="button" className="kk-pf-outline" onClick={() => withdraw("HBD")} disabled={running || withdrawing || capability !== "supported"}>{uiText("Withdraw {{amount}} HBD to your Hive account", { amount: balance.hbd })}</button>}
							</div>
							{withdrawn && <p className="kk-pf-detail">{uiText("Withdrawal of {{amount}} {{asset}} sent. It reaches your Hive account in about 30 seconds.", { amount: withdrawn.amount, asset: withdrawn.asset })}</p>}
						</div>
					)}

					{done && (
						<div data-magi-done>
							<h3 className="kk-pf-h">{uiText("Swap sent")}</h3>
							<p className="kk-pf-detail">
								{done.to === "BTC"
									? uiText("Magi sends at least {{min}} BTC to {{to}}.", { min: done.minOut, to: done.recipient })
									: uiText("At least {{min}} {{asset}} lands in your Magi balance. Withdraw it to your Hive account when you like.", { min: done.minOut, asset: done.to })}
							</p>
						</div>
					)}

					{route?.kind === "hive-ops" && (
						<div className="kk-pf-tl">
							{/* The gold node is the step the KeepKey is on (the first, before signing). */}
							<TimelineItem node={<NumberNode n={1} gold={stepOf(record?.stage) === 1} />} title={uiText("Deposit {{asset}} to Magi", { asset: from })}>{uiText("A Hive transfer to vsc.gateway, signed on the KeepKey.")}</TimelineItem>
							<TimelineItem node={<NumberNode n={2} gold={(signing || running) && stepOf(record?.stage) === 2} />} title={uiText("Swap on Magi")}>{uiText("A Magi call signed with your active key. Magi then executes the swap.")}</TimelineItem>
						</div>
					)}
					{!(signing || running) && <PreflightList rows={rows} label={uiText("Checks")} />}
				</div>
			</div>
		</Box>
	)
}

