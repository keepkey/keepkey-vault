import { useEffect, useState, useCallback } from "react"
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../../lib/z-index"
import { rpcRequest } from "../../lib/rpc"
import type { SigningRequestInfo, EIP712DecodedInfo, CalldataDecodedInfo, SolanaTxDecodedInfo, EthMessageDecodedInfo } from "../../../shared/types"
import { versionCompare } from "../../../shared/firmware-versions"

interface SigningApprovalProps {
	request: SigningRequestInfo
	phase: 'approve' | 'device-confirm'
	onApprove: () => void
	onReject: () => void
}

const METHOD_LABEL_KEYS: Record<string, string> = {
	"/eth/sign-transaction": "signing.methodEthSignTx",
	"/eth/sign-typed-data": "signing.methodEthSignTypedData",
	"/eth/sign": "signing.methodEthSignMessage",
	"/utxo/sign-transaction": "signing.methodBtcSignTx",
	"/xrp/sign-transaction": "signing.methodXrpSignTx",
	"/cosmos/sign-amino": "signing.methodCosmosSign",
	"/thorchain/sign-amino-transfer": "signing.methodThorchainTransfer",
	"/thorchain/sign-amino-deposit": "signing.methodThorchainDeposit",
	"/mayachain/sign-amino-transfer": "signing.methodMayaTransfer",
	"/mayachain/sign-amino-deposit": "signing.methodMayaDeposit",
	"/osmosis/sign-amino": "signing.methodOsmosisSign",
	"/solana/sign-transaction": "signing.methodSolanaSignTx",
	"/solana/sign-message": "signing.methodSolanaSignTx",
	"/ton/sign-transaction": "signing.methodTonSignTx",
	"/tron/sign-transaction": "signing.methodTronSignTx",
}

const SIGNING_ANIMATIONS = `
	@keyframes signingPulseGlow {
		0%, 100% { box-shadow: 0 0 8px 2px rgba(192,168,96,0.4); }
		50% { box-shadow: 0 0 24px 8px rgba(192,168,96,0.7), 0 0 48px 16px rgba(192,168,96,0.15); }
	}
	@keyframes signingFlashBorder {
		0%, 100% { border-color: rgba(192,168,96,0.5); }
		50% { border-color: rgba(192,168,96,1); }
	}
	@keyframes signingBadgePulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.7; transform: scale(1.05); }
	}
	@keyframes signingOverlayIn {
		0% { opacity: 0; }
		100% { opacity: 1; }
	}
	@keyframes signingCardIn {
		0% { opacity: 0; transform: scale(0.92) translateY(12px); }
		100% { opacity: 1; transform: scale(1) translateY(0); }
	}
	@keyframes warningPulse {
		0%, 100% { box-shadow: 0 0 8px 2px rgba(245,163,59,0.3); }
		50% { box-shadow: 0 0 20px 6px rgba(245,163,59,0.5); }
	}
`

// ── Compact key/value row ─────────────────────────────────────────────

function Row({ label, value, mono = true }: { label: string; value?: string; mono?: boolean }) {
	if (!value) return null
	return (
		<Flex gap="3" w="100%" align="flex-start">
			<Text fontSize="2xs" color="kk.textMuted" flexShrink={0} minW="60px" pt="0.5">
				{label}
			</Text>
			<Text
				fontSize="2xs"
				color="kk.textPrimary"
				fontFamily={mono ? "mono" : "inherit"}
				wordBreak="break-all"
				flex="1"
			>
				{value}
			</Text>
		</Flex>
	)
}

// ── Trust badge (inline) ──────────────────────────────────────────────

function TrustBadge({ level, hasSigned, t }: { level: 'verified' | 'known' | 'unknown'; hasSigned?: boolean; t: (k: string, f?: string) => string }) {
	const cfg = level === 'verified'
		? { bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.3)", color: "#22C55E", label: hasSigned ? t("signing.signedVerified", "Signed & Verified") : t("signing.verified", "Verified Contract") }
		: level === 'known'
			? { bg: "rgba(192,168,96,0.12)", border: "rgba(192,168,96,0.3)", color: "#C0A860", label: t("signing.knownPattern", "Known Pattern") }
			: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)", color: "#EF4444", label: t("signing.unverifiedContract", "Unverified Contract") }

	return (
		<Flex
			align="center" gap="1.5" px="3" py="1" borderRadius="full"
			bg={cfg.bg} border="1px solid" borderColor={cfg.border}
			css={level === 'unknown' ? { animation: "warningPulse 2s ease-in-out infinite" } : undefined}
		>
			<Box w="8px" h="8px" borderRadius="full" bg={cfg.color} />
			<Text fontSize="2xs" fontWeight="600" color={cfg.color}>{cfg.label}</Text>
		</Flex>
	)
}

