/** The Monero-specific parts of the standard asset page (AssetPage): balance header and chip, the
 *  view-key connect step, Receive (with device-verified subaddresses) and Send (key-image sync,
 *  review, unknown-broadcast recovery). Every amount that is not known renders as "—". */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Button, Flex, Image, Input, Spinner, Text } from "@chakra-ui/react"
import { FaCheck, FaKey, FaMinus, FaPaperPlane, FaPlus } from "react-icons/fa"
import { useUiTranslation } from "../i18n/ui"
import type { ChainDef } from "../../shared/chains"
import type { MoneroSendReview } from "../../shared/types"
import { formatXmr, formatXmrShort, moneroBalanceView, moneroSendInputProblems, type MoneroBalanceView, type MoneroSendProblem } from "../../shared/monero-asset"
import { getNumberLocale } from "../lib/number-locale"
import type { MoneroClient } from "../lib/monero-client"
import { useMoneroStatus, type MoneroStatusState } from "../hooks/useMoneroStatus"
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
	if (view.state === "ready") return uiText("Synced")
	if (view.state === "unreachable") return uiText("Node unreachable")
	return view.progress === undefined ? uiText("Syncing") : uiText("Syncing {{percent}}%", { percent: Math.floor(view.progress * 100) })
}

export function MoneroStatusChip({ view }: { view: MoneroBalanceView }) {
	const label = useMoneroStateLabel(view)
	const color = view.state === "ready" ? "var(--teal)" : view.state === "unreachable" ? "var(--rose)" : "var(--gold)"
	return (
		<Flex data-monero-state={view.state} align="center" gap="1" color={color} className="v3-glass-chip" px="2" py="0.5">
			{view.state === "ready" ? <Box as={FaCheck} fontSize="9px" /> : <Box w="6px" h="6px" borderRadius="full" bg={color} />}
			<Text fontSize="10px" fontFamily="mono" fontWeight="500" letterSpacing="0.02em">{label}</Text>
		</Flex>
	)
}

/** Header amount: "—" when unknown; fiat is never shown (no price source), it says "not included". */
export function MoneroHeaderBalance({ view, privateMode }: { view: MoneroBalanceView; privateMode: boolean }) {
	const uiText = useUiTranslation()
	return (
		<Flex direction="column" align="flex-end" gap="0.5">
			<Flex align="baseline" gap="1.5">
				<Text data-monero-header-balance="" fontFamily="mono" fontSize={{ base: "20px", md: "26px" }} fontWeight="600" color="var(--text-0)" lineHeight="1.05">
					{view.balanceAtomic === null ? "—" : privateMode ? "••••••" : formatXmrShort(view.balanceAtomic)}
				</Text>
				<Text fontFamily="mono" fontSize={{ base: "12px", md: "14px" }} color="var(--text-3)">XMR</Text>
			</Flex>
			<Text fontSize="10px" color="var(--text-3)" title={uiText("XMR has no price source here, so it is not included in the portfolio total.")}>{uiText("Fiat value not included")}</Text>
		</Flex>
	)
}

/** One line under the balance that says what it means right now. */
function MoneroBalanceNote({ view }: { view: MoneroBalanceView }) {
	const uiText = useUiTranslation()
	if (view.state === "scanning") {
		return <Text data-monero-note="scanning" fontSize="12px" color="var(--text-2)">{view.walletHeight && view.daemonHeight
			? uiText("Scanning the chain: block {{height}} of {{tip}}. The balance appears when the scan reaches the tip.", { height: view.walletHeight.toLocaleString(getNumberLocale()), tip: view.daemonHeight.toLocaleString(getNumberLocale()) })
			: uiText("Scanning the chain from block {{start}}. The balance appears when the scan reaches the tip.", { start: (view.restoreHeight ?? 0).toLocaleString(getNumberLocale()) })}</Text>
	}
	if (view.state === "unreachable") {
		return <Text data-monero-note="unreachable" role="alert" fontSize="12px" color="var(--gold)">{view.balanceAtomic === null
			? uiText("The Monero node can't be reached, and no balance has been read yet.")
			: uiText("The Monero node can't be reached. Showing the last known balance, from {{time}}.", { time: view.updatedAt ? new Date(view.updatedAt).toLocaleString(getNumberLocale()) : "—" })}</Text>
	}
	if (view.state === "ready" && !view.spendVerified) {
		return <Text data-monero-note="unverified" fontSize="12px" color="var(--text-2)">{uiText("Received, not yet verified as spendable: a view-only wallet can't see spends made from another wallet. Sync key images on the Send tab to verify.")}</Text>
	}
	return null
}

