/** The Monero-specific parts of the standard asset page (AssetPage): balance header and chip, the
 *  view-key connect step, Receive (with device-verified subaddresses) and Send (key-image sync,
 *  review, unknown-broadcast recovery). Every amount that is not known renders as "—". */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Button, Flex, Image, Input, Spinner, Text } from "@chakra-ui/react"
import { FaCheck, FaMinus, FaPaperPlane, FaPlus } from "react-icons/fa"
import { useUiTranslation } from "../i18n/ui"
import type { ChainDef } from "../../shared/chains"
import type { MoneroSendReview } from "../../shared/types"
import { formatXmr, formatXmrShort, moneroBalanceView, moneroSendInputProblems, type MoneroBalanceView, type MoneroSendProblem } from "../../shared/monero-asset"
import { getNumberLocale } from "../lib/number-locale"
import type { MoneroClient } from "../lib/monero-client"
import { openMoneroWallet, prepareMoneroSend, verifyMoneroBalance } from "../lib/monero-flow"
import { useMoneroStatus, type MoneroStatusState } from "../hooks/useMoneroStatus"
import { useMoneroBalanceVerification } from "../hooks/useMoneroBalanceVerification"
import { ReceiveView } from "./ReceiveView"

const MONERO_PATH = [0x8000002c, 0x80000080, 0x80000000]
const MAX_SUBADDRESS = 199
const cardProps = { border: "1px solid var(--line)", borderRadius: "12px", bg: "var(--ink-0)", px: "3.5", py: "3" } as const

const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback

export function useMoneroView(monero: MoneroStatusState): MoneroBalanceView {
	return useMemo(() => moneroBalanceView(monero.status, monero.refreshError), [monero.status, monero.refreshError])
}

/** Short state label, shared by the Dashboard row and the page header. */
export function useMoneroStateLabel(view: MoneroBalanceView): string {
	const uiText = useUiTranslation()
	if (view.state === "loading") return uiText("Loading…")
	if (view.state === "not-connected") return uiText("Not connected")
	if (view.state === "ready") return !view.spendVerified && view.balanceAtomic !== "0" ? uiText("Balance needs verification") : uiText("Synced")
	if (view.state === "unreachable") return uiText("Node unreachable")
	return view.progress === undefined ? uiText("Syncing") : uiText("Syncing {{percent}}%", { percent: Math.floor(view.progress * 100) })
}

export function MoneroStatusChip({ view }: { view: MoneroBalanceView }) {
	const label = useMoneroStateLabel(view)
	const verified = view.state === "ready" && (view.spendVerified || view.balanceAtomic === "0")
	const color = verified ? "var(--teal)" : view.state === "unreachable" ? "var(--rose)" : "var(--gold)"
	return (
		<Flex data-monero-state={view.state} align="center" gap="1" color={color} className="v3-glass-chip" px="2" py="0.5">
			{verified ? <Box as={FaCheck} fontSize="9px" /> : <Box w="6px" h="6px" borderRadius="full" bg={color} />}
			<Text fontSize="10px" fontFamily="mono" fontWeight="500" letterSpacing="0.02em">{label}</Text>
		</Flex>
	)
}

/** "Last updated <time>" whenever a shown figure is not fresh (the unreachable note already says it). */
function MoneroFreshness({ view }: { view: MoneroBalanceView }) {
	const uiText = useUiTranslation()
	if (!view.stale || view.state === "unreachable") return null
	return <Text data-monero-stale="" fontSize="11px" color="var(--gold)">{uiText("Last updated {{time}}", { time: view.updatedAt ? new Date(view.updatedAt).toLocaleString(getNumberLocale()) : "—" })}</Text>
}

/** Header amount: "—" when unknown; fiat is never shown (no price source), it says "not included". */
export function MoneroHeaderBalance({ view, privateMode }: { view: MoneroBalanceView; privateMode: boolean }) {
	const uiText = useUiTranslation()
	const balance = view.spendVerified || view.balanceAtomic === "0" ? view.balanceAtomic : null
	return (
		<Flex direction="column" align="flex-end" gap="0.5">
			<Flex align="baseline" gap="1.5">
				<Text data-monero-header-balance="" fontFamily="mono" fontSize={{ base: "20px", md: "26px" }} fontWeight="600" color="var(--text-0)" lineHeight="1.05">
					{balance === null ? "—" : privateMode ? "••••••" : formatXmrShort(balance)}
				</Text>
				<Text fontFamily="mono" fontSize={{ base: "12px", md: "14px" }} color="var(--text-3)">XMR</Text>
			</Flex>
			<Text fontSize="10px" color="var(--text-3)" title={uiText("XMR has no price source here, so it is not included in the portfolio total.")}>{uiText("Fiat value not included")}</Text>
			<MoneroFreshness view={view} />
		</Flex>
	)
}

