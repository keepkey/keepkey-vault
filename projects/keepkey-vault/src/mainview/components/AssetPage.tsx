import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { ChainDef } from "../lib/chains"
import type { ChainBalance } from "../../shared/types"
import { AddressView } from "./AddressView"
import { ReceiveView } from "./ReceiveView"
import { SendForm } from "./SendForm"

type AssetView = "address" | "receive" | "send"

interface AssetPageProps {
	chain: ChainDef
	balance?: ChainBalance
	onBack: () => void
}

export function AssetPage({ chain, balance, onBack }: AssetPageProps) {
	const [view, setView] = useState<AssetView>("address")
	const [address, setAddress] = useState<string | null>(balance?.address || null)
	const [loading, setLoading] = useState(false)

	const deriveAddress = useCallback(async () => {
		setLoading(true)
		try {
			const params: any = {
				addressNList: chain.defaultPath,
				showDisplay: false,
				coin: chain.coin,
			}
			if (chain.scriptType) params.scriptType = chain.scriptType
			const result = await rpcRequest(chain.rpcMethod, params, 60000)
			const addr = typeof result === "string" ? result : result?.address || String(result)
			setAddress(addr)
		} catch (e: any) {
			console.error(`${chain.coin} address:`, e)
			setAddress(null)
		}
		setLoading(false)
	}, [chain])

	useEffect(() => {
		if (!address) deriveAddress()
	}, [deriveAddress, address])

	const PILLS: { id: AssetView; label: string }[] = [
		{ id: "address", label: "Address" },
		{ id: "receive", label: "Receive" },
		{ id: "send", label: "Send" },
	]

	return (
		<Box>
			{/* Header */}
			<Flex align="center" gap="3" mb="2">
				<Button
					size="sm"
					variant="ghost"
					color="kk.textSecondary"
					_hover={{ color: "kk.textPrimary" }}
					onClick={onBack}
					px="2"
				>
					&larr;
				</Button>
				<Box w="3px" h="20px" bg={chain.color} borderRadius="full" />
				<Text fontSize="lg" fontWeight="600" color="kk.textPrimary">{chain.coin}</Text>
				<Text fontSize="sm" color="kk.textMuted">{chain.symbol}</Text>
			</Flex>

			{/* Balance summary */}
			{balance && (
				<Box mb="4" ml="10">
					<Text fontSize="md" fontFamily="mono" color="kk.textPrimary">
						{balance.balance} {chain.symbol}
					</Text>
					{balance.balanceUsd > 0 && (
						<Text fontSize="sm" color="kk.textMuted">
							${balance.balanceUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
						</Text>
					)}
				</Box>
			)}

			{/* Pill toggle */}
			<Flex gap="1" mb="4" bg="rgba(255,255,255,0.03)" p="1" borderRadius="lg" w="fit-content">
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
						px="3"
						borderRadius="md"
						onClick={() => setView(p.id)}
					>
						{p.label}
					</Button>
				))}
			</Flex>

			{/* Content */}
			<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5">
				{view === "address" && (
					<AddressView chain={chain} address={address} loading={loading} onDerive={deriveAddress} />
				)}
				{view === "receive" && (
					<ReceiveView address={address} symbol={chain.symbol} onDerive={deriveAddress} />
				)}
				{view === "send" && (
					<SendForm chain={chain} address={address} balance={balance} />
				)}
			</Box>
		</Box>
	)
}
