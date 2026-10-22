import { useMemo, useState } from "react"
import { Box, Flex, Text, Button, Image } from "@chakra-ui/react"
import { Z } from "../lib/z-index"
import { getAssetIcon } from "../../shared/assetLookup"
import type { ChainDef } from "../../shared/chains"
import { estimateLoadMs } from "../../shared/network-load"
import { DOCS_LINKS } from "../../shared/docs-links"
import { DocsLink } from "./DocsLink"

const ON = "#3FB950" // green = on

/** Lets a multi-chain user turn networks off for a faster dashboard. Bitcoin is
 *  always on (its accounts are always read). `chains` is what this device can
 *  show; `initialDisabled` the current choice. */
export function NetworkPickerDialog({ chains, initialDisabled, onDone, onCancel }: {
	chains: ChainDef[]
	initialDisabled: string[]
	onDone: (disabled: string[]) => void
	/** Settings passes this; onboarding instead offers "Keep all on". */
	onCancel?: () => void
}) {
	const [off, setOff] = useState(() => new Set(initialDisabled.filter(id => id !== "bitcoin")))
	const toggle = (id: string) => setOff(prev => {
		const next = new Set(prev)
		next.has(id) ? next.delete(id) : next.add(id)
		return next
	})

	const allMs = useMemo(() => estimateLoadMs(chains), [chains])
	const ms = estimateLoadMs(chains.filter(c => !off.has(c.id)))
	const ratio = allMs > 0 ? ms / allMs : 1
	// All on reads red; the colour cools as the estimate drops.
	const barColor = ratio > 0.75 ? "#F85149" : ratio > 0.4 ? "#D29922" : ON

	return (
		<Flex position="fixed" top={0} left={0} w="100vw" h="100vh" bg="rgba(0,0,0,0.6)"
			align="center" justify="center" zIndex={Z.dialog} backdropFilter="blur(3px)">
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border"
				p="5" maxW="460px" w="92%" maxH="88vh" overflowY="auto" boxShadow="0 8px 32px rgba(0,0,0,0.6)">
				<Text fontSize="md" fontWeight="800" color="kk.textPrimary">Choose your networks</Text>
				<Text fontSize="xs" color="kk.textSecondary" mt="1" lineHeight="1.6">
					Turn off networks you don't use and your dashboard loads faster. Their balances won't show
					until you turn them back on. Change this any time in Settings.{" "}
					<DocsLink href={DOCS_LINKS.performance} />
				</Text>

				<Flex wrap="wrap" gap="1.5" mt="4">
					{chains.map(c => {
						const locked = c.id === "bitcoin"
						const isOn = locked || !off.has(c.id)
						return (
							<Flex key={c.id} as="button" align="center" gap="1.5" px="2.5" py="1" borderRadius="full"
								border="1px solid" borderColor={isOn ? ON : "kk.border"} bg={isOn ? `${ON}14` : "transparent"}
								cursor={locked ? "default" : "pointer"} title={locked ? "Bitcoin is always on" : undefined}
								onClick={locked ? undefined : () => toggle(c.id)}>
								<Image src={getAssetIcon(c.caip)} alt="" w="16px" h="16px" borderRadius="full"
									filter={isOn ? undefined : "grayscale(1)"} opacity={isOn ? 1 : 0.4} />
								<Text fontSize="xs" color={isOn ? "kk.textPrimary" : "kk.textMuted"}>{c.coin}</Text>
							</Flex>
						)
					})}
				</Flex>
				<Text fontSize="2xs" color="kk.textMuted" mt="2" lineHeight="1.5">
					Bitcoin is always on. EVM networks share one address that is always read, so turning them off doesn't change load time.
				</Text>

				<Box mt="4">
					<Flex justify="space-between" mb="1">
						<Text fontSize="2xs" color="kk.textSecondary">Estimated first load after connecting</Text>
						<Text fontSize="xs" fontWeight="700" color={barColor}>~{Math.max(1, Math.round(ms / 1000))} s</Text>
					</Flex>
					<Box h="6px" borderRadius="full" bg="kk.border" overflow="hidden">
						<Box h="100%" w={`${Math.max(4, ratio * 100)}%`} bg={barColor} borderRadius="full" transition="all 0.25s" />
					</Box>
				</Box>

				<Flex justify="flex-end" gap="2" mt="4">
					{onCancel
						? <Button size="xs" variant="ghost" color="kk.textSecondary" onClick={onCancel}>Cancel</Button>
						: <Button size="xs" variant="ghost" color="kk.textSecondary" onClick={() => onDone([])}>Keep all on</Button>}
					<Button size="xs" bg="kk.gold" color="black" fontWeight="700" _hover={{ opacity: 0.9 }}
						onClick={() => onDone([...off])}>
						{onCancel ? "Save" : "Continue"}
					</Button>
				</Flex>
			</Box>
		</Flex>
	)
}
