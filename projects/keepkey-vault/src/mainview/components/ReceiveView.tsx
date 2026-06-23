import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Box, Text, Flex } from "@chakra-ui/react"
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
	// TON bounceable toggle
	isTon?: boolean
	tonBounceable?: boolean
	onTonBounceableChange?: (bounceable: boolean) => void
	// Watch-only: no device — hide device-required actions (verify-on-device, derive/retry).
	watchOnly?: boolean
}

/** Eyebrow + ink-0 mono block + copy chip on the right.
 *  Click anywhere on the block (or the chip) to copy. */
function CopyableField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
	const { t } = useTranslation("common")
	const [copied, setCopied] = useState(false)
	const copy = () => {
		navigator.clipboard.writeText(value)
			.then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
			.catch(() => console.warn('[CopyableField] Clipboard not available'))
	}
	return (
		<Box w="100%">
			<Flex align="center" justify="space-between" mb="2">
				<Text
					fontSize="10px"
					color="var(--text-3)"
					textTransform="uppercase"
					letterSpacing="0.18em"
					fontWeight="500"
				>
					{label}
				</Text>
				<Box
					as="button"
					onClick={copy}
					cursor="pointer"
					color={copied ? "var(--teal)" : "var(--text-2)"}
					_hover={{ color: copied ? "var(--teal)" : "var(--text-0)" }}
					transition="color 0.15s"
					display="flex"
					alignItems="center"
					gap="1.5"
					fontSize="11px"
					letterSpacing="0.04em"
					textTransform="uppercase"
					fontFamily="mono"
					className="electrobun-webkit-app-region-no-drag"
				>
					<Box as={copied ? FaCheck : FaCopy} fontSize="10px" />
					{copied ? t("copied") : t("copy")}
				</Box>
			</Flex>
			<Box
				as="button"
				onClick={copy}
				w="100%"
				textAlign="left"
				bg="var(--ink-0)"
				border="1px solid var(--line)"
				borderRadius="12px"
				px="3.5"
				py="3"
				cursor="pointer"
				_hover={{ borderColor: "var(--line-2)" }}
				transition="border-color 0.15s"
				className="electrobun-webkit-app-region-no-drag"
			>
				<Text
					fontSize="13px"
					fontFamily={mono ? "mono" : undefined}
					color="var(--text-0)"
					wordBreak="break-all"
					lineHeight="1.5"
					letterSpacing="0.02em"
				>
					{value}
				</Text>
			</Box>
		</Box>
	)
}

/** Inline pill toggle — used for BTC receive/change and TON bounceable controls. */
function PillToggle<T extends string | number>({
	options, value, onChange,
}: {
	options: ReadonlyArray<{ value: T; label: string }>
	value: T
	onChange: (v: T) => void
}) {
	return (
		<Flex gap="2px" bg="var(--ink-0)" border="1px solid var(--line)" p="2px" borderRadius="999px">
			{options.map(opt => {
				const isActive = value === opt.value
				return (
					<Box
						key={String(opt.value)}
						as="button"
						className="electrobun-webkit-app-region-no-drag"
						onClick={() => onChange(opt.value)}
						px="3.5"
						py="1.5"
						borderRadius="999px"
						fontSize="11px"
						fontWeight="500"
						letterSpacing="-0.005em"
						color={isActive ? "var(--ink-0)" : "var(--text-2)"}
						bg={isActive ? "var(--gold)" : "transparent"}
						_hover={isActive ? {} : { color: "var(--text-0)", bg: "var(--ink-3)" }}
						transition="all 0.18s"
						cursor="pointer"
					>
						{opt.label}
					</Box>
				)
			})}
		</Flex>
	)
}

