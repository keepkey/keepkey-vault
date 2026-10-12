/**
 * "Pick the seed to load into the emulator." Every emulator seed is a named
 * file on disk, and the emulator never starts until one is picked here by
 * name, so a test seed can't be mistaken for the one that holds funds.
 */
import { useState } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import type { EmulatorWalletInfo } from "../../shared/types"
import { emulatorWalletDetail, newEmulatorWalletNameError } from "../../shared/emulatorWallets"

/** Name field + Create. Starts a blank emulator under that name. */
function NewSeedForm({ existing, onCreate, busy }: { existing: string[]; onCreate: (name: string) => void; busy?: boolean }) {
	const [name, setName] = useState("")
	const problem = newEmulatorWalletNameError(name, existing)
	return (
		<Box as="form" onSubmit={(e: React.FormEvent) => { e.preventDefault(); if (!problem && !busy) onCreate(name.trim()) }}>
			<Flex gap="1.5">
				<Box as="input" aria-label="New seed name" placeholder="name for a new seed"
					value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
					flex="1" minW="0" px="2" py="1.5" fontSize="12px" fontFamily="mono" color="var(--text-0)"
					bg="var(--ink-1)" border="1px solid var(--ink-3)" borderRadius="md" />
				<Box as="button" type="submit" disabled={!!problem || busy} px="3" py="1.5" fontSize="11px" fontWeight="600"
					color="var(--teal)" border="1px solid rgba(139,227,196,0.35)" borderRadius="md"
					opacity={problem || busy ? 0.45 : 1} cursor={problem || busy ? "not-allowed" : "pointer"}>
					Create
				</Box>
			</Flex>
			<Text mt="1" fontSize="10px" color={name.trim() && problem ? "var(--rose)" : "var(--text-3)"}>
				{name.trim() && problem ? problem : "A new seed starts blank: you create or recover its recovery phrase on the emulator."}
			</Text>
		</Box>
	)
}

export function EmulatorWalletChooser({ wallets, onPick, onDelete, onClose, busy, error }: {
	wallets: EmulatorWalletInfo[]
	onPick: (name: string) => void
	/** Omit to hide delete. */
	onDelete?: (name: string) => void
	onClose: () => void
	busy?: boolean
	error?: string | null
}) {
	const [deleting, setDeleting] = useState<string | null>(null)
	return (
		<Box position="fixed" inset="0" zIndex={2000} bg="rgba(0,0,0,0.6)" display="flex" alignItems="center" justifyContent="center" onClick={onClose}>
			<Box role="dialog" aria-label="Pick the seed to load into the emulator" w="420px" maxW="92vw" maxH="80vh" overflowY="auto" p="4" textAlign="left"
				bg="rgba(16,16,21,0.98)" border="1px solid var(--ink-3)" borderRadius="14px" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
				<Flex justify="space-between" align="center" mb="1">
					<Text fontSize="14px" fontWeight="600" color="var(--text-0)">Pick the seed to load into the emulator</Text>
					<Box as="button" aria-label="Close" onClick={onClose} px="1.5" fontSize="16px" color="var(--text-3)" cursor="pointer">&times;</Box>
				</Flex>
				<Text fontSize="11px" color="var(--text-3)" mb="3">
					{wallets.length ? "Each seed is a separate wallet saved on this computer. The emulator opens with the one you pick." : "No saved seeds yet. Name one to start."}
				</Text>
				{error && <Text fontSize="11px" color="var(--rose)" mb="2" wordBreak="break-word">{error}</Text>}

				{wallets.map((w) => (
					<Flex key={w.name} align="stretch" gap="1.5" mb="1.5">
						<Box as="button" disabled={busy} onClick={() => onPick(w.name)} flex="1" minW="0" textAlign="left" px="3" py="2"
							border="1px solid" borderColor={w.isActive ? "rgba(139,227,196,0.45)" : "var(--ink-3)"} borderRadius="md"
							cursor={busy ? "wait" : "pointer"} _hover={{ borderColor: "rgba(139,227,196,0.45)" }}>
							<Text fontSize="13px" fontWeight="600" fontFamily="mono" color="var(--text-0)">
								{w.name}{w.isActive ? "  (running)" : ""}
							</Text>
							<Text fontSize="10px" color="var(--text-3)">
								{emulatorWalletDetail(w)}{w.hasMnemonic ? " · seed saved" : ""}{(w.totalUsd ?? 0) > 0 ? " · has cached balance" : ""}
							</Text>
						</Box>
						{onDelete && !w.isActive && (deleting === w.name ? (
							<Flex direction="column" justify="center" gap="1">
								<Box as="button" disabled={busy} onClick={() => { setDeleting(null); onDelete(w.name) }} px="2" fontSize="10px" fontWeight="600" color="var(--rose)" cursor="pointer">
									Delete "{w.name}"
								</Box>
								<Box as="button" onClick={() => setDeleting(null)} px="2" fontSize="10px" color="var(--text-3)" cursor="pointer">Keep</Box>
							</Flex>
						) : (
							<Box as="button" aria-label={`Delete seed ${w.name}`} onClick={() => setDeleting(w.name)} px="2" fontSize="14px" color="var(--text-3)" cursor="pointer"
								_hover={{ color: "var(--rose)" }}>&times;</Box>
						))}
					</Flex>
				))}

				<Box mt="3" pt="3" borderTop="1px solid var(--ink-3)">
					<NewSeedForm existing={wallets.map((w) => w.name)} onCreate={onPick} busy={busy} />
				</Box>
			</Box>
		</Box>
	)
}
