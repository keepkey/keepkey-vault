import { useEffect, useState, useCallback } from "react"
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../../lib/z-index"
import { rpcRequest } from "../../lib/rpc"
import type { SigningRequestInfo, EIP712DecodedInfo, CalldataDecodedInfo } from "../../../shared/types"

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

	const decoded = request.calldataDecoded
	const hasCalldata = request.needsBlindSigning !== undefined || (decoded && decoded.source !== undefined)
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

	const isSimpleTransfer = !hasCalldata && !request.typedDataDecoded
	const blindSigningBlocked = request.needsBlindSigning && !advancedModeEnabled

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
			if (e.key === "Enter" && !blindSigningBlocked && phase === 'approve') { e.preventDefault(); onApprove() }
			if (e.key === "Escape" && phase === 'approve') { e.preventDefault(); onReject() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [onApprove, onReject, blindSigningBlocked, phase])

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
				borderColor={blindSigningBlocked ? "rgba(245,163,59,0.6)" : "kk.gold"}
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

				{/* ── Blind signing warning ── */}
				{request.needsBlindSigning && (
					<BlindSigningBanner enabled={advancedModeEnabled} confirming={showAdvancedConfirm} onEnable={handleEnableAdvancedMode} onCancel={() => setShowAdvancedConfirm(false)} t={t} />
				)}

				{/* ── Two-column: decoded info (left) + tx details (right) ── */}
				<Flex w="100%" gap="3" direction={{ base: "column", sm: "row" }}>
					{/* Left: decoded calldata or typed data */}
					{(request.typedDataDecoded || (decoded && decoded.source !== 'none')) && (
						<Box flex="1" minW="0">
							{request.typedDataDecoded
								? <TypedDataSection decoded={request.typedDataDecoded} t={t} />
								: decoded && decoded.source !== 'none' && <CalldataSection decoded={decoded} t={t} />
							}
						</Box>
					)}

					{/* Right: transaction fields */}
					{!request.typedDataDecoded && (
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
						flex="1" bg={blindSigningBlocked ? "rgba(192,168,96,0.3)" : "kk.gold"}
						color={blindSigningBlocked ? "kk.textSecondary" : "black"} fontWeight="600" size="md"
						_hover={blindSigningBlocked ? {} : { bg: "kk.goldHover" }}
						onClick={onApprove} disabled={blindSigningBlocked || enablingPolicy}
						cursor={blindSigningBlocked ? "not-allowed" : "pointer"}
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
					{blindSigningBlocked
						? t("signing.enableAdvancedModeHint", "Enable Advanced Mode above to unlock signing")
						: t("signing.keyboardHint")
					}
				</Text>
			</VStack>
		</Box>
	)
}