/** One line under the balance that says what it means right now. */
function MoneroBalanceNote({ view }: { view: MoneroBalanceView }) {
	const uiText = useUiTranslation()
	if (view.state === "scanning") {
		return <Text data-monero-note="scanning" fontSize="12px" color="var(--text-2)">{uiText("Syncing your Monero wallet. Your balance appears when it is ready.")}</Text>
	}
	if (view.state === "unreachable") {
		return <Text data-monero-note="unreachable" role="alert" fontSize="12px" color="var(--gold)">{view.balanceAtomic === null
			? uiText("The Monero node can't be reached, and no balance has been read yet.")
			: uiText("The Monero node can't be reached. Showing the last known balance, from {{time}}.", { time: view.updatedAt ? new Date(view.updatedAt).toLocaleString(getNumberLocale()) : "—" })}</Text>
	}
	if (view.state === "ready" && (view.restoreHeight ?? 0) > 0) {
		return <Text data-monero-note="partial" fontSize="12px" color="var(--text-2)">{uiText("Earlier payments may be missing. Check the wallet history start in Settings → Monero if this wallet is older.")}</Text>
	}
	if (view.state === "ready" && !view.spendVerified && view.balanceAtomic !== "0") {
		return <Text data-monero-note="unverified" fontSize="12px" color="var(--text-2)">{uiText("Confirm on KeepKey to verify your balance.")}</Text>
	}
	return null
}

function MoneroAmounts({ view, privateMode }: { view: MoneroBalanceView; privateMode: boolean }) {
	const uiText = useUiTranslation()
	const show = (atomic: string | null) => atomic === null ? "—" : privateMode ? "••••••" : `${formatXmr(atomic)} XMR`
	return (
		<Flex gap={{ base: "5", md: "10" }} flexWrap="wrap">
			<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Received")}</Text><Text data-monero-balance="" fontSize="13px" fontFamily="mono" color="var(--text-0)">{show(view.balanceAtomic)}</Text></Box>
			<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Unlocked")}</Text><Text data-monero-unlocked="" fontSize="13px" fontFamily="mono" color="var(--teal)">{show(view.spendVerified || view.balanceAtomic === "0" ? view.unlockedAtomic : null)}</Text></Box>
			<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Locked (fewer than 10 confirmations)")}</Text><Text data-monero-locked="" fontSize="13px" fontFamily="mono" color="var(--text-1)">{show(view.spendVerified || view.balanceAtomic === "0" ? view.lockedAtomic : null)}</Text></Box>
		</Flex>
	)
}

