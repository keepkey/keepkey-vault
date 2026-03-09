import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, Button, Input, Spinner } from "@chakra-ui/react"
import { FaShieldAlt, FaCopy, FaCheck } from "react-icons/fa"
import { rpcRequest } from "../lib/rpc"
import { generateQRSvg } from "../lib/qr"

type SidecarStatus = "checking" | "ready" | "not_running" | "initializing"
type ScanState = "idle" | "scanning" | "done"

export function ZcashPrivacyTab() {
	const { t } = useTranslation("asset")

	// ── State ──────────────────────────────────────────────────────────
	const [status, setStatus] = useState<SidecarStatus>("checking")
	const [orchardAddress, setOrchardAddress] = useState<string | null>(null)
	const [balance, setBalance] = useState<{ confirmed: number; pending: number } | null>(null)
	const [syncedTo, setSyncedTo] = useState<number | null>(null)
	const [scanState, setScanState] = useState<ScanState>("idle")
	const [scanResult, setScanResult] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	// Send form state
	const [recipient, setRecipient] = useState("")
	const [amount, setAmount] = useState("")
	const [memo, setMemo] = useState("")
	const [sending, setSending] = useState(false)
	const [sendResult, setSendResult] = useState<string | null>(null)
	const [sendError, setSendError] = useState<string | null>(null)

	// ── Fetch balance ─────────────────────────────────────────────────
	const refreshBalance = useCallback(async () => {
		try {
			const bal = await rpcRequest<{ confirmed: number; pending: number }>(
				"zcashShieldedBalance", undefined, 10000
			)
			setBalance(bal)
		} catch {
			// Balance not available yet (needs scan first)
		}
	}, [])

	// ── Auto-initialize: check status, auto-init from device if needed ──
	useEffect(() => {
		let cancelled = false
		;(async () => {
			try {
				const r = await rpcRequest<{ ready: boolean; fvk_loaded: boolean; address: string | null }>(
					"zcashShieldedStatus", undefined, 5000
				)
				if (cancelled) return
				if (!r.ready) { setStatus("not_running"); return }

				if (r.fvk_loaded && r.address) {
					// FVK auto-loaded from DB — no device interaction needed
					setOrchardAddress(r.address)
					setStatus("ready")
					refreshBalance()
					return
				}

				// Sidecar ready but no FVK — auto-init from device
				setStatus("initializing")
				const result = await rpcRequest<{ fvk: any; address: string }>(
					"zcashShieldedInit", { account: 0 }, 60000
				)
				if (cancelled) return
				setOrchardAddress(result.address)
				setStatus("ready")
				refreshBalance()
			} catch (e: any) {
				if (cancelled) return
				console.error("[ZcashPrivacyTab] Auto-init failed:", e)
				setStatus("not_running")
			}
		})()
		return () => { cancelled = true }
	}, [refreshBalance])

	// ── Manual re-init (fallback button, rarely needed) ───────────────
	const handleInit = useCallback(async () => {
		setStatus("initializing")
		try {
			const result = await rpcRequest<{ fvk: any; address: string }>(
				"zcashShieldedInit", { account: 0 }, 60000
			)
			setOrchardAddress(result.address)
			setStatus("ready")
			refreshBalance()
		} catch (e: any) {
			console.error("[ZcashPrivacyTab] Init failed:", e)
			setStatus("not_running")
		}
	}, [refreshBalance])

	// ── Scan for notes ────────────────────────────────────────────────
	const handleScan = useCallback(async () => {
		setScanState("scanning")
		setScanResult(null)
		try {
			const result = await rpcRequest<{ balance: number; notes_found: number; synced_to: number }>(
				"zcashShieldedScan", {}, 300000 // 5 min timeout for scan
			)
			setSyncedTo(result.synced_to)
			setScanResult(t("notesFound", { count: result.notes_found }))
			setScanState("done")
			refreshBalance()
		} catch (e: any) {
			setScanResult(e.message || "Scan failed")
			setScanState("idle")
		}
	}, [t, refreshBalance])

	// ── Send shielded ─────────────────────────────────────────────────
	const handleSend = useCallback(async () => {
		if (!recipient || !amount) return
		setSending(true)
		setSendError(null)
		setSendResult(null)
		try {
			const zatoshis = Math.round(parseFloat(amount) * 1e8)
			if (isNaN(zatoshis) || zatoshis <= 0) throw new Error("Invalid amount")
			const result = await rpcRequest<{ txid: string }>(
				"zcashShieldedSend",
				{ recipient, amount: zatoshis, memo: memo || undefined },
				120000
			)
			setSendResult(result.txid)
			setRecipient("")
			setAmount("")
			setMemo("")
			refreshBalance()
		} catch (e: any) {
			setSendError(e.message || "Send failed")
		}
		setSending(false)
	}, [recipient, amount, memo, refreshBalance])

	// ── Copy address ──────────────────────────────────────────────────
	const copyAddress = useCallback(() => {
		if (!orchardAddress) return
		navigator.clipboard.writeText(orchardAddress)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}, [orchardAddress])

	// ── Status indicator color ────────────────────────────────────────
	const statusColor = status === "ready" ? "#4ADE80"
		: status === "initializing" || status === "checking" ? "#FBBF24"
		: "#F87171"

	const statusText = status === "ready" ? t("sidecarReady")
		: status === "initializing" || status === "checking" ? t("initializing")
		: t("sidecarNotReady")

	// Format balance from zatoshis to ZEC
	const formatZec = (zatoshis: number) => (zatoshis / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")

	return (
		<Flex direction="column" gap="4">
			{/* Section A: Status bar */}
			<Flex align="center" justify="space-between" py="2" px="3" bg="rgba(255,255,255,0.02)" borderRadius="lg">
				<Flex align="center" gap="2">
					<Box w="8px" h="8px" borderRadius="full" bg={statusColor} flexShrink={0} />
					<Text fontSize="xs" color="kk.textSecondary">{statusText}</Text>
				</Flex>
				{status === "ready" && !orchardAddress && (
					<Button
						size="xs"
						color="kk.gold"
						variant="outline"
						borderColor="kk.gold"
						_hover={{ bg: "rgba(192,168,96,0.15)" }}
						onClick={handleInit}
					>
						<Box as={FaShieldAlt} fontSize="10px" mr="1.5" />
						{t("initializePrivacy")}
					</Button>
				)}
				{status === "not_running" && (
					<Text fontSize="10px" color="kk.textMuted">Build zcash-cli to enable</Text>
				)}
				{status === "initializing" && <Spinner size="xs" color="kk.gold" />}
			</Flex>

			{/* Section B: Shielded balance */}
			{orchardAddress && (
				<Box px="3" py="3" bg="rgba(236,178,68,0.04)" border="1px solid" borderColor="rgba(236,178,68,0.15)" borderRadius="lg">
					<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em" mb="1.5">
						{t("shieldedBalance")}
					</Text>
					{balance ? (
						<Flex direction="column" gap="1">
							<Flex align="baseline" gap="2">
								<Text fontSize="lg" fontWeight="700" fontFamily="mono" color="white">
									{formatZec(balance.confirmed)}
								</Text>
								<Text fontSize="sm" color="kk.textMuted">ZEC</Text>
							</Flex>
							{balance.pending > 0 && (
								<Text fontSize="xs" color="kk.textMuted">
									{t("pendingBalance")}: {formatZec(balance.pending)} ZEC
								</Text>
							)}
							{syncedTo && (
								<Text fontSize="10px" color="kk.textMuted" mt="0.5">
									{t("lastSynced", { height: syncedTo.toLocaleString() })}
								</Text>
							)}
						</Flex>
					) : (
						<Text fontSize="xs" color="kk.textMuted">{t("initRequired")}</Text>
					)}
				</Box>
			)}

			{/* Section C: Orchard address (receive) */}
			{orchardAddress && (
				<Box px="3" py="3" bg="rgba(255,255,255,0.02)" borderRadius="lg">
					<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em" mb="2">
						{t("orchardAddress")}
					</Text>
					<Flex gap="3" align="flex-start" direction={{ base: "column", sm: "row" }}>
						<Box
							bg="white"
							borderRadius="md"
							dangerouslySetInnerHTML={{ __html: generateQRSvg(orchardAddress, 3, 2) }}
							w="120px"
							h="120px"
							overflow="hidden"
							flexShrink={0}
						/>
						<Flex direction="column" gap="2" flex="1" minW="0">
							<Text
								fontSize="11px"
								fontFamily="mono"
								color="kk.textSecondary"
								wordBreak="break-all"
								lineHeight="1.4"
							>
								{orchardAddress}
							</Text>
							<Button
								size="xs"
								variant="outline"
								borderColor="kk.border"
								color={copied ? "#4ADE80" : "kk.textSecondary"}
								_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
								onClick={copyAddress}
								w="fit-content"
							>
								<Box as={copied ? FaCheck : FaCopy} fontSize="10px" mr="1.5" />
								{copied ? "Copied" : t("copyAddress")}
							</Button>
						</Flex>
					</Flex>
				</Box>
			)}

			{/* Section D: Scan controls */}
			{orchardAddress && (
				<Flex align="center" gap="3" px="3">
					<Button
						size="sm"
						variant="outline"
						borderColor="kk.border"
						color="kk.textSecondary"
						_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
						onClick={handleScan}
						disabled={scanState === "scanning"}
						flex="1"
					>
						{scanState === "scanning" ? (
							<><Spinner size="xs" mr="2" /> {t("scanning")}</>
						) : (
							t("scanNotes")
						)}
					</Button>
					{scanResult && (
						<Text fontSize="xs" color="kk.textMuted">{scanResult}</Text>
					)}
				</Flex>
			)}

			{/* Section E: Send shielded */}
			{orchardAddress && (
				<Box px="3" py="3" bg="rgba(255,255,255,0.02)" borderRadius="lg">
					<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em" mb="2">
						{t("sendPrivately")}
					</Text>
					<Flex direction="column" gap="2">
						<Input
							placeholder="u1... (Unified) or t1... (transparent)"
							value={recipient}
							onChange={(e) => setRecipient(e.target.value)}
							size="sm"
							bg="rgba(255,255,255,0.03)"
							borderColor="kk.border"
							color="white"
							fontFamily="mono"
							fontSize="12px"
							_hover={{ borderColor: "kk.textMuted" }}
							_focus={{ borderColor: "kk.gold", boxShadow: "none" }}
						/>
						<Flex gap="2">
							<Input
								placeholder={t("amountZec")}
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								size="sm"
								type="number"
								step="0.00000001"
								bg="rgba(255,255,255,0.03)"
								borderColor="kk.border"
								color="white"
								fontFamily="mono"
								fontSize="12px"
								_hover={{ borderColor: "kk.textMuted" }}
								_focus={{ borderColor: "kk.gold", boxShadow: "none" }}
								flex="1"
							/>
							<Input
								placeholder={t("memo")}
								value={memo}
								onChange={(e) => setMemo(e.target.value)}
								size="sm"
								bg="rgba(255,255,255,0.03)"
								borderColor="kk.border"
								color="white"
								fontSize="12px"
								_hover={{ borderColor: "kk.textMuted" }}
								_focus={{ borderColor: "kk.gold", boxShadow: "none" }}
								flex="1"
							/>
						</Flex>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							_hover={{ bg: "rgba(192,168,96,0.9)" }}
							onClick={handleSend}
							disabled={!recipient || !amount || sending}
						>
							{sending ? (
								<><Spinner size="xs" mr="2" /> {t("sending")}</>
							) : (
								<><Box as={FaShieldAlt} fontSize="11px" mr="1.5" /> {t("sendPrivately")}</>
							)}
						</Button>
						{sendResult && (
							<Box bg="rgba(72,187,120,0.1)" border="1px solid" borderColor="rgba(72,187,120,0.3)" borderRadius="md" px="3" py="2">
								<Text fontSize="xs" color="#4ADE80" fontWeight="600" mb="0.5">{t("txSent")}</Text>
								<Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all">
									{sendResult}
								</Text>
							</Box>
						)}
						{sendError && (
							<Text fontSize="xs" color="#F87171">{sendError}</Text>
						)}
					</Flex>
				</Box>
			)}
		</Flex>
	)
}
