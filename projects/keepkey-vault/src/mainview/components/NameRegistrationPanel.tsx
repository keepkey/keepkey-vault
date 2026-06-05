import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Button, Flex, HStack, IconButton, Input, Spinner, Text, VStack, Badge } from "@chakra-ui/react"
import { FaTag, FaExternalLinkAlt, FaCopy, FaCheck } from "react-icons/fa"
import { useTranslation } from "react-i18next"
import type { ChainDef } from "../../shared/chains"
import type { BuildTxResult, BroadcastResult, NameInfo, NameQuote } from "../../shared/types"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"

interface NameRegistrationPanelProps {
	chain: ChainDef
	address: string | null
	availableBalance: string
	watchOnly?: boolean
}

type TxPhase = "input" | "built" | "signing" | "signed" | "broadcast"

const NAME_RE = /^[a-zA-Z0-9+_-]{1,30}$/
const YEAR_OPTIONS = [1, 2, 3, 5, 10]

// Native tx fee THOR/Maya charge at the bank layer (outside tx.fee.amount).
// Mirrors the FEES table in bun/txbuilder/cosmos.ts. The account needs the
// registration cost PLUS this fee, so it factors into the affordability check.
const NATIVE_FEE: Record<string, string> = { thorchain: "0.02", mayachain: "0.2" }

function getExplorerTxUrl(chain: ChainDef, txid: string): string | null {
	if (!chain.explorerTxUrl) return null
	return chain.explorerTxUrl.replace("{{txid}}", txid)
}

/** Format a base-unit bigint to a trimmed decimal string. */
function formatBase(base: bigint, decimals: number): string {
	const neg = base < 0n
	const s = (neg ? -base : base).toString().padStart(decimals + 1, "0")
	const whole = s.slice(0, s.length - decimals)
	const frac = s.slice(s.length - decimals).replace(/0+$/, "")
	return (neg ? "-" : "") + whole + (frac ? "." + frac : "")
}