// ── Blind signing warning ─────────────────────────────────────────────

function BlindSigningBanner({ enabled, confirming, onEnable, onCancel, t }: {
	enabled: boolean; confirming: boolean; onEnable: () => void; onCancel: () => void; t: (k: string, f?: string) => string
}) {
	if (enabled) return null
	return (
		<Flex
			direction="column" gap="2" w="100%"
			bg="rgba(245,163,59,0.1)" border="1px solid rgba(245,163,59,0.4)"
			borderRadius="lg" px="3" py="2"
		>
			<Flex align="center" gap="2">
				<Box flex="1">
					<Text fontSize="2xs" fontWeight="600" color="#F5A33B">
						{t("signing.blindSigningRequired", "Blind Signing Required")}
					</Text>
					<Text fontSize="2xs" color="kk.textSecondary">
						{confirming
							? t("signing.advancedModeWarning", "This permanently enables blind signing for ALL future transactions on this device. You can disable it later in Settings.")
							: t("signing.blindSigningDescription", "Enable Advanced Mode on device to sign unverified contract data.")}
					</Text>
				</Box>
				{!confirming && (
					<Box
						as="button" px="3" py="1" borderRadius="full"
						bg="rgba(245,163,59,0.2)" color="#F5A33B" fontSize="2xs" fontWeight="600"
						cursor="pointer" _hover={{ bg: "rgba(245,163,59,0.35)" }}
						flexShrink={0} onClick={onEnable}
					>
						{t("signing.enableNow", "Enable")}
					</Box>
				)}
			</Flex>
			{confirming && (
				<Flex gap="2" justify="flex-end">
					<Box
						as="button" px="3" py="1" borderRadius="full"
						bg="transparent" color="kk.textSecondary" fontSize="2xs" fontWeight="600"
						cursor="pointer" border="1px solid" borderColor="kk.border"
						_hover={{ color: "white" }}
						onClick={onCancel}
					>
						{t("signing.cancel", "Cancel")}
					</Box>
					<Box
						as="button" px="3" py="1" borderRadius="full"
						bg="rgba(229,62,62,0.3)" color="#F56565" fontSize="2xs" fontWeight="600"
						cursor="pointer" _hover={{ bg: "rgba(229,62,62,0.5)" }}
						onClick={onEnable}
					>
						{t("signing.confirmEnable", "Yes, enable permanently")}
					</Box>
				</Flex>
			)}
		</Flex>
	)
}

// ── Solana clear-sign failure warning ─────────────────────────────────
//
// Shown whenever a /solana/sign-transaction request arrives but the Vault
// could not decode it (malformed wire layout, unsupported message version,
// ALT RPC outage, etc.). The point is to never silently downgrade a Solana
// approval to the generic "simple transfer" view — the user must see that
// clear-signing failed and is knowingly approving an opaque payload.
function SolanaDecodeFailureBanner({
	error, t,
}: { error?: string; t: (k: string, f?: string) => string }) {
	return (
		<Flex
			direction="column" gap="1" w="100%"
			bg="rgba(239,68,68,0.1)" border="1px solid rgba(239,68,68,0.4)"
			borderRadius="lg" px="3" py="2"
		>
			<Text fontSize="2xs" fontWeight="600" color="#EF4444">
				{t("signing.solanaDecodeFailedTitle", "Clear-Signing Unavailable")}
			</Text>
			<Text fontSize="2xs" color="kk.textSecondary">
				{t(
					"signing.solanaDecodeFailedDescription",
					"The Vault could not decode this Solana transaction for preview. Approving will sign an opaque message — verify the details on your KeepKey screen before confirming.",
				)}
			</Text>
			{error && (
				<Text fontSize="2xs" color="kk.textMuted" fontFamily="mono">
					{error}
				</Text>
			)}
		</Flex>
	)
}

// ── Collapsible raw payload viewer ────────────────────────────────────