function MoneroAmounts({ view, privateMode }: { view: MoneroBalanceView; privateMode: boolean }) {
	const uiText = useUiTranslation()
	const show = (atomic: string | null) => atomic === null ? "—" : privateMode ? "••••••" : `${formatXmr(atomic)} XMR`
	return (
		<Flex gap={{ base: "5", md: "10" }} flexWrap="wrap">
			<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Received")}</Text><Text data-monero-balance="" fontSize="13px" fontFamily="mono" color="var(--text-0)">{show(view.balanceAtomic)}</Text></Box>
			<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Unlocked")}</Text><Text data-monero-unlocked="" fontSize="13px" fontFamily="mono" color="var(--teal)">{show(view.unlockedAtomic)}</Text></Box>
			<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Locked (fewer than 10 confirmations)")}</Text><Text data-monero-locked="" fontSize="13px" fontFamily="mono" color="var(--text-1)">{show(view.lockedAtomic)}</Text></Box>
		</Flex>
	)
}

/** The view-key consent step, with where the scan starts and which node is used. */
export function MoneroConnectCard({ client, monero }: { client: MoneroClient; monero: MoneroStatusState }) {
	const uiText = useUiTranslation()
	const [settings, setSettings] = useState<{ moneroDaemonUrl: string; moneroRestoreHeight: number | null } | null>(null)
	const [suggestion, setSuggestion] = useState<{ tipHeight: number; restoreHeight: number } | null>(null)
	const [suggestionError, setSuggestionError] = useState<string | null>(null)
	const [choice, setChoice] = useState<"new" | "existing">("new")
	const [height, setHeight] = useState("0")
	const [connecting, setConnecting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		let live = true
		client.getSettings().then(next => {
			if (!live) return
			setSettings(next)
			if (next.moneroRestoreHeight !== null) { setChoice("existing"); setHeight(String(next.moneroRestoreHeight)) }
		}).catch(e => { if (live) setError(errorText(e, "Unable to read the Monero settings.")) })
		client.suggestRestoreHeight().then(next => { if (live) setSuggestion(next) })
			.catch(e => { if (live) { setSuggestionError(errorText(e, "Unable to read the node height.")); setChoice("existing") } })
		return () => { live = false }
	}, [client])
	const chosenHeight = choice === "new" ? suggestion?.restoreHeight : /^(0|[1-9][0-9]{0,9})$/.test(height.trim()) ? Number(height.trim()) : undefined
	const connect = async () => {
		if (chosenHeight === undefined || connecting) return
		setConnecting(true); setError(null)
		try { monero.setStatus(await client.connect(chosenHeight)) }
		catch (e) { setError(errorText(e, "Unable to connect Monero.")) }
		finally { setConnecting(false) }
	}
	const option = (value: "new" | "existing", label: string, disabled = false) => (
		<Box as="label" display="flex" alignItems="flex-start" gap="2" cursor={disabled ? "not-allowed" : "pointer"} opacity={disabled ? 0.5 : 1}>
			<input type="radio" name="monero-scan-start" value={value} checked={choice === value} disabled={disabled} onChange={() => setChoice(value)} />
			<Text fontSize="13px" color="var(--text-1)">{label}</Text>
		</Box>
	)
	return (
		<Box data-monero-connect="" py="2">
			<Text fontSize="15px" color="var(--text-0)" fontWeight="500" mb="2">{uiText("Connect your Monero wallet")}</Text>
			<Text fontSize="13px" color="var(--text-2)" mb="4">{uiText("KeepKey asks you to approve sharing the private view key with this computer's local Monero wallet. It can see incoming payments; it cannot spend.")}</Text>
			<Box {...cardProps} mb="3">
				<Text fontSize="12px" color="var(--text-0)" fontWeight="500" mb="2">{uiText("Where should the scan start?")}</Text>
				<Flex direction="column" gap="2">
					{option("new", suggestion
						? uiText("New wallet (no XMR received yet): start at block {{height}}, about a week before the current block {{tip}}.", { height: suggestion.restoreHeight.toLocaleString(getNumberLocale()), tip: suggestion.tipHeight.toLocaleString(getNumberLocale()) })
						: uiText("New wallet (no XMR received yet): start about a week before the current block."), !suggestion)}
					{option("existing", uiText("This wallet has received XMR before: start at an earlier block (0 scans everything, which takes hours)."))}
				</Flex>
				{choice === "existing" && <Input data-monero-restore-height="" mt="2" size="sm" maxW="200px" inputMode="numeric" aria-label={uiText("Scan start block")} value={height} onChange={e => setHeight(e.target.value)} />}
				{choice === "existing" && chosenHeight === undefined && <Text mt="1" fontSize="12px" color="var(--rose)">{uiText("Enter a block height (a whole number, 0 or more).")}</Text>}
				{suggestionError && <Text mt="2" fontSize="12px" color="var(--text-2)">{uiText("Couldn't read the node's current block: {{error}}", { error: suggestionError })}</Text>}
			</Box>
			<Box {...cardProps} mb="4">
				<Text fontSize="12px" color="var(--text-0)" fontWeight="500">{uiText("Node")}: <Box as="span" fontFamily="mono" fontWeight="400">{settings?.moneroDaemonUrl ?? "—"}</Box></Text>
				<Text fontSize="11px" color="var(--text-2)" mt="1">{uiText("The node sees your IP address and, after a key-image sync, which outputs you spend. A node you run yourself (for example http://127.0.0.1:18081) keeps that private. Change it in Settings → Monero.")}</Text>
			</Box>
			<Button data-monero-connect-button="" size="sm" disabled={connecting || chosenHeight === undefined} onClick={() => { void connect() }} className="electrobun-webkit-app-region-no-drag">
				{connecting ? <Spinner size="xs" /> : null}{connecting ? uiText("Confirm on KeepKey…") : uiText("Connect Monero wallet")}
			</Button>
			{error && <Text role="alert" color="var(--rose)" fontSize="13px" mt="3">{error}</Text>}
		</Box>
	)
}

