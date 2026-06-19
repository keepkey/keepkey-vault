import { useEffect, useRef } from "react"
import { Box, Flex, Text, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../lib/z-index"
import { getAssetIcon } from "../../shared/assetLookup"
import type { ChainDef } from "../../shared/chains"

interface ChainPickerDialogProps {
	chains: ChainDef[]
	/** Called with the chain id when the user picks one. */
	onPick: (chainId: string) => void
	onClose: () => void
}

/**
 * Lightweight modal that renders the empty-balance built-in chains as a
 * grid so the sidebar can stay focused on chains the user actually holds
 * funds on. Picking a chain hands it back to the Dashboard, which both
 * drills into that chain AND remembers it so the row sticks in the
 * sidebar from then on.
 *
 * For adding *custom* EVM chains (user-defined via Pioneer's registry) see
 * `AddChainDialog` — that flow stays separate and is reached from the same
 * button after the grid.
 */
export function ChainPickerDialog({ chains, onPick, onClose }: ChainPickerDialogProps) {
	const { t } = useTranslation("dialogs")
	const ref = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [onClose])

	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			w="100vw"
			h="100vh"
			bg="rgba(11,11,14,0.28)"
			align="center"
			justify="center"
			zIndex={Z.overlay + 10}
			backdropFilter="blur(20px) saturate(140%)"
			onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
		>
			<Box
				ref={ref}
				w="min(680px, 90vw)"
				maxH="min(80vh, 720px)"
				overflowY="auto"
				p="6"
				borderRadius="22px"
				border="1px solid rgba(255,255,255,0.10)"
				style={{
					background:
						"linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015)), rgba(16,16,21,0.78)",
					backdropFilter: "blur(32px) saturate(160%)",
					WebkitBackdropFilter: "blur(32px) saturate(160%)",
					boxShadow:
						"0 0 0 1px rgba(255,255,255,0.06), 0 24px 60px -16px rgba(0,0,0,0.8), 0 4px 12px -4px rgba(0,0,0,0.5)",
				}}
			>
				<Flex align="center" justify="space-between" mb="2">
					<Text fontSize="18px" fontWeight="600" color="var(--text-0)" letterSpacing="-0.01em">
						{t("addChainDialog.pickTitle", { defaultValue: "Add a blockchain" })}
					</Text>
					<Box
						as="button"
						onClick={onClose}
						w="28px"
						h="28px"
						borderRadius="999px"
						bg="rgba(255,255,255,0.04)"
						border="1px solid rgba(255,255,255,0.08)"
						color="var(--text-2)"
						display="grid"
						placeItems="center"
						cursor="pointer"
						_hover={{ color: "var(--text-0)", bg: "rgba(255,255,255,0.08)" }}
						transition="all 0.15s"
						className="electrobun-webkit-app-region-no-drag"
						aria-label="Close"
					>
						×
					</Box>
				</Flex>
				<Text fontSize="12px" color="var(--text-3)" mb="5">
					{t("addChainDialog.pickSubtitle", { defaultValue: "These chains are supported by your KeepKey but currently hold no balance. Pick one to receive on it." })}
				</Text>

				{chains.length === 0 ? (
					<Box py="8" textAlign="center">
						<Text fontSize="13px" color="var(--text-3)">
							{t("addChainDialog.allShown", { defaultValue: "Every supported chain is already in your sidebar." })}
						</Text>
					</Box>
				) : (
					<Box
						display="grid"
						gridTemplateColumns={{ base: "repeat(2, 1fr)", sm: "repeat(3, 1fr)", md: "repeat(4, 1fr)" }}
						gap="2.5"
					>
						{chains.map((c) => (
							<Box
								key={c.id}
								as="button"
								onClick={() => onPick(c.id)}
								px="3"
								py="3"
								borderRadius="14px"
								bg="rgba(255,255,255,0.03)"
								border="1px solid rgba(255,255,255,0.08)"
								cursor="pointer"
								transition="all 0.15s"
								_hover={{
									bg: "rgba(255,255,255,0.06)",
									borderColor: "rgba(255,255,255,0.18)",
									transform: "translateY(-1px)",
								}}
								className="electrobun-webkit-app-region-no-drag"
								textAlign="left"
							>
								<Flex direction="column" align="center" gap="2">
									<Image
										src={getAssetIcon(c.caip)}
										alt={c.coin}
										w="40px"
										h="40px"
										borderRadius="full"
										bg="transparent"
										boxShadow="0 0 0 1px rgba(255,255,255,0.06)"
									/>
									<Box textAlign="center">
										<Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.2" truncate maxW="120px">
											{c.coin}
										</Text>
										<Text fontSize="10px" color="var(--text-3)" fontFamily="mono" mt="0.5">
											{c.symbol}
										</Text>
									</Box>
								</Flex>
							</Box>
						))}
					</Box>
				)}
			</Box>
		</Flex>
	)
}