function RawPayload({ data, label }: { data: unknown; label: string }) {
	const [open, setOpen] = useState(false)
	if (!data) return null
	const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
	return (
		<VStack gap="0" w="100%">
			<Flex
				as="button" w="100%" justify="space-between" align="center"
				px="3" py="1.5" bg="rgba(0,0,0,0.2)" borderRadius={open ? "lg lg 0 0" : "lg"}
				cursor="pointer" onClick={() => setOpen(!open)} _hover={{ bg: "rgba(0,0,0,0.3)" }}
			>
				<Text fontSize="2xs" color="kk.textMuted" fontWeight="500">{label}</Text>
				<Text fontSize="2xs" color="kk.textMuted">{open ? "\u25B2" : "\u25BC"}</Text>
			</Flex>
			{open && (
				<Box
					w="100%" bg="rgba(0,0,0,0.4)" borderRadius="0 0 lg lg"
					px="3" py="2" maxH="200px" overflowY="auto"
				>
					<Text fontSize="2xs" fontFamily="mono" color="kk.textSecondary" whiteSpace="pre-wrap" wordBreak="break-all">
						{jsonStr}
					</Text>
				</Box>
			)}
		</VStack>
	)
}

// ── Calldata decoded section ──────────────────────────────────────────

function CalldataSection({ decoded, t }: { decoded: CalldataDecodedInfo; t: (k: string, f?: string) => string }) {
	return (
		<VStack gap="1.5" w="100%" bg="rgba(0,0,0,0.25)" borderRadius="xl" p="3">
			<Flex gap="2" align="center" w="100%">
				<Text fontSize="2xs" fontWeight="700" color="kk.gold">
					{decoded.dappName}
				</Text>
				<Text fontSize="2xs" px="2" py="0.5" borderRadius="full" bg="rgba(192,168,96,0.15)" color="kk.gold" fontWeight="500">
					{decoded.method}
				</Text>
			</Flex>
			{decoded.fields.map((field, i) => (
				<Row key={i} label={field.name} value={field.value} />
			))}
			{decoded.functionType && (
				<Text fontSize="2xs" color="kk.textMuted" alignSelf="flex-start">
					{t("signing.functionType", "Type")}: {decoded.functionType}
				</Text>
			)}
		</VStack>
	)
}

// ── Solana decoded section ────────────────────────────────────────────

function shortenPubkey(pk: string): string {
	if (!pk || pk.length <= 12) return pk
	return pk.slice(0, 4) + '…' + pk.slice(-4)
}

/** Render a decoded arg value with modest formatting for common types. */
function formatArgValue(arg: { type: string; value: string }): string {
	if (arg.type === 'pubkey') return shortenPubkey(arg.value)
	if ((arg.type === 'string' || arg.type === 'bytes') && arg.value.length > 60) {
		return arg.value.slice(0, 60) + '…'
	}
	return arg.value
}