/** Opening XMR starts the normal device consent. A failed/cancelled attempt waits for Retry. */
export function MoneroConnectCard({ client, monero }: { client: MoneroClient; monero: MoneroStatusState }) {
	const uiText = useUiTranslation()
	const [settings, setSettings] = useState<{ moneroDaemonUrl: string; moneroRestoreHeight: number } | null>(null)
	const [connecting, setConnecting] = useState(false)
	const [nodeWaiting, setNodeWaiting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const attempted = useRef(false)
	const mounted = useRef(true)
	const connect = useCallback(async () => {
		setConnecting(true); setError(null)
		try {
			const next = await client.getSettings()
			if (!mounted.current) return
			setSettings(next)
			if (next.moneroNodeMode === 'local' && client.getNodeStatus) {
				const node = await client.getNodeStatus()
				if (!mounted.current) return
				if (node.state !== 'ready') { setNodeWaiting(true); return }
			}
			setNodeWaiting(false)
			const status = await openMoneroWallet(client, next.moneroRestoreHeight ?? 0)
			if (mounted.current) monero.setStatus(status)
		} catch (e) { if (mounted.current) setError(errorText(e, "Unable to open Monero. Try again.")) }
		finally { if (mounted.current) setConnecting(false) }
	}, [client, monero.setStatus])
	useEffect(() => {
		mounted.current = true
		if (monero.status && !attempted.current) { attempted.current = true; void connect() }
		return () => { mounted.current = false }
	}, [!!monero.status, connect])
	useEffect(() => {
		if (!nodeWaiting) return
		const timer = setInterval(() => { if (!connecting) void connect() }, 5000)
		return () => clearInterval(timer)
	}, [nodeWaiting, connecting, connect])
	useEffect(() => {
		const changed = () => { if (!connecting) void connect() }
		window.addEventListener('keepkey-settings-changed', changed)
		return () => window.removeEventListener('keepkey-settings-changed', changed)
	}, [connect, connecting])
	return (
		<Box data-monero-connect="" py="4" maxW="520px">
			<Flex align="center" gap="2" mb="2" role="status">
				{!error && <Spinner size="sm" />}
				<Text fontSize="15px" color="var(--text-0)" fontWeight="500">{error ? uiText("Monero couldn't open") : nodeWaiting ? uiText('Waiting for your node') : uiText("Confirm on KeepKey")}</Text>
			</Flex>
			<Text fontSize="13px" color="var(--text-2)">{nodeWaiting ? uiText('Your wallet will connect when your node is fully synced. You can follow its progress above.') : uiText("Approve access on your KeepKey to see your Monero balance and receive payments.")}</Text>
			{error && <><Text role="alert" color="var(--rose)" fontSize="13px" mt="3">{error}</Text><Button data-monero-connect-button="" mt="3" size="sm" disabled={connecting} onClick={() => { void connect() }}>{uiText("Try again")}</Button></>}
			<details data-monero-connection-details="" style={{ marginTop: 20, color: "var(--text-3)", fontSize: 12 }}>
				<summary style={{ cursor: "pointer" }}>{uiText("Connection details")}</summary>
				<Text mt="2">{uiText("KeepKey shares a view key with the local wallet to find incoming payments. Spending still requires confirmation on KeepKey.")}</Text>
				<Text mt="2" wordBreak="break-all">{uiText("Node")}: {settings?.moneroDaemonUrl ?? "—"}</Text>
				<Text>{uiText("Scan start block")}: {settings?.moneroRestoreHeight ?? "—"}</Text>
				<Text mt="2">{uiText("The full history is scanned unless you have chosen a later start. Change the node or wallet history in Settings → Monero.")}</Text>
			</details>
		</Box>
	)
}

export function MoneroReceiveSection({ chain, monero, client, privateMode }: { chain: ChainDef; monero: MoneroStatusState; client: MoneroClient; privateMode: boolean }) {
	const uiText = useUiTranslation()
	const view = useMoneroView(monero)
	const verification = useMoneroBalanceVerification(monero, client)
	const wallet = monero.status?.available ? monero.status : null
	const [minor, setMinor] = useState(0)
	const [subaddress, setSubaddress] = useState<{ minor: number; address: string } | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [verified, setVerified] = useState<string | null>(null)
	const primary = wallet?.address ?? ""
	const address = minor === 0 ? primary : subaddress?.minor === minor ? subaddress.address : null
	const loadSubaddress = useCallback(async (index: number) => {
		if (index === 0) return
		setLoading(true); setError(null)
		try {
			const result = await client.getAddress(index, false)
			if (result.minor !== index) throw new Error("The KeepKey returned a different subaddress.")
			setSubaddress({ minor: index, address: result.address })
		} catch (e) { setError(errorText(e, "Unable to read the subaddress from KeepKey.")) }
		finally { setLoading(false) }
	}, [client])
	useEffect(() => { setVerified(null); setError(null); if (minor > 0 && wallet) void loadSubaddress(minor) }, [minor, primary]) // eslint-disable-line react-hooks/exhaustive-deps
	if (!wallet) return <MoneroConnectCard client={client} monero={monero} />
	const showOnDevice = async () => {
		setError(null); setVerified(null)
		try {
			const result = await client.getAddress(minor, true)
			if (result.address !== address || result.displayed !== true) throw new Error("KeepKey showed a different address; do not use this one.")
			setVerified(result.address)
		} catch (e) { setError(errorText(e, "Unable to show the address on KeepKey.")) }
	}
	return (
		<Box data-monero-receive="">
			{verification.busy && <Text role="status" fontSize="12px" mb="3">{uiText("Checking your balance on KeepKey…")}</Text>}
			{verification.error && <Box role="alert" mb="3"><Text fontSize="12px" color="var(--rose)">{verification.error}</Text><Button size="xs" mt="2" onClick={() => { void verification.retry() }}>{uiText("Try again")}</Button></Box>}
			<Box mb="4"><MoneroBalanceNote view={view} /><MoneroFreshness view={view} /></Box>
			<details style={{ marginBottom: 16, color: "var(--text-3)", fontSize: 12 }}><summary style={{ cursor: "pointer" }}>{uiText("Balance details")}</summary><Box mt="3"><MoneroAmounts view={view} privateMode={privateMode} /></Box></details>
			<details style={{ marginBottom: 12, color: "var(--text-3)", fontSize: 12 }}><summary style={{ cursor: "pointer" }}>{uiText("Receive address options")}</summary>
			<Flex align="center" gap="2" mt="2" flexWrap="wrap">
				<Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em">{uiText("Receive to")}</Text>
				<Button aria-label={uiText("Previous subaddress")} size="xs" variant="ghost" disabled={minor === 0} onClick={() => setMinor(m => Math.max(0, m - 1))}><FaMinus /></Button>
				<Text data-monero-subaddress="" fontSize="12px" fontFamily="mono" color="var(--gold)">{minor === 0 ? uiText("Main address") : uiText("Subaddress #{{index}}", { index: minor })}</Text>
				<Button aria-label={uiText("Next subaddress")} size="xs" variant="ghost" disabled={minor >= MAX_SUBADDRESS} onClick={() => setMinor(m => Math.min(MAX_SUBADDRESS, m + 1))}><FaPlus /></Button>
			</Flex><Text mt="2" fontFamily="mono" fontSize="11px">m/44'/128'/0' · {chain.caip}</Text></details>
			<ReceiveView chain={chain} address={address} loading={loading} error={error} currentPath={MONERO_PATH} pathEditable={false} showDetails={false}
				onDerive={() => { void loadSubaddress(minor) }} onShowOnDevice={showOnDevice} />
			{wallet.emulatorReady === false && <Text mt="2" fontSize="12px" color="var(--text-2)">{uiText("Start the emulator to verify this address.")}</Text>}
			{verified && verified === address && <Text mt="2" fontSize="12px" color="var(--teal)" role="status">{uiText("Address confirmed on KeepKey.")}</Text>}
			{address && error && <Text mt="2" fontSize="12px" color="var(--rose)" role="alert">{error}</Text>}
			{minor > 0 && <Text mt="2" fontSize="11px" color="var(--text-3)">{uiText("Subaddresses belong to this wallet. Sending XMR to one of them is how you move funds within it.")}</Text>}
			<Box mt="6">
				<Text fontSize="11px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em" mb="2">{uiText("Incoming transactions")}</Text>
				{wallet.transactions.length === 0 ? (
					<Text fontSize="12px" color="var(--text-2)">{view.state === "ready" ? uiText("No incoming transactions yet.") : uiText("Transactions appear as the wallet scans.")}</Text>
				) : wallet.transactions.map((tx, index) => (
					<Flex key={`${tx.txid}:${index}`} justify="space-between" gap="4" py="2" borderTop={index ? "1px solid var(--line)" : undefined} flexWrap="wrap">
						<Box minW="0">
							<Text fontSize="12px" color="var(--text-0)">{tx.type === "pool" ? uiText("Incoming · in the mempool") : uiText("Received")}</Text>
							<Text fontSize="11px" fontFamily="mono" color="var(--text-3)" title={tx.txid}>{tx.txid.slice(0, 12)}…{tx.txid.slice(-12)}</Text>
							<Text fontSize="11px" color="var(--text-2)">{uiText("{{count}} confirmations", { count: tx.confirmations })} · {tx.locked ? uiText("Locked") : uiText("Unlocked")}</Text>
						</Box>
						<Text fontSize="12px" fontFamily="mono" color="var(--teal)">{privateMode ? "••••••" : `+${formatXmr(tx.amountAtomic)} XMR`}</Text>
					</Flex>
				))}
			</Box>
		</Box>
	)
}

function useProblemText() {
	const uiText = useUiTranslation()
	return (problem: MoneroSendProblem | undefined, unlockedAtomic: string | null) => {
		if (problem === "integrated") return uiText("Integrated addresses are not supported by this preview. Ask for a standard address or subaddress.")
		if (problem === "invalid-address") return uiText("Enter a valid Monero mainnet address.")
		if (problem === "own-address") return uiText("This is this wallet's own main address. To move XMR within this wallet, send to one of its subaddresses (Receive tab).")
		if (problem === "invalid-amount") return uiText("Enter a positive XMR amount with at most 12 decimals.")
		if (problem === "more-than-unlocked") return uiText("This is more than your unlocked balance ({{amount}} XMR).", { amount: unlockedAtomic ? formatXmr(unlockedAtomic) : "—" })
		return null
	}
}

export function MoneroSendSection({ monero, client, privateMode = false }: { monero: MoneroStatusState; client: MoneroClient; privateMode?: boolean }) {
	const uiText = useUiTranslation()
	const problemText = useProblemText()
	const view = useMoneroView(monero)
	const verification = useMoneroBalanceVerification(monero, client)
	const wallet = monero.status?.available ? monero.status : null
	const [recipient, setRecipient] = useState("")
	const [amount, setAmount] = useState("")
	const [max, setMax] = useState(false)
	const [review, setReview] = useState<MoneroSendReview | null>(null)
	const [busy, setBusy] = useState<"sync" | "prepare" | "confirm" | "retry" | "discard" | null>(null)
	const [confirmDiscard, setConfirmDiscard] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [sentTxid, setSentTxid] = useState<string | null>(null)
	const address = wallet?.address ?? ""
	useEffect(() => { setReview(null); setError(null); setSentTxid(null) }, [address])
	if (!wallet) return <MoneroConnectCard client={client} monero={monero} />
	const problems = moneroSendInputProblems({ address: recipient, amount, max, walletAddress: address, unlockedAtomic: view.spendVerified ? view.unlockedAtomic : null })
	const ready = !!recipient.trim() && !problems.address && (max || (!!problems.amountAtomic && !problems.amount))
	const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
		if (busy) return
		setBusy(kind); setError(null)
		try { await action() } catch (e) { setError(errorText(e, "The Monero request failed.")) } finally { setBusy(null) }
	}
	const sync = () => run("sync", async () => { monero.setStatus(await verifyMoneroBalance(client)) })
	const prepare = () => run("prepare", async () => {
		setSentTxid(null)
		const next = await prepareMoneroSend(client, wallet, { address: recipient.trim(), ...(max ? { max: true } : { amountAtomic: problems.amountAtomic! }) }, status => monero.setStatus(status), () => setBusy("sync"))
		setBusy("prepare")
		if (next.recipient !== recipient.trim() || (!max && next.amountAtomic !== problems.amountAtomic) || !/^[0-9a-f]{32}$/.test(next.prepareId)) throw new Error("The prepared transaction does not match your request.")
		setReview(next)
	})
	const confirm = () => run("confirm", async () => {
		const pendingReview = review!
		try {
			const result = await client.send(pendingReview.prepareId)
			if (!/^[0-9a-f]{64}$/.test(result?.txid ?? "")) throw new Error("The wallet returned an invalid transaction ID.")
			setSentTxid(result.txid); setRecipient(""); setAmount(""); setMax(false)
		} finally { setReview(null); void monero.refresh() }
	})
	const retry = () => run("retry", async () => {
		try { const result = await client.retryRelay(); if (/^[0-9a-f]{64}$/.test(result?.txid ?? "")) setSentTxid(result.txid) }
		finally { void monero.refresh() }
	})
	const discard = () => run("discard", async () => {
		try {
			const result = await client.discardPending()
			setNotice(result.outcome === "sent" ? uiText("The node has this transaction, so it was sent; nothing was discarded.")
				: result.outcome === "superseded" ? uiText("Its inputs were spent by a different transaction, so it can never be sent. It was cleared.")
				: uiText("Discarded. Its funds are spendable again; the next send builds a new transaction."))
		} finally { setConfirmDiscard(false); void monero.refresh() }
	})
	const receiveOnly = wallet.sendBlocked === "emulator" || wallet.sendBlocked === "adapter"
	return (
		<Box data-monero-send="">
			{verification.busy && <Text role="status" fontSize="12px" mb="3">{uiText("Checking your balance on KeepKey…")}</Text>}
			{verification.error && <Box role="alert" mb="3"><Text fontSize="12px" color="var(--rose)">{verification.error}</Text><Button size="xs" mt="2" onClick={() => { void verification.retry() }}>{uiText("Try again")}</Button></Box>}
			{wallet.unrelayedTxid && (
				<Box role="alert" mb="4" {...cardProps} borderColor="var(--gold)">
					<Text fontSize="13px" color="var(--gold)">{uiText("Your last send is still being checked. New sends are paused. Checking again resends the same transaction and cannot pay twice.")}</Text>

					<Button data-monero-retry-relay="" mt="2" size="xs" variant="outline" onClick={() => { void retry() }} disabled={!!busy} className="electrobun-webkit-app-region-no-drag">{busy === "retry" ? <Spinner size="xs" /> : null}{uiText("Check again")}</Button>
					<details style={{ marginTop: 12, fontSize: 12, color: "var(--text-3)" }}><summary style={{ cursor: "pointer" }}>{uiText("Recovery details")}</summary>
					<Text data-monero-unrelayed="" fontSize="11px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all" userSelect="all" mt="1">{wallet.unrelayedTxid}</Text>
					{wallet.unrelayedCheck?.state === "unknown" && (
						<Text data-monero-unrelayed-check="" mt="2" fontSize="11px" color="var(--text-2)">{wallet.unrelayedCheck.discardable
							? uiText("The node checked at {{time}}: it does not have this transaction, and its inputs are still unspent.", { time: new Date(wallet.unrelayedCheck.checkedAt).toLocaleTimeString(getNumberLocale()) })
							: uiText("The node does not have this transaction, but its inputs are spent in the node's pool by another one. Wait for that to settle.")}</Text>
					)}
					{wallet.unrelayedCheck?.state === "unknown" && wallet.unrelayedCheck.relayNode !== wallet.unrelayedCheck.checkedNode && (
						<Text data-monero-other-node="" mt="1" fontSize="11px" color="var(--gold)">{wallet.unrelayedCheck.relayNode
							? uiText("It was sent to {{relay}}, but {{checked}} answered this check. A node that never received it cannot tell whether it is waiting elsewhere.", { relay: wallet.unrelayedCheck.relayNode, checked: wallet.unrelayedCheck.checkedNode })
							: uiText("The node it was sent to was not recorded, so {{checked}} may never have received it.", { checked: wallet.unrelayedCheck.checkedNode })}</Text>
					)}
					{wallet.unrelayedCheck?.discardable && !confirmDiscard && (
						<Button data-monero-discard="" mt="2" ml="2" size="xs" variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={!!busy} className="electrobun-webkit-app-region-no-drag">{uiText("Discard this transaction…")}</Button>
					)}
					{confirmDiscard && (
						<Box data-monero-discard-confirm="" mt="2" role="alertdialog">
							<Text fontSize="12px" color="var(--rose)">{uiText("Discard only if you are sure it was never broadcast. The node is asked again first; if it has the transaction, nothing is discarded. Because another node could still mine it, the next send from this wallet must reuse one of its inputs until they are spent, so the two cannot both be paid.")}</Text>
							<Flex gap="2" mt="2">
								<Button data-monero-discard-yes="" size="xs" colorPalette="red" onClick={() => { void discard() }} disabled={!!busy}>{busy === "discard" ? <Spinner size="xs" /> : null}{uiText("Discard it")}</Button>
								<Button size="xs" variant="ghost" onClick={() => setConfirmDiscard(false)} disabled={!!busy}>{uiText("Keep it")}</Button>
							</Flex>
						</Box>
					)}
					</details>
				</Box>
			)}
			{receiveOnly ? (
				<Text data-monero-send-blocked={wallet.sendBlocked} fontSize="13px" color="var(--text-2)">{wallet.sendBlocked === "adapter"
					? uiText("Sending isn't available: this build has no Monero signing adapter. Receiving works.")
					: uiText("Sending isn't available: Monero signing needs the signing (research) emulator build. Receiving works.")}</Text>
			) : (
				<>
					<Text fontSize="15px" color="var(--text-0)" fontWeight="500" mb="3">{uiText("Send XMR")}</Text>
					{wallet.discardedTxid && <Text data-monero-discarded="" fontSize="12px" color="var(--gold)" mb="2">{uiText("Your discarded send will be checked before another payment.")}</Text>}
					{wallet.sendBlocked === "syncing" && <Text data-monero-send-blocked="syncing" fontSize="13px" color="var(--text-2)">{uiText("Wait for the wallet to finish scanning before sending.")}</Text>}
					{(wallet.canSend || wallet.sendBlocked === "key-images") && !wallet.unrelayedTxid && !review && (
						<Box>
							<Text fontSize="11px" color="var(--text-3)" mb="1">{uiText("Recipient address")}</Text>
							<Input data-monero-send-address="" disabled={!!busy} value={recipient} onChange={e => setRecipient(e.target.value)} placeholder={uiText("Monero address or subaddress")} spellCheck={false} size="sm" fontFamily="mono" className="electrobun-webkit-app-region-no-drag" />
							{problems.address && <Text data-monero-problem="address" mt="1" fontSize="12px" color="var(--rose)">{problemText(problems.address, privateMode ? null : view.unlockedAtomic)}</Text>}
							<Flex align="center" justify="space-between" mt="3" mb="1">
								<Text fontSize="11px" color="var(--text-3)">{uiText("Amount (XMR)")}</Text>
								<Text fontSize="11px" color="var(--text-3)">{uiText("Unlocked")}: {!view.spendVerified || view.unlockedAtomic === null ? "—" : privateMode ? "••••••" : `${formatXmr(view.unlockedAtomic)} XMR`}</Text>
							</Flex>
							<Flex gap="2">
								<Input data-monero-send-amount="" value={max ? uiText("Max") : amount} disabled={max || !!busy} onChange={e => setAmount(e.target.value)} placeholder="0.000000000000" inputMode="decimal" size="sm" fontFamily="mono" className="electrobun-webkit-app-region-no-drag" />
								<Button data-monero-max="" disabled={!!busy} size="sm" variant={max ? "solid" : "outline"} onClick={() => setMax(m => !m)} className="electrobun-webkit-app-region-no-drag">{uiText("Max")}</Button>
							</Flex>
							{problems.amount && <Text data-monero-problem="amount" mt="1" fontSize="12px" color="var(--rose)">{problemText(problems.amount, privateMode ? null : view.unlockedAtomic)}</Text>}
							<Text mt="2" fontSize="11px" color="var(--text-3)">{max
								? uiText("Sends your available balance minus the network fee and a small amount kept for change.")
								: uiText("Review the amount and fee before confirming on KeepKey.")}</Text>
							<Button data-monero-review-send="" mt="4" size="sm" onClick={() => { void prepare() }} disabled={!!busy || verification.busy || !ready} className="electrobun-webkit-app-region-no-drag">
								{busy === "sync" || busy === "prepare" ? <Spinner size="xs" /> : <FaPaperPlane />}{busy === "sync" ? uiText("Confirm on KeepKey to verify your balance…") : busy === "prepare" ? uiText("Preparing…") : uiText("Review send")}
							</Button>
						</Box>
					)}
					{review && (
						<Box data-monero-send-review="">
							<Text fontSize="12px" color="var(--text-2)" mb="3">{uiText("KeepKey will show these screens. Check each one on the device before approving.")}</Text>
							<Text fontSize="11px" color="var(--text-3)">{uiText("Recipient")}</Text>
							<Text fontSize="12px" fontFamily="mono" color="var(--text-0)" wordBreak="break-all" mb="3">{review.recipient}</Text>
							<details style={{ marginBottom: 16, color: "var(--text-3)", fontSize: 12 }}><summary style={{ cursor: "pointer" }}>{uiText("Transaction details")}</summary>
							<Box {...cardProps} mb="3">
								<Text fontSize="12px" color="var(--text-0)" fontWeight="500">{uiText("Monero transaction")}</Text>
								<Text fontSize="12px" fontFamily="mono" color="var(--text-1)">{uiText("Mainnet")} · m/44'/128'/0'</Text>
								<Text fontSize="12px" color="var(--text-1)">{uiText("{{inputs}} inputs, {{outputs}} outputs", { inputs: review.inputCount, outputs: review.outputs.length })}</Text>
								<Text fontSize="12px" fontFamily="mono" color="var(--text-1)">{uiText("Fee")} {formatXmr(review.feeAtomic)} XMR</Text>
							</Box>
							{review.outputs.map((output, index) => (
								<Box key={index} {...cardProps} mb="3">
									<Text fontSize="12px" color="var(--text-0)" fontWeight="500">{uiText("Output {{index}}/{{count}}", { index: index + 1, count: review.outputs.length })}: {output.role === "change" ? uiText("Change") : uiText("Recipient")}</Text>
									<Text fontSize="12px" fontFamily="mono" color="var(--text-1)">{uiText("Amount")} {formatXmr(output.amountAtomic)} XMR</Text>
									{output.role === "change" && <Text fontSize="12px" color="var(--text-2)">{uiText("Change subaddress 0/0")}</Text>}
									<Text fontSize="12px" fontFamily="mono" color="var(--text-0)" wordBreak="break-all" mt="1">{output.address}</Text>
								</Box>
							))}
							</details>
							<Flex gap={{ base: "4", md: "8" }} mb="4" flexWrap="wrap">
								<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Amount")}</Text><Text data-monero-review-amount="" fontSize="13px" fontFamily="mono" color="var(--text-0)">{formatXmr(review.amountAtomic)} XMR</Text></Box>
								<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Fee")}</Text><Text fontSize="13px" fontFamily="mono" color="var(--text-0)">{formatXmr(review.feeAtomic)} XMR</Text></Box>

								<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Total")}</Text><Text fontSize="13px" fontFamily="mono" color="var(--text-0)">{formatXmr(review.totalAtomic)} XMR</Text></Box>
							</Flex>
							<Flex gap="3">
								<Button data-monero-confirm-send="" size="sm" onClick={() => { void confirm() }} disabled={!!busy} className="electrobun-webkit-app-region-no-drag">
									{busy === "confirm" ? <Spinner size="xs" /> : <FaCheck />}{busy === "confirm" ? uiText("Confirm on KeepKey…") : uiText("Confirm on KeepKey")}
								</Button>
								<Button size="sm" variant="ghost" onClick={() => setReview(null)} disabled={!!busy} className="electrobun-webkit-app-region-no-drag">{uiText("Cancel")}</Button>
							</Flex>
						</Box>
					)}
				</>
			)}
			<details data-monero-send-details="" style={{ marginTop: 24, color: "var(--text-3)", fontSize: 12 }}>
				<summary style={{ cursor: "pointer" }}>{uiText("Wallet details")}</summary>
				{wallet.discardedTxid && <Text mt="2" fontFamily="mono" wordBreak="break-all">{wallet.discardedTxid}</Text>}
				<Box mt="3"><MoneroAmounts view={view} privateMode={privateMode} /></Box>
				<Text mt="2">{uiText("Balance verification uses key images to check which outputs are spent. It runs automatically before preparing a send. Your node can link those spends; use your own node for full privacy.")}</Text>
				<Button data-monero-sync-key-images="" mt="2" size="xs" variant="outline" onClick={() => { void sync() }} disabled={!!busy || verification.busy || !!wallet.unrelayedTxid || wallet.sendBlocked === "syncing"}>{uiText("Verify balance again")}</Button>
			</details>
			{sentTxid && (
				<Box mt="3" role="status">
					<Text fontSize="12px" color="var(--teal)">{uiText("Transaction sent to the Monero node.")}</Text>
					<Text data-monero-sent="" fontSize="11px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all" userSelect="all">{sentTxid}</Text>
				</Box>
			)}
			{notice && <Text data-monero-notice="" mt="3" fontSize="12px" color="var(--teal)" role="status">{notice}</Text>}
			{error && !wallet.unrelayedTxid && <Text data-monero-error="" mt="3" fontSize="12px" color="var(--rose)" role="alert">{error}</Text>}
		</Box>
	)
}