export function ReceiveView({
	chain, address, loading, error, currentPath, onDerive, scriptType, xpub,
	isBtc, btcChangeIndex = 0, btcAddressIndex = 0, onBtcChangeIndex, onBtcAddressIndex,
	isTon, tonBounceable = false, onTonBounceableChange, watchOnly = false,
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
			if (isTon) params.bounceable = tonBounceable
			await rpcRequest(chain.rpcMethod, params, 60000)
		} catch (e: any) { console.error("showOnDevice:", e) }
		setShowing(false)
	}, [chain, currentPath, scriptType, isTon, tonBounceable])

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
		// Watch-only with no cached address: the device isn't here to derive one, so
		// the retry/derive buttons would only re-fail. Show a plain explanation instead.
		if (watchOnly) {
			return (
				<Flex direction="column" align="center" py="10" gap="4">
					<Text fontSize="13px" color="var(--text-2)" letterSpacing="-0.005em">{t("watchOnlyNoAddress")}</Text>
				</Flex>
			)
		}
		return (
			<Flex direction="column" align="center" py="10" gap="4">
				{error ? (
					<>
						<Text fontSize="13px" color="var(--rose)" letterSpacing="-0.005em">{error}</Text>
						<Box
							as="button"
							className="electrobun-webkit-app-region-no-drag"
							onClick={() => onDerive()}
							bg="var(--gold)"
							color="var(--ink-0)"
							fontWeight="600"
							fontSize="13px"
							px="5"
							py="2.5"
							borderRadius="12px"
							cursor="pointer"
							_hover={{ bg: "var(--gold-2)" }}
							transition="all 0.18s"
						>
							{t("retry", { ns: "common" })}
						</Box>
					</>
				) : (
					<>
						<Text fontSize="13px" color="var(--text-2)" letterSpacing="-0.005em">{t("noAddressDerived")}</Text>
						<Box
							as="button"
							className="electrobun-webkit-app-region-no-drag"
							onClick={() => onDerive()}
							bg="var(--gold)"
							color="var(--ink-0)"
							fontWeight="600"
							fontSize="13px"
							px="5"
							py="2.5"
							borderRadius="12px"
							cursor="pointer"
							_hover={{ bg: "var(--gold-2)" }}
							transition="all 0.18s"
						>
							{t("deriveAddress")}
						</Box>
					</>
				)}
			</Flex>
		)
	}

	if (loading) {
		return (
			<Flex align="center" justify="center" py="10" gap="2">
				<Box as={FaSpinner} fontSize="12px" color="var(--gold)" style={{ animation: "v3-spin 1s linear infinite" }} />
				<Text fontSize="12px" color="var(--text-2)" letterSpacing="-0.005em">{t("derivingAddress")}</Text>
			</Flex>
		)
	}

	// EIP-681 URI for EVM chains so mobile wallets (Rainbow, etc.) auto-detect send
	const qrContent = chain.chainFamily === 'evm' && chain.chainId
		? `ethereum:${address!}@${chain.chainId}`
		: chain.chainFamily === 'solana'
			? `solana:${address!}`
			: address!
	const qrSvg = generateQRSvg(qrContent, 4, 2)
	const remaining = MAX_NEW_ADDRESSES_PER_SESSION - newAddressCount

	return (
		<>
			<Flex gap={{ base: "5", md: "8" }} py="2" align="flex-start" direction={{ base: "column", sm: "row" }}>
				{/* Left column: framed QR + verify chip */}
				<Flex direction="column" align="center" gap="3" flexShrink={0}>
					<Box
						bg="white"
						borderRadius="12px"
						p="3"
						boxShadow="var(--shadow-2)"
						w="184px"
						h="184px"
					>
						<Box
							w="100%"
							h="100%"
							dangerouslySetInnerHTML={{ __html: qrSvg }}
							sx={{ '& svg': { width: '100%', height: '100%', display: 'block' } }}
						/>
					</Box>
					{/* Verify-on-device requires the device — hidden in watch-only mode. */}
					{!watchOnly && (
					<Box
						as="button"
						className="electrobun-webkit-app-region-no-drag"
						onClick={showOnDevice}
						disabled={showing}
						display="flex"
						alignItems="center"
						justifyContent="center"
						gap="2"
						w="184px"
						py="2"
						borderRadius="999px"
						bg="var(--ink-3)"
						border="1px solid var(--line)"
						color="var(--text-1)"
						fontSize="12px"
						fontWeight="500"
						letterSpacing="-0.005em"
						_hover={showing ? {} : { color: "var(--gold)", borderColor: "rgba(233,196,106,0.3)" }}
						transition="all 0.18s"
						cursor={showing ? "default" : "pointer"}
					>
						<Box as={showing ? FaSpinner : FaEye} fontSize="11px" style={showing ? { animation: "v3-spin 1s linear infinite" } : undefined} />
						{showing ? t("checkDevice") : t("verifyOnDevice")}
					</Box>
					)}
				</Flex>

				{/* Right column: address + xpub + path + chips */}
				<Flex direction="column" gap="4" flex="1" minW="0" w="100%">
					<Text fontSize="13px" color="var(--text-2)" letterSpacing="-0.005em">
						{t("sendToAddress", { symbol: chain.symbol })}
					</Text>

					{/* BTC: receive/change toggle + index stepper — needs the device to derive
					    each index, so hidden in watch-only (cached address only). */}
					{!watchOnly && isBtc && onBtcChangeIndex && (
						<Flex align="center" gap="3" flexWrap="wrap">
							<PillToggle
								options={[
									{ value: 0, label: t("receive") },
									{ value: 1, label: t("change", { ns: "common" }) },
								]}
								value={btcChangeIndex}
								onChange={(v) => onBtcChangeIndex(v as 0 | 1)}
							/>

							{onBtcAddressIndex && (
								<Flex align="center" gap="2">
									<Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em" fontWeight="500">
										{t("index")}
									</Text>
									<Box
										as="button"
										className="electrobun-webkit-app-region-no-drag"
										onClick={handlePrevAddress}
										disabled={btcAddressIndex <= 0}
										w="26px"
										h="26px"
										borderRadius="full"
										display="grid"
										placeItems="center"
										cursor={btcAddressIndex <= 0 ? "not-allowed" : "pointer"}
										opacity={btcAddressIndex <= 0 ? 0.3 : 1}
										color="var(--text-2)"
										bg="transparent"
										_hover={btcAddressIndex > 0 ? { bg: "var(--ink-3)", color: "var(--text-0)" } : {}}
										transition="all 0.15s"
									>
										<Box as={FaMinus} fontSize="9px" />
									</Box>
									<Box
										bg="var(--ink-0)"
										border="1px solid var(--line)"
										borderRadius="8px"
										px="2.5"
										py="0.5"
										minW="36px"
										textAlign="center"
									>
										<Text fontSize="12px" fontFamily="mono" fontWeight="500" color="var(--gold)" letterSpacing="0.02em">
											{btcAddressIndex}
										</Text>
									</Box>
									<Box
										as="button"
										className="electrobun-webkit-app-region-no-drag"
										onClick={handleNextAddress}
										disabled={remaining <= 0}
										w="26px"
										h="26px"
										borderRadius="full"
										display="grid"
										placeItems="center"
										cursor={remaining <= 0 ? "not-allowed" : "pointer"}
										opacity={remaining <= 0 ? 0.3 : 1}
										color="var(--text-2)"
										bg="transparent"
										_hover={remaining > 0 ? { bg: "var(--ink-3)", color: "var(--text-0)" } : {}}
										transition="all 0.15s"
									>
										<Box as={FaPlus} fontSize="9px" />
									</Box>
									<Text fontSize="10px" fontFamily="mono" color="var(--text-3)" letterSpacing="0.02em">
										({t("remaining", { remaining })})
									</Text>
								</Flex>
							)}
						</Flex>
					)}

					{/* TON: bounceable / non-bounceable — re-derives via device, hidden offline */}
					{!watchOnly && isTon && onTonBounceableChange && (
						<Box>
							<Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em" fontWeight="500" mb="2">
								Address Type
							</Text>
							<PillToggle
								options={[
									{ value: 0, label: "UQ (Safe)" },
									{ value: 1, label: "EQ (Bounceable)" },
								]}
								value={tonBounceable ? 1 : 0}
								onChange={(v) => onTonBounceableChange(v === 1)}
							/>
							{!tonBounceable && (
								<Text fontSize="11px" color="var(--text-3)" mt="2" letterSpacing="-0.005em">
									Non-bounceable — funds won't bounce back if wallet is uninitialized
								</Text>
							)}
							{tonBounceable && (
								<Text fontSize="11px" color="var(--gold)" mt="2" letterSpacing="-0.005em">
									Bounceable — funds will bounce back if wallet contract is not deployed
								</Text>
							)}
						</Box>
					)}

					{/* Address + (UTXO) xpub */}
					<CopyableField label={t("address")} value={address!} />
					{xpub && (
						<CopyableField label={t("extendedPublicKey")} value={xpub} />
					)}

					{/* Derivation path */}
					<Box>
						<Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em" fontWeight="500" mb="2">
							{t("path")}
						</Text>
						<Flex align="center" gap="2">
							<Text fontSize="12px" fontFamily="mono" color="var(--text-1)" letterSpacing="0.02em">
								{pathToString(currentPath)}
							</Text>
							{/* Editing the path re-derives on the device — hidden in watch-only. */}
							{!watchOnly && (
							<Box
								as="button"
								className="electrobun-webkit-app-region-no-drag"
								onClick={() => setPathDialogOpen(true)}
								cursor="pointer"
								color="var(--text-3)"
								_hover={{ color: "var(--gold)", bg: "var(--ink-2)" }}
								transition="all 0.15s"
								title={String(t("editDerivationPath"))}
								display="grid"
								placeItems="center"
								w="22px"
								h="22px"
								borderRadius="6px"
								bg="transparent"
							>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
									<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
									<path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/>
								</svg>
							</Box>
							)}
						</Flex>
					</Box>

					{/* Chain identifier chips — caip + slip44 (informational) */}
					<Flex gap="2" mt="1" flexWrap="wrap">
						{chain.caip && (
							<Text
								fontSize="10px"
								fontFamily="mono"
								color="var(--text-3)"
								bg="var(--ink-3)"
								border="1px solid var(--line)"
								px="2.5"
								py="1"
								borderRadius="999px"
								letterSpacing="0.02em"
							>
								{chain.caip}
							</Text>
						)}
						{(scriptType || chain.scriptType) && (
							<Text
								fontSize="10px"
								fontFamily="mono"
								color="var(--text-3)"
								bg="var(--ink-3)"
								border="1px solid var(--line)"
								px="2.5"
								py="1"
								borderRadius="999px"
								letterSpacing="0.02em"
							>
								{scriptType || chain.scriptType}
							</Text>
						)}
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
