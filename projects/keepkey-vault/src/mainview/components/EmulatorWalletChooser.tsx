import { useUiTranslation } from "../i18n/ui"
/**
 * "Pick the firmware and the seed to load into the emulator." Every emulator
 * seed is a named file on disk, and the emulator never starts until one is
 * picked here by name, so a test seed can't be mistaken for the one that holds
 * funds. The firmware build is a separate selection, shown and set here too:
 * the seed clicked starts on the firmware shown above it, nothing else.
 */
import { useEffect, useState } from "react"
import { Box, Flex, Text, chakra } from "@chakra-ui/react"
import type { EmulatorBuildInfo, EmulatorNextBuild, EmulatorRunningBuild, EmulatorWalletInfo } from "../../shared/types"
import { emulatorWalletDetail, newEmulatorWalletNameError } from "../../shared/emulatorWallets"
import { rpcRequest } from "../lib/rpc"
import { EmulatorBuildOptions, useEmulatorNames } from "./EmulatorIdentity"

/** The firmware builds a start can pick, and what the next start loads (or why it can't). */
export interface EmulatorFirmwareChoices { builds: EmulatorBuildInfo[]; next: EmulatorNextBuild }

/** Null when the list can't be read: the picker then keeps the selected build. */
export function loadEmulatorFirmware(): Promise<EmulatorFirmwareChoices | null> {
	return rpcRequest<EmulatorFirmwareChoices>("emulatorListBuilds", undefined, 10000).catch(() => null)
}

/** Firmware select. "" is the bundled emulator; an unavailable selected build stays listed, marked. */
function FirmwarePicker({ firmware, value, onChange, busy }: { firmware: EmulatorFirmwareChoices; value: string; onChange: (id: string) => void; busy?: boolean }) {
	const uiText = useUiTranslation()
	const next = firmware.next
	const problem = (value || null) === next.id ? next.problem : null
	return (
		<Box mb="3">
			<Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.06em" mb="1">{uiText("Firmware")}</Text>
			<chakra.select aria-label={uiText("Emulator firmware")} value={value} disabled={busy}
				onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
				w="100%" px="2" py="1.5" fontSize="12px" color="var(--text-0)" bg="var(--ink-1)" border="1px solid var(--ink-3)" borderRadius="md">
				<EmulatorBuildOptions builds={firmware.builds} next={next} />
			</chakra.select>
			{problem && <Text mt="1" fontSize="11px" color="var(--rose)" wordBreak="break-word" data-testid="firmware-problem">{problem}</Text>}
		</Box>
	)
}

/** Name field + Create. Starts a blank emulator under that name. */
function NewSeedForm({ existing, onCreate, busy }: { existing: string[]; onCreate: (name: string) => void; busy?: boolean }) {
  const uiText = useUiTranslation()

	const [name, setName] = useState("")
	const problem = newEmulatorWalletNameError(name, existing)
	return (
		<Box as="form" onSubmit={(e: React.FormEvent) => { e.preventDefault(); if (!problem && !busy) onCreate(name.trim()) }}>
			<Flex gap="1.5">
				<Box as="input" aria-label={uiText("New seed name")} placeholder={uiText("name for a new seed")}
					value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
					flex="1" minW="0" px="2" py="1.5" fontSize="12px" fontFamily="mono" color="var(--text-0)"
					bg="var(--ink-1)" border="1px solid var(--ink-3)" borderRadius="md" />
				<Box as="button" type="submit" disabled={!!problem || busy} px="3" py="1.5" fontSize="11px" fontWeight="600"
					color="var(--teal)" border="1px solid rgba(139,227,196,0.35)" borderRadius="md"
					opacity={problem || busy ? 0.45 : 1} cursor={problem || busy ? "not-allowed" : "pointer"}>{uiText("Create")}</Box>
			</Flex>
			<Text mt="1" fontSize="10px" color={name.trim() && problem ? "var(--rose)" : "var(--text-3)"}>
				{name.trim() && problem ? problem : uiText("A new seed starts blank: you create or recover its recovery phrase on the emulator.")}
			</Text>
		</Box>
	)
}