/** The XMR row in the Dashboard's chain list. Opens the standard asset page; fiat says "not included". */
export function MoneroChainRow({ chain, iconSrc, privateMode, onOpen, client }: { chain: ChainDef; iconSrc: string; privateMode: boolean; onOpen: () => void; client?: MoneroClient }) {
	const uiText = useUiTranslation()
	const monero = useMoneroStatus(true, client)
	const view = useMoneroView(monero)
	const label = useMoneroStateLabel(view)
	const balance = view.spendVerified || view.balanceAtomic === "0" ? view.balanceAtomic : null
	return (
		<Box data-monero-row="" as="button" onClick={onOpen} w="100%" textAlign="left" p="2.5" mb="1.5" borderRadius="lg" bg="transparent"
			border="1px solid transparent" _hover={{ bg: "kk.cardBg", borderColor: `${chain.color}50` }} cursor="pointer" transition="all 0.15s"
			title={uiText("XMR has no price source here, so it is not included in the portfolio total.")}>
			<Flex align="center" gap="3">
				<Image src={iconSrc} alt={chain.symbol} w="32px" h="32px" borderRadius="full" flexShrink={0} />
				<Box flex="1" minW="0">
					<Flex align="baseline" justify="space-between" gap="2">
						<Text fontSize="14px" fontWeight="600" color="var(--text-0)" lineHeight="1.2" truncate>{chain.coin}</Text>
						<Text data-monero-row-fiat="" fontSize="11px" color="var(--text-3)" lineHeight="1.2" flexShrink={0}>{uiText("not included")}</Text>
					</Flex>
					<Flex align="baseline" justify="space-between" gap="2" mt="0.5">
						<Text data-monero-row-balance="" fontSize="12px" color="var(--text-2)" lineHeight="1.3" truncate>
							{balance === null ? `— ${chain.symbol}` : privateMode ? "••••" : `${formatXmrShort(balance)} ${chain.symbol}`}
						</Text>
						{(view.state !== "ready" || (view.restoreHeight ?? 0) > 0 || balance === null) && <Text data-monero-row-state={view.state} fontSize="10px" color={view.state === "unreachable" ? "var(--gold)" : "var(--text-3)"} flexShrink={0}>{label}</Text>}
					</Flex>
				</Box>
			</Flex>
		</Box>
	)
}
