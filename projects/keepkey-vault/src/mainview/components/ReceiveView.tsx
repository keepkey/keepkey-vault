import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Box, Text, Button, Flex } from "@chakra-ui/react"
import { FaCopy, FaCheck, FaEye, FaSpinner, FaPlus, FaMinus } from "react-icons/fa"
import { generateQRSvg } from "../lib/qr"
import { rpcRequest } from "../lib/rpc"
import { pathToString } from "../lib/bip44"
import { PathEditDialog } from "./PathEditDialog"
import type { ChainDef } from "../../shared/chains"

const MAX_NEW_ADDRESSES_PER_SESSION = 10

interface ReceiveViewProps {
	chain: ChainDef
	address: string | null
	loading: boolean
	error?: string | null
	currentPath: number[]
	onDerive: (path?: number[]) => void
	scriptType?: string
	xpub?: string
	// BTC change/index controls (only passed for Bitcoin)
	isBtc?: boolean
	btcChangeIndex?: 0 | 1
	btcAddressIndex?: number
	onBtcChangeIndex?: (v: 0 | 1) => void
	onBtcAddressIndex?: (v: number) => void
}

function CopyableField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
	const { t } = useTranslation("common")
	const [copied, setCopied] = useState(false)
	const copy = () => {
		navigator.clipboard.writeText(value)
			.then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
			.catch(() => console.warn('[CopyableField] Clipboard not available'))
	}
	return (
		<Box w="100%">
			<Flex align="center" justify="space-between" mb="1">
				<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em" fontWeight="600">{label}</Text>
				<Box
					as="button"
					onClick={copy}
					cursor="pointer"
					color={copied ? "kk.gold" : "kk.textMuted"}
					_hover={{ color: "kk.gold" }}
					transition="color 0.15s"
					display="flex"
					alignItems="center"
					gap="1"
					fontSize="10px"
				>
					<Box as={copied ? FaCheck : FaCopy} fontSize="10px" />
					{copied ? t("copied") : t("copy")}
				</Box>
			</Flex>
			<Box
				bg="kk.bg"
				border="1px solid"
				borderColor="kk.border"
				borderRadius="md"
				px="2.5"
				py="1.5"
				cursor="pointer"
				_hover={{ borderColor: "kk.gold" }}
				transition="border-color 0.15s"
				onClick={copy}
			>
				<Text
					fontSize="11px"
					fontFamily={mono ? "mono" : undefined}
					color="kk.textPrimary"
					wordBreak="break-all"
					lineHeight="1.4"
				>
					{value}
				</Text>
			</Box>
		</Box>
	)
}