export function EmulatorWalletChooser({ wallets, firmware, onPick, onDelete, onClose, busy, error }: {
	wallets: EmulatorWalletInfo[]
	/** Omit (or null) when the build list could not be read: starts keep the selected build. */
	firmware?: EmulatorFirmwareChoices | null
	/** buildId: undefined keeps the selected build; null is the bundled emulator. */
	onPick: (name: string, buildId?: string | null) => void
	/** Omit to hide delete. */
	onDelete?: (name: string) => void
	onClose: () => void
	busy?: boolean
	error?: string | null
}) {
  const uiText = useUiTranslation()

	const { buildTitle, walletTitle } = useEmulatorNames()
	const [deleting, setDeleting] = useState<string | null>(null)
	const [buildChoice, setBuildChoice] = useState<string>(firmware?.next.id ?? "")
	useEffect(() => { setBuildChoice(firmware?.next.id ?? "") }, [firmware?.next.id])
	const chosenBuild = firmware ? (buildChoice || null) : undefined
	const chosenInfo: EmulatorRunningBuild | null = !firmware ? null
		: firmware.next.id === (chosenBuild ?? null) ? firmware.next
		: firmware.builds.find((b) => b.id === chosenBuild) ?? { id: chosenBuild ?? null }
	const blocked = !!firmware && (chosenBuild ?? null) === firmware.next.id && !!firmware.next.problem
	const pick = (name: string) => { if (!blocked) onPick(name, chosenBuild) }
	return (
		<Box position="fixed" inset="0" zIndex={2000} bg="rgba(0,0,0,0.6)" display="flex" alignItems="center" justifyContent="center" onClick={onClose}>
			<Box role="dialog" aria-label={uiText("Pick the seed to load into the emulator")} w="420px" maxW="92vw" maxH="80vh" overflowY="auto" p="4" textAlign="left"
				bg="rgba(16,16,21,0.98)" border="1px solid var(--ink-3)" borderRadius="14px" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
				<Flex justify="space-between" align="center" mb="1">
					<Text fontSize="14px" fontWeight="600" color="var(--text-0)">{firmware ? uiText("Pick the firmware and the seed for the emulator") : uiText("Pick the seed to load into the emulator")}</Text>
					<Box as="button" aria-label={uiText("Close")} onClick={onClose} px="1.5" fontSize="16px" color="var(--text-3)" cursor="pointer">{uiText("×")}</Box>
				</Flex>
				<Text fontSize="11px" color="var(--text-3)" mb="3">
					{wallets.length ? uiText("Each seed is a separate wallet saved on this computer. The emulator opens with the one you pick.") : uiText("No saved seeds yet. Name one to start.")}
					{firmware ? " " + uiText("Firmware and seed are separate choices: the seed you pick starts on the firmware shown here.") : ""}
				</Text>
				{firmware && <FirmwarePicker firmware={firmware} value={buildChoice} onChange={setBuildChoice} busy={busy} />}
				{error && <Text fontSize="11px" color="var(--rose)" mb="2" wordBreak="break-word">{error}</Text>}

				{wallets.map((w) => {
					const title = walletTitle(w)
					const startLabel = chosenInfo ? uiText("Start {{wallet}} on {{firmware}}", { wallet: title, firmware: buildTitle(chosenInfo) }) : uiText("Start {{wallet}}", { wallet: title })
					return (
					<Flex key={w.name} direction="column" mb="1.5">
					<Flex align="stretch" gap="1.5">
						<chakra.button type="button" disabled={busy || blocked} onClick={() => pick(w.name)} flex="1" minW="0" textAlign="left" px="3" py="2"
							aria-label={startLabel} title={startLabel}
							border="1px solid" borderColor={w.isActive ? "rgba(139,227,196,0.45)" : "var(--ink-3)"} borderRadius="md"
							cursor={busy ? "wait" : blocked ? "not-allowed" : "pointer"} opacity={blocked ? 0.55 : 1} _hover={{ borderColor: "rgba(139,227,196,0.45)" }}>
							<Text fontSize="13px" fontWeight="600" color="var(--text-0)">
								{title}{w.isActive ? uiText("  (running)") : w.isSelected ? uiText("  (last used)") : ""}
							</Text>
							{title !== w.name && <Text fontSize="10px" fontFamily="mono" color="var(--text-3)">{w.name}</Text>}
							{w.ethAddress && <Text fontSize="10px" fontFamily="mono" color="var(--text-1)">ETH {w.ethAddress}</Text>}
							<Text fontSize="10px" color="var(--text-3)">
								{emulatorWalletDetail(w)}{w.hasMnemonic ? uiText(" · seed saved") : ""}{(w.totalUsd ?? 0) > 0 ? uiText(" · has cached balance") : ""}
							</Text>
						</chakra.button>
						{/* The running wallet has no delete: stop the emulator first (the backend refuses it too). */}
						{onDelete && !w.isActive && deleting !== w.name && (
							<chakra.button type="button" aria-label={uiText("Delete seed {{wallet}}", { wallet: title })} disabled={busy} onClick={() => setDeleting(w.name)} px="2" fontSize="14px" color="var(--text-3)" cursor="pointer"
								_hover={{ color: "var(--rose)" }}>{uiText("×")}</chakra.button>
						)}
					</Flex>
					{onDelete && !w.isActive && deleting === w.name && (
						<Box role="alertdialog" aria-label={uiText("Delete seed {{wallet}}", { wallet: title })} mt="1" px="3" py="2" borderRadius="md" bg="rgba(224,140,123,0.10)" border="1px solid rgba(224,140,123,0.35)">
							<Text fontSize="11px" color="var(--text-0)" data-testid="delete-confirm">
								{uiText("Delete \"{{wallet}}\" ({{file}})? Its flash and saved seed are erased from this computer. This can't be undone.", { wallet: title, file: w.name })}
							</Text>
							<Flex gap="2" mt="1.5" justify="flex-end">
								<chakra.button type="button" onClick={() => setDeleting(null)} px="2" py="0.5" fontSize="11px" color="var(--text-2)" cursor="pointer">{uiText("Keep")}</chakra.button>
								<chakra.button type="button" disabled={busy} onClick={() => { setDeleting(null); onDelete(w.name) }} px="2" py="0.5" fontSize="11px" fontWeight="700" color="var(--rose)" cursor="pointer">{uiText("Delete")}</chakra.button>
							</Flex>
						</Box>
					)}
					</Flex>
					)
				})}

				<Box mt="3" pt="3" borderTop="1px solid var(--ink-3)">
					<NewSeedForm existing={wallets.map((w) => w.name)} onCreate={pick} busy={busy || blocked} />
				</Box>
			</Box>
		</Box>
	)
}
