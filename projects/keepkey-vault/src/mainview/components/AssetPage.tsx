import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, Button, Image } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { ChainDef } from "../../shared/chains"
import type { ChainBalance } from "../../shared/types"
import { getAssetIcon } from "../../shared/assetLookup"
import { AnimatedUsd } from "./AnimatedUsd"
import { ReceiveView } from "./ReceiveView"
import { SendForm } from "./SendForm"

type AssetView = "receive" | "send"

interface AssetPageProps {
	chain: ChainDef
	balance?: ChainBalance
	onBack: () => void
}

export function AssetPage({ chain, balance, onBack }: AssetPageProps) {
	const [view, setView] = useState<AssetView>("receive")
	const [address, setAddress] = useState<string | null>(balance?.address || null)
	const [loading, setLoading] = useState(false)
	const [deriveError, setDeriveError] = useState<string | null>(null)
	const [currentPath, setCurrentPath] = useState<number[]>(chain.defaultPath)

	const deriveAddress = useCallback(async (path?: number[]) => {
		const usePath = path || currentPath
		if (path) setCurrentPath(path)
		setLoading(true)
		setDeriveError(null)
		try {
			const params: any = {
				addressNList: usePath,
				showDisplay: false,
				coin: chain.coin,
			}
			if (chain.scriptType) params.scriptType = chain.scriptType
			const result = await rpcRequest(chain.rpcMethod, params, 60000)
			const addr = typeof result === "string" ? result : result?.address || String(result)
			setAddress(addr)
		} catch (e: any) {
			console.error(`${chain.coin} address:`, e)
			setDeriveError(e.message || 'Address derivation failed')
			setAddress(null)
		}
		setLoading(false)
	}, [chain, currentPath])

	// Only auto-derive once on mount, not on every address change
	useEffect(() => {
		if (!address && !deriveError) deriveAddress()
	}, []) // eslint-disable-line react-hooks/exhaustive-deps

	const PILLS: { id: AssetView; label: string }[] = [
		{ id: "receive", label: "Receive" },
		{ id: "send", label: "Send" },
	]

	return (
		<Flex flex="1" direction="column" align="center" justify="center" px={{ base: "3", md: "6" }} py="4">
			<Box w="100%" maxW={{ base: "100%", sm: "480px", md: "560px" }}>
				{/* Header */}
				<Flex align="center" gap={{ base: "2", md: "3" }} mb="1">
					<Button
						size="sm"
						variant="ghost"
						color="kk.textSecondary"
						_hover={{ color: "kk.textPrimary" }}
						onClick={onBack}
						px="2"
						minW="auto"
					>
						&larr;
					</Button>
					<Image
						src={getAssetIcon(chain.caip)}
						alt={chain.symbol}
						w="28px"
						h="28px"
						borderRadius="full"
						flexShrink={0}
						bg={chain.color}
					/>
					<Text fontSize={{ base: "md", md: "lg" }} fontWeight="600" color="kk.textPrimary">{chain.coin}</Text>
					<Text fontSize={{ base: "xs", md: "sm" }} color="kk.textMuted">{chain.symbol}</Text>
					{balance && (
						<Flex ml="auto" align="baseline" gap="2" flexShrink={0}>
							<Text fontSize={{ base: "xs", md: "sm" }} fontFamily="mono" color="kk.textPrimary">
								{balance.balance} {chain.symbol}
							</Text>
							{balance.balanceUsd > 0 && (
								<AnimatedUsd value={balance.balanceUsd} prefix="($" suffix=")" fontSize="xs" color="kk.textMuted" display={{ base: "none", sm: "block" }} />
							)}
						</Flex>
					)}
				</Flex>
				{/* CAIP badge */}
				<Flex justify="center" mb="2">
					<Text fontSize="10px" fontFamily="mono" color="kk.textMuted" bg="rgba(255,255,255,0.04)" px="2" py="0.5" borderRadius="md">
						{chain.caip}
					</Text>
				</Flex>

				{/* Pill toggle */}
				<Flex justify="center" mb="3">
					<Flex gap="1" bg="rgba(255,255,255,0.03)" p="1" borderRadius="lg">
						{PILLS.map((p) => (
							<Button
								key={p.id}
								size="xs"
								variant="ghost"
								color={view === p.id ? "kk.gold" : "kk.textSecondary"}
								bg={view === p.id ? "rgba(255,215,0,0.1)" : "transparent"}
								_hover={{ bg: "rgba(255,255,255,0.06)" }}
								fontWeight={view === p.id ? "600" : "400"}
								fontSize="12px"
								px={{ base: "3", md: "4" }}
								borderRadius="md"
								onClick={() => setView(p.id)}
							>
								{p.label}
							</Button>
						))}
					</Flex>
				</Flex>

				{/* Content */}
				<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p={{ base: "3", md: "5" }}>
					{view === "receive" && (
						<ReceiveView
							chain={chain}
							address={address}
							loading={loading}
							error={deriveError}
							currentPath={currentPath}
							onDerive={deriveAddress}
						/>
					)}
					{view === "send" && (
						<SendForm chain={chain} address={address} balance={balance} />
					)}
				</Box>
			</Box>
		</Flex>
	)
}