export function ReceiveView({
	chain, address, loading, error, currentPath, onDerive, scriptType, xpub,
	isBtc, btcChangeIndex = 0, btcAddressIndex = 0, onBtcChangeIndex, onBtcAddressIndex,
}: ReceiveViewProps) {
	const { t } = useTranslation("receive")
	const [showing, setShowing] = useState(false)
	const [pathDialogOpen, setPathDialogOpen] = useState(false)
	const [newAddressCount, setNewAddressCount] = useState(0)

	const showOnDevice = useCallback(async () => {
		setShowing(true)
		try {
			const params: any = {
				addressNList: currentPath,
				showDisplay: true,
				coin: chain.chainFamily === 'evm' ? 'Ethereum' : chain.coin,
			}
			const st = scriptType || chain.scriptType
			if (st) params.scriptType = st
			await rpcRequest(chain.rpcMethod, params, 60000)
		} catch (e: any) { console.error("showOnDevice:", e) }
		setShowing(false)
	}, [chain, currentPath, scriptType])

	const handlePathApply = useCallback((newPath: number[]) => {
		setPathDialogOpen(false)
		onDerive(newPath)
	}, [onDerive])

	const handleNextAddress = useCallback(() => {
		if (!onBtcAddressIndex || newAddressCount >= MAX_NEW_ADDRESSES_PER_SESSION) return
		onBtcAddressIndex(btcAddressIndex + 1)
		setNewAddressCount(c => c + 1)
	}, [onBtcAddressIndex, btcAddressIndex, newAddressCount])

	const handlePrevAddress = useCallback(() => {
		if (!onBtcAddressIndex || btcAddressIndex <= 0) return
		onBtcAddressIndex(btcAddressIndex - 1)
	}, [onBtcAddressIndex, btcAddressIndex])

	if (!address && !loading) {
		return (
			<Flex direction="column" align="center" py="8" gap="4">
				{error ? (
					<>
						<Text fontSize="sm" color="kk.error">{error}</Text>
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} onClick={() => onDerive()}>
							{t("retry", { ns: "common" })}
						</Button>
					</>
				) : (
					<>
						<Text fontSize="sm" color="kk.textMuted">{t("noAddressDerived")}</Text>
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} onClick={() => onDerive()}>
							{t("deriveAddress")}
						</Button>
					</>
				)}
			</Flex>
		)
	}

	if (loading) {
		return (
			<Flex align="center" justify="center" py="8">
				<Text fontSize="sm" color="kk.textMuted">{t("derivingAddress")}</Text>
			</Flex>
		)
	}

	const qrSvg = generateQRSvg(address!, 4, 2)
	const remaining = MAX_NEW_ADDRESSES_PER_SESSION - newAddressCount

	return (
		<>
			{/* Horizontal layout: QR left, details right */}
			<Flex gap="5" py="3" align="flex-start" direction={{ base: "column", sm: "row" }}>
				{/* Left column: QR + verify */}
				<Flex direction="column" align="center" gap="2" flexShrink={0}>
					<Box
						bg="white"
						borderRadius="lg"
						dangerouslySetInnerHTML={{ __html: qrSvg }}
						w="160px"
						h="160px"
						overflow="hidden"
					/>
					<Button
						size="xs"
						variant="outline"
						borderColor="kk.border"
						color="kk.textSecondary"
						_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
						onClick={showOnDevice}
						disabled={showing}
						display="flex"
						alignItems="center"
						gap="1.5"
						w="160px"
					>
						<Box as={showing ? FaSpinner : FaEye} fontSize="11px" />
						{showing ? t("checkDevice") : t("verifyOnDevice")}
					</Button>
				</Flex>

				{/* Right column: address, xpub, path, controls */}
				<Flex direction="column" gap="3" flex="1" minW="0" w="100%">
					<Text fontSize="xs" color="kk.textMuted">{t("sendToAddress", { symbol: chain.symbol })}</Text>

					{/* BTC: Receive / Change toggle + index */}
					{isBtc && onBtcChangeIndex && (
						<Flex align="center" gap="3" flexWrap="wrap">
							<Flex gap="1" bg="rgba(255,255,255,0.03)" p="1" borderRadius="lg">
								{([
									{ value: 0 as const, label: t("receive") },
									{ value: 1 as const, label: t("change", { ns: "common" }) },
								]).map(opt => (
									<Button
										key={opt.value}
										size="xs"
										variant="ghost"
										color={btcChangeIndex === opt.value ? "kk.gold" : "kk.textSecondary"}
										bg={btcChangeIndex === opt.value ? "rgba(255,215,0,0.1)" : "transparent"}
										_hover={{ bg: "rgba(255,255,255,0.06)" }}
										fontWeight={btcChangeIndex === opt.value ? "600" : "400"}
										fontSize="12px"
										px="4"
										py="1"
										borderRadius="md"
										onClick={() => onBtcChangeIndex(opt.value)}
									>
										{opt.label}
									</Button>
								))}
							</Flex>

							{/* Address index — inline */}
							{onBtcAddressIndex && (
								<Flex align="center" gap="1.5">
									<Text fontSize="10px" color="kk.textMuted">{t("index")}</Text>
									<Box
										as="button"
										onClick={handlePrevAddress}
										disabled={btcAddressIndex <= 0}
										cursor={btcAddressIndex <= 0 ? "not-allowed" : "pointer"}
										opacity={btcAddressIndex <= 0 ? 0.3 : 1}
										color="kk.textSecondary"
										_hover={btcAddressIndex > 0 ? { color: "kk.gold" } : {}}
										transition="color 0.15s"
										display="flex"
										alignItems="center"
										p="0.5"
									>
										<Box as={FaMinus} fontSize="9px" />
									</Box>
									<Box
										bg="kk.bg"
										border="1px solid"
										borderColor="kk.border"
										borderRadius="md"
										px="2"
										py="0.5"
										minW="32px"
										textAlign="center"
									>
										<Text fontSize="xs" fontFamily="mono" fontWeight="600" color="kk.gold">{btcAddressIndex}</Text>
									</Box>
									<Box
										as="button"
										onClick={handleNextAddress}
										disabled={remaining <= 0}
										cursor={remaining <= 0 ? "not-allowed" : "pointer"}
										opacity={remaining <= 0 ? 0.3 : 1}
										color="kk.textSecondary"
										_hover={remaining > 0 ? { color: "kk.gold" } : {}}
										transition="color 0.15s"
										display="flex"
										alignItems="center"
										p="0.5"
									>
										<Box as={FaPlus} fontSize="9px" />
									</Box>
									<Text fontSize="9px" color="kk.textMuted">({t("remaining", { remaining })})</Text>
								</Flex>
							)}
						</Flex>
					)}

					{/* Address — copyable */}
					<CopyableField label={t("address")} value={address!} />

					{/* xpub — copyable (BTC only) */}
					{xpub && (
						<CopyableField label={t("extendedPublicKey")} value={xpub} />
					)}

					{/* Derivation path */}
					<Flex align="center" gap="1.5">
						<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em" fontWeight="600">{t("path")}</Text>
						<Text fontSize="11px" fontFamily="mono" color="kk.textSecondary">
							{pathToString(currentPath)}
						</Text>
						<Box
							as="button"
							onClick={() => setPathDialogOpen(true)}
							cursor="pointer"
							color="kk.textMuted"
							_hover={{ color: "kk.gold" }}
							transition="color 0.15s"
							title={t("editDerivationPath")}
							display="flex"
							alignItems="center"
						>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
							</svg>
						</Box>
					</Flex>
				</Flex>
			</Flex>

			{pathDialogOpen && (
				<PathEditDialog
					path={currentPath}
					onApply={handlePathApply}
					onClose={() => setPathDialogOpen(false)}
				/>
			)}
		</>
	)
}