export function MoneroReceiveSection({ chain, monero, client, privateMode }: { chain: ChainDef; monero: MoneroStatusState; client: MoneroClient; privateMode: boolean }) {
	const uiText = useUiTranslation()
	const view = useMoneroView(monero)
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
			<Box mb="5"><MoneroAmounts view={view} privateMode={privateMode} /><Box mt="2"><MoneroBalanceNote view={view} /></Box></Box>
			<Flex align="center" gap="2" mb="3" flexWrap="wrap">
				<Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em">{uiText("Receive to")}</Text>
				<Button aria-label={uiText("Previous subaddress")} size="xs" variant="ghost" disabled={minor === 0} onClick={() => setMinor(m => Math.max(0, m - 1))}><FaMinus /></Button>
				<Text data-monero-subaddress="" fontSize="12px" fontFamily="mono" color="var(--gold)">{minor === 0 ? uiText("Main address") : uiText("Subaddress #{{index}}", { index: minor })}</Text>
				<Button aria-label={uiText("Next subaddress")} size="xs" variant="ghost" disabled={minor >= MAX_SUBADDRESS} onClick={() => setMinor(m => Math.min(MAX_SUBADDRESS, m + 1))}><FaPlus /></Button>
			</Flex>
			<ReceiveView chain={chain} address={address} loading={loading} error={error} currentPath={MONERO_PATH} pathEditable={false}
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
					<Flex key={tx.txid} justify="space-between" gap="4" py="2" borderTop={index ? "1px solid var(--line)" : undefined} flexWrap="wrap">
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

export function MoneroSendSection({ monero, client }: { monero: MoneroStatusState; client: MoneroClient }) {
	const uiText = useUiTranslation()
	const problemText = useProblemText()
	const view = useMoneroView(monero)
	const wallet = monero.status?.available ? monero.status : null
	const [recipient, setRecipient] = useState("")
	const [amount, setAmount] = useState("")
	const [max, setMax] = useState(false)
	const [review, setReview] = useState<MoneroSendReview | null>(null)
	const [busy, setBusy] = useState<"sync" | "prepare" | "confirm" | "retry" | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [sentTxid, setSentTxid] = useState<string | null>(null)
	const address = wallet?.address ?? ""
	useEffect(() => { setReview(null); setError(null); setSentTxid(null) }, [address])
	if (!wallet) return <MoneroConnectCard client={client} monero={monero} />
	const problems = moneroSendInputProblems({ address: recipient, amount, max, walletAddress: address, unlockedAtomic: view.unlockedAtomic })
	const ready = !!recipient.trim() && !problems.address && (max || (!!problems.amountAtomic && !problems.amount))
	const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
		if (busy) return
		setBusy(kind); setError(null)
		try { await action() } catch (e) { setError(errorText(e, "The Monero request failed.")) } finally { setBusy(null) }
	}
	const sync = () => run("sync", async () => { monero.setStatus(await client.syncKeyImages()) })
	const prepare = () => run("prepare", async () => {
		setSentTxid(null)
		const next = await client.prepareSend({ address: recipient.trim(), ...(max ? { max: true } : { amountAtomic: problems.amountAtomic! }) })
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
	const receiveOnly = wallet.sendBlocked === "emulator" || wallet.sendBlocked === "adapter"
	return (
		<Box data-monero-send="">
			{wallet.unrelayedTxid && (
				<Box role="alert" mb="4" {...cardProps} borderColor="var(--gold)">
					<Text fontSize="13px" color="var(--gold)">{uiText("The broadcast result of your last send is unknown. Check this transaction on a block explorer before doing anything else. Retry broadcast resends the same transaction; it cannot pay twice. New sends from this wallet wait until it is settled, even after a restart.")}</Text>
					<Text data-monero-unrelayed="" fontSize="11px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all" userSelect="all" mt="1">{wallet.unrelayedTxid}</Text>
					<Button data-monero-retry-relay="" mt="2" size="xs" variant="outline" onClick={() => { void retry() }} disabled={!!busy} className="electrobun-webkit-app-region-no-drag">{busy === "retry" ? <Spinner size="xs" /> : null}{uiText("Retry broadcast")}</Button>
				</Box>
			)}
			{receiveOnly ? (
				<Text data-monero-send-blocked={wallet.sendBlocked} fontSize="13px" color="var(--text-2)">{wallet.sendBlocked === "adapter"
					? uiText("Sending isn't available: this build has no Monero signing adapter. Receiving works.")
					: uiText("Sending isn't available: Monero signing needs the signing (research) emulator build. Receiving works.")}</Text>
			) : (
				<>
					<Flex justify="space-between" align="center" gap="3" mb="2" flexWrap="wrap">
						<Text fontSize="15px" color="var(--text-0)" fontWeight="500">{uiText("Send XMR")}</Text>
						<Button data-monero-sync-key-images="" onClick={() => { void sync() }} disabled={!!busy || wallet.sendBlocked === "syncing"} size="xs" variant="outline" className="electrobun-webkit-app-region-no-drag">
							{busy === "sync" ? <Spinner size="xs" /> : <FaKey />}
							{busy === "sync" ? uiText("Confirm on KeepKey…") : wallet.keyImagesSynced ? uiText("Sync key images again") : uiText("Sync key images on KeepKey")}
						</Button>
					</Flex>
					<Text fontSize="11px" color="var(--text-3)" mb="3">{uiText("Syncing key images shares them with your Monero node, which lets that node link your spends. Use your own node for full privacy. KeepKey asks once per 64 received outputs.")}</Text>
					{wallet.sendBlocked === "syncing" && <Text data-monero-send-blocked="syncing" fontSize="13px" color="var(--text-2)">{uiText("Wait for the wallet to finish scanning before sending.")}</Text>}
					{wallet.sendBlocked === "key-images" && <Text data-monero-send-blocked="key-images" fontSize="13px" color="var(--text-2)">{wallet.keyImagesStale
						? uiText("New XMR arrived since the last key-image sync. Sync key images again so the wallet knows which outputs are spent.")
						: uiText("Sync key images on KeepKey so the wallet knows which outputs are already spent. Sending is available after the sync.")}</Text>}
					{wallet.canSend && !review && (
						<Box>
							<Text fontSize="11px" color="var(--text-3)" mb="1">{uiText("Recipient address")}</Text>
							<Input data-monero-send-address="" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder={uiText("Monero address or subaddress")} spellCheck={false} size="sm" fontFamily="mono" className="electrobun-webkit-app-region-no-drag" />
							{problems.address && <Text data-monero-problem="address" mt="1" fontSize="12px" color="var(--rose)">{problemText(problems.address, view.unlockedAtomic)}</Text>}
							<Flex align="center" justify="space-between" mt="3" mb="1">
								<Text fontSize="11px" color="var(--text-3)">{uiText("Amount (XMR)")}</Text>
								<Text fontSize="11px" color="var(--text-3)">{uiText("Unlocked")}: {view.unlockedAtomic === null ? "—" : `${formatXmr(view.unlockedAtomic)} XMR`}</Text>
							</Flex>
							<Flex gap="2">
								<Input data-monero-send-amount="" value={max ? uiText("Max") : amount} disabled={max} onChange={e => setAmount(e.target.value)} placeholder="0.000000000000" inputMode="decimal" size="sm" fontFamily="mono" className="electrobun-webkit-app-region-no-drag" />
								<Button data-monero-max="" size="sm" variant={max ? "solid" : "outline"} onClick={() => setMax(m => !m)} className="electrobun-webkit-app-region-no-drag">{uiText("Max")}</Button>
							</Flex>
							{problems.amount && <Text data-monero-problem="amount" mt="1" fontSize="12px" color="var(--rose)">{problemText(problems.amount, view.unlockedAtomic)}</Text>}
							<Text mt="2" fontSize="11px" color="var(--text-3)">{max
								? uiText("Max sends your whole unlocked balance minus the network fee, keeping 0.000000000001 XMR as change (KeepKey signs only transactions with a change output).")
								: uiText("The wallet chooses the inputs and fee; you review both before KeepKey signs.")}</Text>
							<Button data-monero-review-send="" mt="4" size="sm" onClick={() => { void prepare() }} disabled={!!busy || !ready} className="electrobun-webkit-app-region-no-drag">
								{busy === "prepare" ? <Spinner size="xs" /> : <FaPaperPlane />}{busy === "prepare" ? uiText("Preparing…") : uiText("Review send")}
							</Button>
						</Box>
					)}
					{review && (
						<Box data-monero-send-review="">
							<Text fontSize="12px" color="var(--text-2)" mb="3">{uiText("KeepKey will show these screens. Check each one on the device before approving.")}</Text>
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
							<Flex gap={{ base: "4", md: "8" }} mb="4" flexWrap="wrap">
								<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Amount")}</Text><Text data-monero-review-amount="" fontSize="13px" fontFamily="mono" color="var(--text-0)">{formatXmr(review.amountAtomic)} XMR</Text></Box>
								<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Fee")}</Text><Text fontSize="13px" fontFamily="mono" color="var(--text-0)">{formatXmr(review.feeAtomic)} XMR</Text></Box>
								<Box><Text fontSize="11px" color="var(--text-3)">{uiText("Change")}</Text><Text fontSize="13px" fontFamily="mono" color="var(--text-0)">{formatXmr(review.changeAtomic)} XMR</Text></Box>
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
			{sentTxid && (
				<Box mt="3" role="status">
					<Text fontSize="12px" color="var(--teal)">{uiText("Transaction sent to the Monero node.")}</Text>
					<Text data-monero-sent="" fontSize="11px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all" userSelect="all">{sentTxid}</Text>
				</Box>
			)}
			{error && <Text data-monero-error="" mt="3" fontSize="12px" color="var(--rose)" role="alert">{error}</Text>}
		</Box>
	)
}

/** The XMR row in the Dashboard's chain list. Opens the standard asset page; fiat says "not included". */
export function MoneroChainRow({ chain, iconSrc, privateMode, onOpen, client }: { chain: ChainDef; iconSrc: string; privateMode: boolean; onOpen: () => void; client?: MoneroClient }) {
	const uiText = useUiTranslation()
	const monero = useMoneroStatus(true, client)
	const view = useMoneroView(monero)
	const label = useMoneroStateLabel(view)
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
							{view.balanceAtomic === null ? `— ${chain.symbol}` : privateMode ? "••••" : `${formatXmrShort(view.balanceAtomic)} ${chain.symbol}`}
						</Text>
						{view.state !== "ready" && <Text data-monero-row-state={view.state} fontSize="10px" color={view.state === "unreachable" ? "var(--gold)" : "var(--text-3)"} flexShrink={0}>{label}</Text>}
					</Flex>
				</Box>
			</Flex>
		</Box>
	)
}
