/**
 * SendReceivePicker — front-page asset chooser for the Send / Receive actions.
 *
 * The front-page action row is asset-agnostic, but Send/Receive target a
 * specific chain, so tapping them opens this picker. Picking a chain routes to
 * that chain's page in the chosen action (the per-chain page handles token
 * selection within the chain). Swap doesn't use this — it opens the swap panel.
 */
import { Box, Flex, Text } from "@chakra-ui/react"
import { Z } from "../lib/z-index"
import type { ChainDef } from "../../shared/chains"

export interface PickerAsset {
	chain: ChainDef
	balance: string // formatted native balance, e.g. "0.5"
	usd: number
}

export function SendReceivePicker({
	action,
	assets,
	onSelect,
	onClose,
}: {
	action: "send" | "receive"
	assets: PickerAsset[]
	onSelect: (chain: ChainDef) => void
	onClose: () => void
}) {
	return (
		<Box
			position="fixed"
			inset="0"
			zIndex={Z.assetPicker}
			display="flex"
			alignItems="center"
			justifyContent="center"
			bg="rgba(0,0,0,0.6)"
			onClick={onClose}
		>
			<Box
				bg="kk.bg"
				borderRadius="16px"
				border="1px solid"
				borderColor="kk.border"
				w="360px"
				maxW="92vw"
				maxH="80vh"
				overflow="hidden"
				display="flex"
				flexDirection="column"
				boxShadow="0 24px 64px rgba(0,0,0,0.6)"
				onClick={(e) => e.stopPropagation()}
			>
				<Flex
					px="5"
					py="3"
					borderBottom="1px solid"
					borderColor="kk.border"
					align="center"
					justify="space-between"
					flexShrink={0}
				>
					<Text fontSize="sm" fontWeight="700" color="kk.textPrimary">
						{action === "send" ? "Send — choose asset" : "Receive — choose asset"}
					</Text>
					<Box
						as="button"
						onClick={onClose}
						color="kk.textMuted"
						_hover={{ color: "kk.textPrimary" }}
						px="1"
						fontSize="lg"
						lineHeight="1"
						aria-label="Close"
					>
						&times;
					</Box>
				</Flex>
				<Box flex="1" overflowY="auto" px="2" py="2">
					{assets.map(({ chain, balance, usd }) => (
						<Flex
							key={chain.id}
							as="button"
							w="100%"
							align="center"
							gap="2.5"
							px="3"
							py="2"
							borderRadius="md"
							bg="transparent"
							_hover={{ bg: "kk.cardBg" }}
							cursor="pointer"
							transition="all 0.15s"
							border="0"
							onClick={() => onSelect(chain)}
							title={chain.coin}
						>
							<Flex
								w="30px"
								h="30px"
								borderRadius="full"
								flexShrink={0}
								align="center"
								justify="center"
								style={{ background: chain.color }}
							>
								<Text fontSize="12px" fontWeight="700" color="#0b0b0e">
									{chain.symbol.slice(0, 1)}
								</Text>
							</Flex>
							<Box flex="1" minW="0" textAlign="left">
								<Text fontSize="13px" fontWeight="600" color="kk.textPrimary" lineHeight="1.2" truncate>
									{chain.symbol}
								</Text>
								<Text fontSize="10px" color="kk.textMuted" lineHeight="1.3" truncate>
									{chain.coin}
								</Text>
							</Box>
							<Box textAlign="right" flexShrink={0}>
								<Text fontSize="12px" fontWeight="600" color="kk.textPrimary">
									{balance} {chain.symbol}
								</Text>
								{usd > 0 && (
									<Text fontSize="10px" color="kk.textMuted">
										${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
									</Text>
								)}
							</Box>
						</Flex>
					))}
				</Box>
			</Box>
		</Box>
	)
}
