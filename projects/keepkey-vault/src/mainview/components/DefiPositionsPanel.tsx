import { useEffect, useMemo, useState } from "react"
import { Box, Flex, Text, VStack, HStack, Image, Button, Spinner } from "@chakra-ui/react"
import { FaEye, FaEyeSlash } from "react-icons/fa"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { useFiat } from "../lib/fiat-context"
import { formatBalance } from "../lib/formatting"
import type { DefiPosition } from "../../shared/types"

interface DefiPositionsPanelProps {
	/** EVM address to look up DeFi positions for. */
	address: string | null
	/** Per-chain accent color, matching the token table. */
	color: string
}

/**
 * DeFi positions for an EVM address, rendered below the token table.
 *
 * Data comes from the backend `getDefiPositions` RPC (Zapper proxy on the
 * KeepKey API). Positions are display-only and not counted toward the chain
 * total — they live in their own section so protocol holdings (staked,
 * supplied, borrowed, LP, claimable) read clearly apart from plain tokens.
 *
 * Hide-dust mirrors the token table: zero-USD positions are tucked behind a
 * "show hidden" toggle.
 */
export function DefiPositionsPanel({ address, color }: DefiPositionsPanelProps) {
	const { t } = useTranslation("asset")
	const { fmtCompact } = useFiat()
	const [positions, setPositions] = useState<DefiPosition[]>([])
	const [loading, setLoading] = useState(false)
	const [loaded, setLoaded] = useState(false)
	const [showHidden, setShowHidden] = useState(false)

	useEffect(() => {
		if (!address) { setPositions([]); setLoaded(true); return }
		let cancelled = false
		setLoading(true)
		rpcRequest<DefiPosition[]>("getDefiPositions", { address }, 30000)
			.then((res) => { if (!cancelled) setPositions(Array.isArray(res) ? res : []) })
			.catch((e) => { if (!cancelled) { console.warn("[DefiPanel] fetch failed:", e); setPositions([]) } })
			.finally(() => { if (!cancelled) { setLoading(false); setLoaded(true) } })
		return () => { cancelled = true }
	}, [address])

	// Hide-dust: zero-USD positions hidden behind a toggle (same rule as tokens).
	const { live, dust } = useMemo(() => {
		const live: DefiPosition[] = []
		const dust: DefiPosition[] = []
		for (const p of positions) {
			if ((p.balanceUsd ?? 0) > 0) live.push(p)
			else dust.push(p)
		}
		return { live, dust }
	}, [positions])

	const totalUsd = useMemo(() => live.reduce((sum, p) => sum + (p.balanceUsd || 0), 0), [live])

	// Nothing to show and nothing loading → render nothing (keeps the view tidy
	// for addresses with no DeFi activity).
	if (loaded && !loading && positions.length === 0) return null

	const renderRow = (pos: DefiPosition, key: string) => (
		<Box
			key={key}
			w="100%"
			py="2"
			px="3"
			bg="kk.cardBg"
			border="1px solid"
			borderColor={pos.balanceUsd > 0 ? `${color}30` : "kk.border"}
			borderRadius="lg"
			opacity={pos.balanceUsd > 0 ? 1 : 0.6}
		>
			<Flex align="center" justify="space-between">
				<HStack gap="2" flex="1" minW="0">
					{pos.icon && (
						<Image src={pos.icon} alt={pos.symbol} w="24px" h="24px" borderRadius="full" flexShrink={0} bg="gray.700" />
					)}
					<Box minW="0">
						<HStack gap="1.5">
							<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2" truncate>
								{pos.name}
							</Text>
							{pos.metaType && (
								<Text fontSize="9px" bg="rgba(96,165,250,0.15)" color="#60a5fa" px="1" py="0.5" borderRadius="sm" lineHeight="1" textTransform="capitalize">
									{pos.metaType}
								</Text>
							)}
						</HStack>
						<HStack gap="1.5" mt="0.5">
							{pos.protocol && (
								<Text fontSize="10px" color="kk.textSecondary" lineHeight="1.2" textTransform="capitalize" truncate>
									{pos.protocol}
								</Text>
							)}
							{pos.network && (
								<Text fontSize="9px" color="kk.textMuted" lineHeight="1.2" truncate>
									{pos.network}
								</Text>
							)}
						</HStack>
					</Box>
				</HStack>
				<Box textAlign="right" flexShrink={0}>
					<Text fontSize="xs" fontFamily="mono" fontWeight="500" color="white" lineHeight="1.2">
						{fmtCompact(pos.balanceUsd)}
					</Text>
					{Number(pos.balance) > 0 && (
						<Text fontSize="11px" color="kk.textMuted" lineHeight="1.2" fontFamily="mono">
							{formatBalance(pos.balance)} {pos.symbol}
						</Text>
					)}
				</Box>
			</Flex>
		</Box>
	)

	return (
		<Box mt="6">
			<Flex align="center" justify="space-between" mb="3" px="1">
				<Text fontSize="11px" fontWeight="500" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em">
					{t("defiPositions")}{live.length > 0 && ` · ${live.length}`}
				</Text>
				<HStack gap="2">
					{loading && <Spinner size="xs" color="kk.gold" />}
					{totalUsd > 0 && (
						<Text fontSize="12px" fontFamily="mono" color="var(--text-2)" fontWeight="500">{fmtCompact(totalUsd)}</Text>
					)}
				</HStack>
			</Flex>

			{live.length > 0 ? (
				<VStack gap="1.5">
					{live.map((p, i) => renderRow(p, `live-${i}`))}
				</VStack>
			) : (
				!loading && <Text fontSize="11px" color="kk.textMuted" px="1">{t("noDefiPositions")}</Text>
			)}

			{dust.length > 0 && (
				<Box mt="3">
					<Button
						size="xs"
						variant="ghost"
						color={showHidden ? "kk.gold" : "kk.textMuted"}
						_hover={{ color: "kk.gold", bg: "rgba(255,255,255,0.04)" }}
						onClick={() => setShowHidden(!showHidden)}
						w="100%"
						justifyContent="center"
						gap="1.5"
						py="1.5"
					>
						<Box as={showHidden ? FaEyeSlash : FaEye} fontSize="10px" />
						{showHidden ? t("hideFiltered", { count: dust.length }) : t("showFiltered", { count: dust.length })}
					</Button>
					{showHidden && (
						<VStack gap="1.5" mt="2">
							{dust.map((p, i) => renderRow(p, `dust-${i}`))}
						</VStack>
					)}
				</Box>
			)}
		</Box>
	)
}
