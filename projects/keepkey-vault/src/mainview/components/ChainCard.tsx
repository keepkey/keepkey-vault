import { Box, Flex, Text } from "@chakra-ui/react"
import type { ChainDef } from "../../shared/chains"
import { formatBalance } from "../lib/formatting"
import type { ChainBalance } from "../../shared/types"

interface ChainCardProps {
	chain: ChainDef
	balance?: ChainBalance
	onClick: () => void
}

export function ChainCard({ chain, balance, onClick }: ChainCardProps) {
	const hasBalance = balance && parseFloat(balance.balance) > 0

	return (
		<Box
			bg="kk.cardBg"
			border="1px solid"
			borderColor="kk.border"
			borderRadius="xl"
			borderLeft="3px solid"
			borderLeftColor={chain.color}
			p="4"
			cursor="pointer"
			transition="all 0.15s"
			_hover={{ bg: "rgba(255,255,255,0.04)", borderColor: chain.color, transform: "translateY(-1px)" }}
			_active={{ transform: "scale(0.98)" }}
			onClick={onClick}
		>
			<Flex justify="space-between" align="center" mb={hasBalance ? "2" : "0"}>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{chain.coin}</Text>
				<Text fontSize="xs" fontWeight="500" color="kk.textMuted" bg="rgba(255,255,255,0.06)" px="2" py="0.5" borderRadius="md">
					{chain.symbol}
				</Text>
			</Flex>
			{balance && (
				<Box>
					<Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" truncate>
						{formatBalance(balance.balance)} {chain.symbol}
					</Text>
					{balance.balanceUsd > 0 && (
						<Text fontSize="xs" color="kk.textMuted">
							${balance.balanceUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
						</Text>
					)}
				</Box>
			)}
		</Box>
	)
}