export function NameRegistrationPanel({ chain, address, availableBalance, watchOnly }: NameRegistrationPanelProps) {
	const { t } = useTranslation("names")

	// Branding: THORChain → "THORName", Maya → "MAYAName".
	const kind = chain.id === "thorchain" ? "THORName" : "MAYAName"

	const [name, setName] = useState("")
	const [years, setYears] = useState(1)
	const [nameInfo, setNameInfo] = useState<NameInfo | null>(null)
	const [checking, setChecking] = useState(false)

	const [quote, setQuote] = useState<NameQuote | null>(null)
	const [quoteError, setQuoteError] = useState<string | null>(null)

	const [phase, setPhase] = useState<TxPhase>("input")
	const [buildResult, setBuildResult] = useState<BuildTxResult | null>(null)
	const [signedTx, setSignedTx] = useState<any>(null)
	const [txid, setTxid] = useState("")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [txidCopied, setTxidCopied] = useState(false)
	const [signStart, setSignStart] = useState<number | null>(null)

	const isValidName = NAME_RE.test(name)

	// Live registration cost constants.
	useEffect(() => {
		let cancelled = false
		setQuote(null)
		setQuoteError(null)
		rpcRequest<NameQuote>("getNameQuote", { chainId: chain.id }, 30000)
			.then((q) => { if (!cancelled) setQuote(q) })
			.catch((e: any) => { if (!cancelled) setQuoteError(e?.message || t("costUnavailable")) })
		return () => { cancelled = true }
	}, [chain.id, t])

	// Debounced availability lookup.
	useEffect(() => {
		if (!isValidName) { setNameInfo(null); setChecking(false); return }
		let cancelled = false
		setChecking(true)
		const handle = setTimeout(() => {
			rpcRequest<NameInfo>("lookupName", { chainId: chain.id, name }, 30000)
				.then((info) => { if (!cancelled) setNameInfo(info) })
				.catch(() => { if (!cancelled) setNameInfo(null) })
				.finally(() => { if (!cancelled) setChecking(false) })
		}, 400)
		return () => { cancelled = true; clearTimeout(handle) }
	}, [name, chain.id, isValidName])

	const costBase = useMemo(() => {
		if (!quote) return null
		try {
			return BigInt(quote.registerFeeBase) + BigInt(quote.feePerBlockBase) * BigInt(quote.blocksPerYear) * BigInt(years)
		} catch { return null }
	}, [quote, years])

	const costDisplay = costBase != null ? formatBase(costBase, chain.decimals) : null

	const nativeFee = NATIVE_FEE[chain.id] || "0"
	// Total the account must hold: registration deposit + the native bank fee.
	const totalCost = costDisplay != null ? (parseFloat(costDisplay) + parseFloat(nativeFee)) : null

	// A name is registerable if it's never been registered, OR its registration
	// has expired — THORChain/Maya both let an expired name be claimed/renewed
	// once the current block passes its expiry.
	const isExpired = !!(nameInfo?.found && quote && nameInfo.expireBlockHeight != null && nameInfo.expireBlockHeight <= quote.currentBlockHeight)
	const isAvailable = nameInfo != null && (nameInfo.found === false || isExpired)

	const hasFunds = totalCost != null && parseFloat(availableBalance || "0") >= totalCost
	const canBuild = !!address && !watchOnly && isValidName && isAvailable && !checking && !!quote && hasFunds

	const resetFlow = useCallback(() => {
		setPhase("input")
		setBuildResult(null)
		setSignedTx(null)
		setTxid("")
		setError(null)
		setLoading(false)
		setTxidCopied(false)
		setSignStart(null)
	}, [])

	const handleBuild = useCallback(async () => {
		if (!canBuild) return
		setLoading(true)
		setError(null)
		try {
			const result = await rpcRequest<BuildTxResult>("buildNameRegistrationTx", {
				chainId: chain.id,
				name,
				years,
			}, 60000)
			setBuildResult(result)
			setPhase("built")
		} catch (e: any) {
			setError(e?.message || t("failedToBuild"))
		}
		setLoading(false)
	}, [canBuild, chain.id, name, years, t])

	const handleSign = useCallback(async () => {
		if (!buildResult || watchOnly) return
		setLoading(true)
		setError(null)
		setPhase("signing")
		setSignStart(Date.now())
		try {
			const result = await rpcRequest(chain.signMethod as any, buildResult.unsignedTx, 120000)
			setSignedTx(result)
			setPhase("signed")
		} catch (e: any) {
			setError(e?.message || t("signingFailed"))
			setPhase("built")
		}
		setLoading(false)
	}, [buildResult, watchOnly, chain.signMethod, t])

	const handleBroadcast = useCallback(async () => {
		if (!signedTx || watchOnly) return
		setLoading(true)
		setError(null)
		try {
			const result = await rpcRequest<BroadcastResult>("broadcastTx", { chainId: chain.id, signedTx }, 60000)
			setTxid(result.txid)
			setPhase("broadcast")
		} catch (e: any) {
			setError(e?.message || t("broadcastFailed"))
		}
		setLoading(false)
	}, [signedTx, watchOnly, chain.id, t])

	const handleOpenExplorer = useCallback((txidValue: string) => {
		const url = getExplorerTxUrl(chain, txidValue)
		if (!url) return
		rpcRequest("openUrl", { url }).catch((e: any) => console.warn("[openUrl]", e?.message))
	}, [chain])

	const handleCopyTxid = useCallback(async (txidValue: string) => {
		try {
			await navigator.clipboard.writeText(txidValue)
			setTxidCopied(true)
			setTimeout(() => setTxidCopied(false), 1500)
		} catch { /* ignore */ }
	}, [])

	return (
		<Box>
			<Flex justify="space-between" align="center" mb="3">
				<HStack gap="2">
					<Box as={FaTag} color="kk.gold" />
					<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{t("title", { kind })}</Text>
				</HStack>
			</Flex>

			<Text fontSize="xs" color="kk.textMuted" mb="3">
				{t("description", { kind, symbol: chain.symbol })}
			</Text>

			{error && (
				<Box p="3" bg="rgba(255,0,0,0.08)" border="1px solid" borderColor="red.500" borderRadius="md" mb="3">
					<Text fontSize="xs" color="red.300">{error}</Text>
				</Box>
			)}

			{phase === "input" && (
				<VStack align="stretch" gap="3">
					<Box>
						<Text fontSize="xs" color="kk.textMuted" mb="1">{t("nameLabel")}</Text>
						<Input
							placeholder={t("namePlaceholder")}
							value={name}
							onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-zA-Z0-9+_-]/g, ""))}
							maxLength={30}
							bg="kk.bg"
							borderColor={!name || isValidName ? "kk.border" : "red.500"}
							color="white"
							fontSize="sm"
							fontFamily="mono"
						/>
						<Flex justify="space-between" align="center" mt="1" minH="16px">
							<Text fontSize="10px" color="kk.textMuted">{t("nameRules")}</Text>
							{name && isValidName && (
								checking ? (
									<HStack gap="1"><Spinner size="xs" color="kk.gold" /><Text fontSize="10px" color="kk.textMuted">{t("checking")}</Text></HStack>
								) : isAvailable ? (
									<Badge colorScheme="green" variant="subtle" fontSize="10px">{t("available")}</Badge>
								) : nameInfo?.found ? (
									<Badge colorScheme="red" variant="subtle" fontSize="10px">{t("taken")}</Badge>
								) : null
							)}
						</Flex>
						{nameInfo?.found && nameInfo.owner && (
							<Text fontSize="10px" color={isExpired ? "kk.gold" : "kk.textMuted"} mt="1" fontFamily="mono" wordBreak="break-all">
								{isExpired ? t("expiredClaimable") : t("ownedBy", { owner: nameInfo.owner })}
								{nameInfo.expireBlockHeight ? ` · ${t("expiresAtBlock", { height: nameInfo.expireBlockHeight })}` : ""}
							</Text>
						)}
					</Box>

					<Box>
						<Text fontSize="xs" color="kk.textMuted" mb="1">{t("duration")}</Text>
						<Box
							as="select"
							w="100%"
							p="2"
							bg="kk.bg"
							border="1px solid"
							borderColor="kk.border"
							borderRadius="md"
							color="white"
							fontSize="sm"
							value={years}
							onChange={(e: any) => setYears(Number(e.target.value))}
						>
							{YEAR_OPTIONS.map((y) => (
								<option key={y} value={y} style={{ background: "#1a1a2e" }}>
									{y} {t("yearsSuffix")}
								</option>
							))}
						</Box>
					</Box>

					<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
						<Flex justify="space-between">
							<Text fontSize="xs" color="kk.textMuted">{t("cost")}</Text>
							{costDisplay != null ? (
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{costDisplay} {chain.symbol}</Text>
							) : (
								<Text fontSize="10px" color="kk.textMuted">{quoteError ? t("costUnavailable") : t("checking")}</Text>
							)}
						</Flex>
						{costDisplay != null && (
							<>
								<Flex justify="space-between" mt="1">
									<Text fontSize="xs" color="kk.textMuted">{t("fee")}</Text>
									<Text fontSize="xs" fontFamily="mono" color="kk.textMuted">{nativeFee} {chain.symbol}</Text>
								</Flex>
								<Flex justify="space-between" mt="1" pt="1" borderTop="1px solid" borderColor="kk.border">
									<Text fontSize="xs" color="kk.textPrimary">{t("total")}</Text>
									<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{totalCost} {chain.symbol}</Text>
								</Flex>
							</>
						)}
						{address && isValidName && (
							<Text fontSize="10px" color="kk.textMuted" mt="2" fontFamily="mono" wordBreak="break-all">
								{t("registersTo", { name, address })}
							</Text>
						)}
						{address && !watchOnly && isAvailable && costDisplay != null && !hasFunds && (
							<Text fontSize="10px" color="red.300" mt="2">
								{t("insufficientFunds", { amount: totalCost, symbol: chain.symbol })}
							</Text>
						)}
					</Box>
				</VStack>
			)}

			{phase !== "input" && (
				<VStack align="stretch" gap="2" mb="3">
					<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
						<HStack justify="space-between">
							<Text fontSize="xs" color="kk.textMuted">{t("summaryName")}</Text>
							<Text fontSize="sm" fontFamily="mono" color="kk.textPrimary">{name}</Text>
						</HStack>
						<HStack justify="space-between" mt="1">
							<Text fontSize="xs" color="kk.textMuted">{t("cost")}</Text>
							<Text fontSize="sm" color="kk.textPrimary">{costDisplay} {chain.symbol}</Text>
						</HStack>
					</Box>
					<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
						<Text fontSize="xs" color="kk.textMuted">{t("fee")}</Text>
						<Text fontSize="sm" color="kk.textPrimary">{buildResult?.fee} {chain.symbol}</Text>
					</Box>
				</VStack>
			)}

			{phase === "signing" && (
				<Box p="3" bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="md" mb="3">
					<Flex align="center" gap="2">
						<Spinner size="xs" color="kk.gold" />
						<Text fontSize="xs" color="kk.textPrimary" fontWeight="600">{t("waitingForDevice")}</Text>
					</Flex>
					<Text fontSize="xs" color="kk.textMuted" mt="1">{t("confirmOnKeepKey")}</Text>
					{signStart && (
						<Text fontSize="10px" color="kk.textMuted" mt="1">
							{t("elapsed", { seconds: Math.max(0, Math.floor((Date.now() - signStart) / 1000)) })}
						</Text>
					)}
				</Box>
			)}

			{phase === "signed" && (
				<Box p="3" bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="md" mb="3">
					<Text fontSize="xs" color="kk.textPrimary" fontWeight="600" mb="1">{t("signedOnDevice")}</Text>
					<Text fontSize="xs" color="kk.textMuted">{t("reviewAndBroadcast")}</Text>
				</Box>
			)}

			{phase === "broadcast" && (
				<Box p="3" bg="rgba(233,196,106,0.08)" border="1px solid" borderColor="rgba(233,196,106,0.3)" borderRadius="md" mb="3">
					<Text fontSize="xs" color="kk.gold" fontWeight="600" mb="1">{t("submitted")}</Text>
					{txid ? (
						<Flex justify="space-between" align="center">
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">{txid}</Text>
							<HStack gap="1">
								<IconButton aria-label={t("copyTxId")} size="xs" variant="ghost" color={txidCopied ? "green.300" : "kk.gold"} onClick={() => handleCopyTxid(txid)}>
									{txidCopied ? <FaCheck /> : <FaCopy />}
								</IconButton>
								{getExplorerTxUrl(chain, txid) && (
									<IconButton aria-label={t("viewTransaction")} size="xs" variant="ghost" color="kk.gold" onClick={() => handleOpenExplorer(txid)}>
										<FaExternalLinkAlt />
									</IconButton>
								)}
							</HStack>
						</Flex>
					) : (
						<Text fontSize="xs" color="kk.textMuted">{t("broadcastedTxidSoon")}</Text>
					)}
				</Box>
			)}

			<Flex justify="flex-end" gap="2" mt="4">
				{phase === "broadcast" ? (
					<Button size="sm" variant="ghost" color="kk.textSecondary" px="4" py="2" onClick={() => { setName(""); setNameInfo(null); resetFlow() }}>
						{t("done", { ns: "common" })}
					</Button>
				) : phase !== "input" ? (
					<Button size="sm" variant="ghost" color="kk.textSecondary" px="4" py="2" onClick={resetFlow}>
						{t("cancel", { ns: "common" })}
					</Button>
				) : null}
				{phase === "input" && (
					<Button size="sm" bg="kk.gold" color="black" px="4" py="2" _hover={{ bg: "kk.goldHover" }} disabled={!canBuild || loading} onClick={handleBuild}>
						{loading ? t("building") : t("registerButton")}
					</Button>
				)}
				{phase === "built" && (
					<Button size="sm" bg="kk.gold" color="black" px="4" py="2" _hover={{ bg: "kk.goldHover" }} disabled={loading || watchOnly} onClick={handleSign}>
						{loading ? t("signing") : t("sign")}
					</Button>
				)}
				{phase === "signing" && (
					<Button size="sm" bg="kk.gold" color="black" px="4" py="2" disabled>{t("signing")}</Button>
				)}
				{phase === "signed" && (
					<Button size="sm" bg="kk.gold" color="black" px="4" py="2" _hover={{ bg: "kk.goldHover" }} disabled={loading || watchOnly} onClick={handleBroadcast}>
						{loading ? t("broadcasting") : t("broadcast")}
					</Button>
				)}
			</Flex>
			{watchOnly && (
				<Text fontSize="xs" color="kk.textMuted" mt="2">{t("connectToRegister")}</Text>
			)}
		</Box>
	)
}