function SolanaDecodedSection({ decoded, t }: { decoded: SolanaTxDecodedInfo; t: (k: string, f?: string) => string }) {
	return (
		<VStack gap="2" w="100%" bg="rgba(0,0,0,0.25)" borderRadius="xl" p="3" align="stretch">
			<Flex gap="2" align="center" w="100%">
				<Text fontSize="2xs" fontWeight="700" color="kk.gold">
					{t("signing.solanaTx", "Solana Transaction")}
				</Text>
				<Text fontSize="2xs" px="2" py="0.5" borderRadius="full" bg="rgba(192,168,96,0.15)" color="kk.gold" fontWeight="500">
					{decoded.version}
				</Text>
				<Text fontSize="2xs" color="kk.textMuted">
					{decoded.instructions.length} {decoded.instructions.length === 1 ? 'instruction' : 'instructions'}
				</Text>
			</Flex>

			{decoded.hasUnknownProgram && (
				<Text fontSize="2xs" color="orange.300" bg="rgba(255,140,0,0.1)" px="2" py="1" borderRadius="md">
					⚠ {t("signing.solanaUnknownProgram", "Contains instructions from programs the Vault can't clear-sign.")}
				</Text>
			)}
			{decoded.altResolutionIncomplete && (
				<Text fontSize="2xs" color="orange.300" bg="rgba(255,140,0,0.1)" px="2" py="1" borderRadius="md">
					⚠ {t("signing.solanaAltIncomplete", "Some address lookup tables couldn't be resolved — account names may be missing.")}
				</Text>
			)}

			{decoded.instructions.map((ix, i) => (
				<Box key={i} borderTop="1px solid" borderColor="rgba(255,255,255,0.08)" pt="2" _first={{ borderTop: 'none', pt: 0 }}>
					<Flex gap="2" align="center" w="100%" mb="1">
						<Text fontSize="2xs" fontWeight="600" color={ix.status === 'known' ? 'kk.gold' : 'kk.textSecondary'}>
							#{i + 1} {ix.programName}
						</Text>
						{ix.instructionName && (
							<Text fontSize="2xs" px="1.5" py="0.5" borderRadius="full" bg="rgba(255,255,255,0.08)" color="white">
								{ix.instructionName}
							</Text>
						)}
						{ix.programCategory && (
							<Text fontSize="2xs" color="kk.textMuted">
								{ix.programCategory}
							</Text>
						)}
					</Flex>
					{ix.args.length > 0 && ix.args.map((arg, ai) => (
						<Row key={ai} label={arg.name} value={formatArgValue(arg)} />
					))}
					{ix.accounts.length > 0 && (
						<Box pt="1">
							{ix.accounts.map((acct, ai) => (
								<Row
									key={ai}
									label={acct.label ?? `account[${ai}]`}
									value={shortenPubkey(acct.pubkey)}
								/>
							))}
						</Box>
					)}
					{ix.note && (
						<Text fontSize="2xs" color="kk.textMuted" mt="1">⚠ {ix.note}</Text>
					)}
				</Box>
			))}

			{decoded.altPubkeys.length > 0 && (
				<Box borderTop="1px solid" borderColor="rgba(255,255,255,0.08)" pt="2">
					<Text fontSize="2xs" fontWeight="600" color="kk.textSecondary" mb="1">
						{t("signing.solanaAlts", "Address Lookup Tables")}
					</Text>
					{decoded.altPubkeys.map((pk) => (
						<Row key={pk} label="ALT" value={shortenPubkey(pk)} />
					))}
				</Box>
			)}
		</VStack>
	)
}

// ── EIP-191 personal_sign section ─────────────────────────────────────
//
// /eth/sign receives a hex-encoded message. The wire format is opaque —
// showing raw hex alone means the user can't meaningfully consent to what
// they're signing. This section renders the UTF-8 decoding prominently
// (it's almost always a SIWE login challenge or similar text) and keeps
// the raw hex as a collapsed fallback for hash verification.
function EthMessageSection({ decoded, t }: {
	decoded: EthMessageDecodedInfo; t: (k: string, f?: string) => string
}) {
	const [showHex, setShowHex] = useState(!decoded.isUtf8Text)
	return (
		<VStack gap="1.5" w="100%" bg="rgba(0,0,0,0.25)" borderRadius="xl" p="3" align="stretch">
			<Flex gap="2" align="center">
				<Text fontSize="2xs" fontWeight="700" color="kk.gold">
					{t("signing.ethPersonalSign", "Message to Sign")}
				</Text>
				<Text fontSize="2xs" px="2" py="0.5" borderRadius="full" bg="rgba(192,168,96,0.15)" color="kk.gold" fontWeight="500">
					EIP-191
				</Text>
			</Flex>
			<Row label="Signer" value={decoded.address} />
			{decoded.isUtf8Text && decoded.messageText !== undefined ? (
				<Box
					bg="rgba(0,0,0,0.35)" borderRadius="lg"
					p="2" maxH="240px" overflowY="auto"
				>
					<Text fontSize="xs" color="kk.textPrimary" whiteSpace="pre-wrap" wordBreak="break-word">
						{decoded.messageText}
					</Text>
				</Box>
			) : (
				<Text fontSize="2xs" color="orange.300" bg="rgba(255,140,0,0.1)" px="2" py="1" borderRadius="md">
					{t(
						"signing.ethMessageNotUtf8",
						"Message is not valid UTF-8 — shown below as raw hex. Verify byte-for-byte before approving.",
					)}
				</Text>
			)}
			<Flex
				as="button" justify="space-between" align="center"
				onClick={() => setShowHex((s) => !s)} cursor="pointer"
				fontSize="2xs" color="kk.textMuted" py="1"
				_hover={{ color: "kk.textSecondary" }}
			>
				<Text fontSize="2xs">{t("signing.ethMessageHex", "Raw hex")}</Text>
				<Text fontSize="2xs">{showHex ? "▲" : "▼"}</Text>
			</Flex>
			{showHex && (
				<Box bg="rgba(0,0,0,0.35)" borderRadius="lg" p="2" maxH="200px" overflowY="auto">
					<Text fontSize="2xs" fontFamily="mono" color="kk.textSecondary" whiteSpace="pre-wrap" wordBreak="break-all">
						{decoded.messageRaw || "(empty)"}
					</Text>
				</Box>
			)}
		</VStack>
	)
}

