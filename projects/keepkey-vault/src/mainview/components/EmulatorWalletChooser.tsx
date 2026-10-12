/**
 * Picking an emulator wallet. Every wallet is a named file on disk and the
 * emulator never starts until one is chosen by name, so a test wallet can't
 * be mistaken for the one that holds funds.
 */
import { useState } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import type { EmulatorWalletInfo } from "../../shared/types"
import { emulatorWalletDetail, newEmulatorWalletNameError } from "../../shared/emulatorWallets"

/** Name field + Create. Starts a blank wallet under that name. */
export function NewEmulatorWalletForm({ existing, onCreate, busy }: {
	existing: string[]
	onCreate: (name: string) => void
	busy?: boolean
}) {
	const [name, setName] = useState("")
	const problem = newEmulatorWalletNameError(name, existing)
	return (
		<Box as="form" onSubmit={(e: React.FormEvent) => { e.preventDefault(); if (!problem && !busy) onCreate(name.trim()) }}>
			<Flex gap="1.5">
				<Box as="input" aria-label="New emulator wallet name" placeholder="wallet name"
					value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
					flex="1" minW="0" px="2" py="1" fontSize="12px" fontFamily="mono" color="var(--text-0)"
					bg="var(--ink-1)" border="1px solid var(--ink-3)" borderRadius="md" />
				<Box as="button" type="submit" disabled={!!problem || busy} px="2.5" py="1" fontSize="11px" fontWeight="600"
					color="var(--teal)" border="1px solid rgba(139,227,196,0.35)" borderRadius="md"
					opacity={problem || busy ? 0.45 : 1} cursor={problem || busy ? "not-allowed" : "pointer"}>
					Create
				</Box>
			</Flex>
			{name.trim() && problem && <Text mt="1" fontSize="10px" color="var(--rose)">{problem}</Text>}
		</Box>
	)
}

/** Every saved wallet by name, plus the form for a new one. */
export function EmulatorWalletChooser({ wallets, onPick, busy }: {
	wallets: EmulatorWalletInfo[]
	onPick: (name: string) => void
	busy?: boolean
}) {
	return (
		<Box w="340px" p="3" textAlign="left" bg="rgba(16,16,21,0.96)" border="1px solid var(--ink-3)" borderRadius="12px">
			<Text fontSize="12px" fontWeight="600" color="var(--text-0)" mb="2">Which emulator wallet?</Text>
			{wallets.map((w) => (
				<Box as="button" key={w.name} disabled={busy} onClick={() => onPick(w.name)} display="block" w="100%" textAlign="left"
					px="2.5" py="1.5" mb="1.5" border="1px solid var(--ink-3)" borderRadius="md" cursor={busy ? "wait" : "pointer"}
					_hover={{ borderColor: "rgba(139,227,196,0.45)" }}>
					<Text fontSize="13px" fontWeight="600" fontFamily="mono" color="var(--text-0)">{w.name}</Text>
					<Text fontSize="10px" color="var(--text-3)">{emulatorWalletDetail(w)}</Text>
				</Box>
			))}
			<Text fontSize="10px" color="var(--text-3)" mt="2" mb="1">Or start a new one:</Text>
			<NewEmulatorWalletForm existing={wallets.map((w) => w.name)} onCreate={onPick} busy={busy} />
		</Box>
	)
}