// ── Typed data section ────────────────────────────────────────────────

function TypedDataSection({ decoded, t }: { decoded: EIP712DecodedInfo; t: (k: string, f?: string) => string }) {
	return (
		<VStack gap="1.5" w="100%" bg="rgba(0,0,0,0.25)" borderRadius="xl" p="3">
			<Text fontSize="2xs" fontWeight="600" color={decoded.isKnownType ? "kk.gold" : "kk.textSecondary"}>
				{decoded.operationName}
			</Text>
			{decoded.domain.name && <Row label="Domain" value={decoded.domain.name} />}
			{decoded.domain.verifyingContract && <Row label="Contract" value={decoded.domain.verifyingContract} />}
			{decoded.domain.chainId !== undefined && <Row label="Chain ID" value={String(decoded.domain.chainId)} />}
			{decoded.fields.map((field, i) => (
				<Row key={i} label={field.label} value={field.value} />
			))}
		</VStack>
	)
}

// ═══════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════

export function SigningApproval({ request, phase, onApprove, onReject }: SigningApprovalProps) {
	const { t } = useTranslation("device")
	const [elapsed, setElapsed] = useState(0)
	const [advancedModeEnabled, setAdvancedModeEnabled] = useState(request.advancedModeEnabled ?? false)
	const [enablingPolicy, setEnablingPolicy] = useState(false)

	// Only show blind-signing warnings on firmware 7.14.0+
	const fwSupportsBlindSignGate = request.firmwareVersion
		? versionCompare(request.firmwareVersion, '7.14.0') >= 0
		: false

	const decoded = request.calldataDecoded
	const hasCalldata = fwSupportsBlindSignGate
		&& (request.needsBlindSigning !== undefined || (decoded && decoded.source !== undefined))
	const hasSignedBlob = !!decoded?.signedInsightBlob

	let trustLevel: 'verified' | 'known' | 'unknown' = 'verified'
	if (hasCalldata) {
		if (hasSignedBlob) trustLevel = 'verified'
		else if (decoded?.source === 'pioneer') trustLevel = 'known'
		else if (decoded?.source === 'local') trustLevel = 'known'
		else if (request.needsBlindSigning) trustLevel = 'unknown'
	}
	if (request.typedDataDecoded) {
		trustLevel = request.typedDataDecoded.isKnownType ? 'verified' : 'known'
	}

	// Solana is never a "simple transfer" — the signing payload is an opaque
	// binary message that the user cannot meaningfully inspect without the
	// clear-sign preview. Hiding the trust badge + warnings when
	// solanaDecoded is missing would silently downgrade the approval UX.
	//
	// But only /solana/sign-transaction has a clear-sign preview — a plain
	// /solana/sign-message is inherently an opaque signed message with no
	// "tx decode" step. Showing a "Clear-Signing Unavailable" banner there
	// would be a false-positive warning about a preview that never exists.
	const isSolanaSignTx = request.method === '/solana/sign-transaction'
	const isSolanaRequest =
		isSolanaSignTx ||
		request.method === '/solana/sign-message' ||
		request.chain === 'solana'
	const isSimpleTransfer =
		!hasCalldata && !request.typedDataDecoded && !request.ethMessageDecoded && !isSolanaRequest
	const blindSigningWarning = fwSupportsBlindSignGate && request.needsBlindSigning && !advancedModeEnabled

	const [showAdvancedConfirm, setShowAdvancedConfirm] = useState(false)

	const handleEnableAdvancedMode = useCallback(async () => {
		if (!showAdvancedConfirm) {
			setShowAdvancedConfirm(true)
			return
		}
		setEnablingPolicy(true)
		try {
			await rpcRequest("applyPolicy", { policyName: "AdvancedMode", enabled: true }, 60000)
			setAdvancedModeEnabled(true)
		} catch (e: any) {
			console.error("Failed to enable AdvancedMode:", e)
		}
		setEnablingPolicy(false)
		setShowAdvancedConfirm(false)
	}, [showAdvancedConfirm])

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Enter" && phase === 'approve') { e.preventDefault(); onApprove() }
			if (e.key === "Escape" && phase === 'approve') { e.preventDefault(); onReject() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [onApprove, onReject, phase])

	useEffect(() => {
		if (phase !== 'approve') return
		const iv = setInterval(() => setElapsed((s) => s + 1), 1000)
		return () => clearInterval(iv)
	}, [phase])

	const safeAppName = (request.appName || 'Unknown').replace(/[^\w\s\-.:()]/g, '').slice(0, 50)
	const labelKey = METHOD_LABEL_KEYS[request.method]
	const methodLabel = labelKey ? t(labelKey) : request.method
	const remaining = Math.max(0, 120 - elapsed)
	const timeStr = `${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, "0")}`

	// ── Device-confirm phase ──────────────────────────────────────────
	if (phase === 'device-confirm') {
		return (
			<Box
				position="fixed" inset="0" zIndex={Z.overlay + 1}
				bg="rgba(0,0,0,0.85)" backdropFilter="blur(8px)"
				display="flex" alignItems="center" justifyContent="center"
			>
				<style>{SIGNING_ANIMATIONS}</style>
				<VStack
					bg="kk.cardBg" border="2px solid" borderColor="kk.gold" borderRadius="2xl"
					p="8" gap="5" maxW="400px" w="90vw" textAlign="center"
					css={{ animation: "signingCardIn 0.3s ease-out, signingPulseGlow 2s ease-in-out infinite 0.3s" }}
				>
					<Flex justify="center">
						<Box
							w="64px" h="64px" borderRadius="2xl"
							bg="rgba(192,168,96,0.15)" border="2px solid" borderColor="kk.gold"
							display="flex" alignItems="center" justifyContent="center"
							css={{ animation: "signingBadgePulse 1.5s ease-in-out infinite" }}
						>
							<svg width="32" height="32" viewBox="0 0 24 24" fill="none">
								<rect x="6" y="2" width="12" height="20" rx="2" stroke="#C0A860" strokeWidth="2" />
								<circle cx="12" cy="16" r="2" fill="#C0A860" />
								<rect x="9" y="5" width="6" height="6" rx="1" fill="rgba(192,168,96,0.3)" />
							</svg>
						</Box>
					</Flex>
					<VStack gap="2">
						<Text fontSize="lg" fontWeight="700" color="white">
							{t("signing.confirmOnDevice", "Confirm on your KeepKey")}
						</Text>
						<Text fontSize="sm" color="kk.textSecondary" lineHeight="tall">
							{t("signing.confirmOnDeviceDescription", "Check your KeepKey screen and press the button to approve the transaction.")}
						</Text>
					</VStack>
					<Text fontSize="xs" fontWeight="600" px="3" py="1" borderRadius="full" bg="rgba(192,168,96,0.12)" color="kk.gold">
						{methodLabel}
					</Text>
					<Flex gap="2" justify="center" align="center">
						{[0, 1, 2].map((i) => (
							<Box key={i} w="8px" h="8px" borderRadius="full" bg="kk.gold"
								css={{ animation: `signingBadgePulse 1.2s ease-in-out infinite ${i * 0.2}s` }}
							/>
						))}
					</Flex>
				</VStack>
			</Box>
		)
	}

	// ── Approve phase ─────────────────────────────────────────────────
	return (
		<Box
			position="fixed" inset="0" zIndex={Z.overlay + 1}
			bg="rgba(0,0,0,0.85)" backdropFilter="blur(8px)"
			display="flex" alignItems="center" justifyContent="center"
			css={{ animation: "signingOverlayIn 0.25s ease-out" }}
		>
			<style>{SIGNING_ANIMATIONS}</style>
			<VStack
				bg="kk.cardBg" border="2px solid"
				borderColor={blindSigningWarning ? "rgba(245,163,59,0.6)" : "kk.gold"}
				borderRadius="2xl" p="6" gap="3"
				maxW="640px" w="95vw" maxH="90vh" overflowY="auto"
				css={{ animation: "signingCardIn 0.3s ease-out, signingPulseGlow 2s ease-in-out infinite 0.3s" }}
			>
				{/* ── Header row: badge + app + method + timer + trust ── */}
				<Flex w="100%" justify="space-between" align="center" flexWrap="wrap" gap="2">
					<Flex align="center" gap="2">
						<Text fontSize="xs" fontWeight="700" color="kk.gold" textTransform="uppercase" letterSpacing="wider"
							css={{ animation: "signingBadgePulse 1.5s ease-in-out infinite" }}
						>
							{t("signing.actionRequired", "Action Required")}
						</Text>
						<Flex bg="rgba(192,168,96,0.12)" px="2" py="0.5" borderRadius="full" align="center" gap="1.5">
							<Box w="5px" h="5px" borderRadius="full" bg="kk.gold" />
							<Text fontSize="2xs" fontWeight="500" color="kk.gold">{safeAppName}</Text>
						</Flex>
					</Flex>
					<Flex align="center" gap="2">
						{!isSimpleTransfer && (
							<TrustBadge level={trustLevel} hasSigned={hasSignedBlob} t={t} />
						)}
						<Text fontSize="2xs" color={remaining <= 30 ? "red.400" : "kk.textMuted"} fontWeight={remaining <= 30 ? "600" : "400"}>
							{timeStr}
						</Text>
					</Flex>
				</Flex>

				{/* ── Method ── */}
				<Text fontSize="sm" fontWeight="600" color="white">{methodLabel}</Text>

				{/* ── Blind signing warning (firmware 7.14.0+ only) ── */}
				{fwSupportsBlindSignGate && request.needsBlindSigning && (
					<BlindSigningBanner enabled={advancedModeEnabled} confirming={showAdvancedConfirm} onEnable={handleEnableAdvancedMode} onCancel={() => setShowAdvancedConfirm(false)} t={t} />
				)}

				{/* ── Solana clear-sign failure warning (tx-only — sign-message has no preview by design) ── */}
				{isSolanaSignTx && !request.solanaDecoded && (
					<SolanaDecodeFailureBanner error={request.solanaDecodeError} t={t} />
				)}

				{/* ── Two-column: decoded info (left) + tx details (right) ── */}
				<Flex w="100%" gap="3" direction={{ base: "column", sm: "row" }}>
					{/* Left: decoded calldata, typed data, Solana tx, or EIP-191 message */}
					{(request.solanaDecoded || request.typedDataDecoded || request.ethMessageDecoded || (decoded && decoded.source !== 'none')) && (
						<Box flex="1" minW="0">
							{request.solanaDecoded
								? <SolanaDecodedSection decoded={request.solanaDecoded} t={t} />
								: request.typedDataDecoded
									? <TypedDataSection decoded={request.typedDataDecoded} t={t} />
									: request.ethMessageDecoded
										? <EthMessageSection decoded={request.ethMessageDecoded} t={t} />
										: decoded && decoded.source !== 'none' && <CalldataSection decoded={decoded} t={t} />
							}
						</Box>
					)}

					{/* Right: transaction fields */}
					{!request.typedDataDecoded && !request.solanaDecoded && !request.ethMessageDecoded && (
						<Box flex="1" minW="0">
							<VStack gap="1.5" w="100%" bg="rgba(0,0,0,0.25)" borderRadius="xl" p="3">
								<Text fontSize="2xs" fontWeight="600" color="kk.textSecondary" alignSelf="flex-start">
									Transaction
								</Text>
								<Row label="Chain" value={request.chain?.toUpperCase()} />
								<Row label="From" value={request.from} />
								<Row label="To" value={request.to} />
								<Row label="Value" value={request.value} />
								{request.chainId !== undefined && <Row label="ChainID" value={String(request.chainId)} />}
								{request.data && (!decoded || decoded.source === 'none') && (
									<Row label="Data" value={request.data} />
								)}
							</VStack>
						</Box>
					)}
				</Flex>

				{/* ── Full raw payload (collapsible) ── */}
				<RawPayload data={request.rawRequestBody} label="Full Request Payload" />

				{/* ── Action buttons ── */}
				<Flex gap="3" w="100%">
					<Button
						flex="1" bg="kk.gold"
						color="black" fontWeight="600" size="md"
						_hover={{ bg: "kk.goldHover" }}
						onClick={onApprove} disabled={enablingPolicy}
						cursor="pointer"
					>
						{t("signing.approve")}
					</Button>
					<Button
						flex="1" variant="ghost" color="kk.textSecondary"
						border="1px solid" borderColor="kk.border" size="md"
						_hover={{ color: "white", borderColor: "kk.textSecondary" }}
						onClick={onReject}
					>
						{t("signing.reject")}
					</Button>
				</Flex>

				<Text fontSize="2xs" color="kk.textMuted">
					{t("signing.keyboardHint")}
				</Text>
			</VStack>
		</Box>
	)
}
