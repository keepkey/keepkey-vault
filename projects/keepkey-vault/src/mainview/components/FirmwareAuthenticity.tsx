/**
 * First screen of the setup wizard — before the tutorial cards, before
 * anything is written to the device: what firmware is actually running.
 *
 * THE CLAIM THIS SCREEN MAKES, AND THE ONE IT DOES NOT. The device reports
 * SHA-256(meta_descriptor + app_code), which equals the full-file hash of the
 * released .bin and, because the meta descriptor covers the signature slots,
 * pins the exact signed artifact. We look that up in a table compiled into
 * this app, so a compromised update server cannot rewrite it.
 *
 * That is corroboration, not proof: the running firmware self-reports the
 * hash. What actually refuses to boot unsigned firmware is the bootloader's
 * signature check, on the device, at every power-on. The copy below says so
 * rather than implying the green tick did it — a checkmark anyone can print
 * is worth exactly nothing without the sentence next to it.
 */
import { Box, Button, Flex, HStack, SimpleGrid, Text, VStack } from "@chakra-ui/react"
import { FaChevronRight, FaShieldAlt } from "react-icons/fa"
import { rpcRequest } from "../lib/rpc"

const GOLD = "#E9C46A"
const GREEN = "#48BB78"
const AMBER = "#ED8936"

type Verdict = "verified" | "unrecognized" | "unreported"

function openUrl(url: string) {
  // target="_blank" is a dead click in Electrobun.
  rpcRequest("openUrl", { url }).catch(() => {})
}

/**
 * The three trust links, and WHY they do not all render as green ticks.
 *
 *   source ──reproducible build──> release ──firmware hash──> your device
 *   release ──3-of-5 signatures──> bootloader authorisation
 *
 * Only the middle one is something this app performs. Painting all three the
 * same colour would tell the user we verified three things when we verified
 * one -- which is the exact overclaim this screen exists to avoid. So each row
 * states who did the checking:
 *
 *   "checked"  we compared it, here and now
 *   "verify"   we cannot check it; here is how you do it yourself
 *   "device"   the hardware enforced it; no host software was involved
 */
type Actor = "checked" | "verify" | "device"

const ACTOR_LABEL: Record<Actor, string> = {
	checked: "checked by Vault",
	verify: "verify it yourself",
	device: "enforced on the device",
}

function TrustRow({
	actor,
	title,
	body,
	action,
}: {
	actor: Actor
	title: string
	body: string
	action?: { label: string; url: string }
}) {
	// Green is reserved for what we actually verified. The other two are real
	// guarantees, just not ours to assert, so they read as neutral.
	const color = actor === "checked" ? GREEN : "gray.500"
	return (
		<HStack gap="2.5" align="start" w="100%">
			<Box mt="3px" flexShrink={0} w="6px" h="6px" borderRadius="full" bg={color} />
			<VStack gap="0.5" align="start" flex="1" minW={0}>
				<HStack gap="2">
					<Text fontSize="xs" fontWeight="600" color="gray.200">{title}</Text>
					<Text fontSize="2xs" color={color}>{ACTOR_LABEL[actor]}</Text>
				</HStack>
				<Text fontSize="2xs" color="gray.500" lineHeight="tall">{body}</Text>
				{action && (
					<Box
						as="button"
						fontSize="2xs"
						color={GOLD}
						textDecoration="underline"
						onClick={() => openUrl(action.url)}
					>
						{action.label}
					</Box>
				)}
			</VStack>
		</HStack>
	)
}

function HashRow({ label, value }: { label: string; value: string }) {
	return (
		<VStack gap="0.5" align="stretch" w="100%">
			<Text fontSize="2xs" color="gray.500">{label}</Text>
			<Text fontSize="2xs" fontFamily="mono" color="gray.300" wordBreak="break-all" lineHeight="1.4">
				{value}
			</Text>
		</VStack>
	)
}

export function FirmwareAuthenticity({
	firmwareHash,
	firmwareRelease,
	firmwareVerified,
	bootloaderHash,
	bootloaderVerified,
	onContinue,
}: {
	firmwareHash?: string
	firmwareRelease?: string
	firmwareVerified?: boolean
	bootloaderHash?: string
	bootloaderVerified?: boolean
	onContinue: () => void
}) {
	// Fail closed: a missing hash is "we do not know", never a pass.
	const verdict: Verdict = !firmwareHash
		? "unreported"
		: firmwareVerified
			? "verified"
			: "unrecognized"

	const accent = verdict === "verified" ? GREEN : verdict === "unrecognized" ? AMBER : "gray.500"

	const headline =
		verdict === "verified"
			? `Running ${firmwareRelease}`
			: verdict === "unrecognized"
				? "We don't recognise this build"
				: "This firmware doesn't report a hash"

	const body =
		verdict === "verified"
			? "The firmware hash your device reports matches a published KeepKey release. You can check that yourself below."
			: verdict === "unrecognized"
				? "The hash your device reports isn't in the list built into this app. That happens for in-house and bitcoin-only builds we haven't pinned yet, and it also happens for modified firmware. Compare the hash below against the release you expect, and check what your device showed when it powered on."
				: "This firmware version is too old to report its hash, so we can't check it from here. The bootloader still verified its signature at power-on."

	return (
		<VStack gap={4} w="100%" mx="auto">
			<Box
				w="100%"
				bg="rgba(255,255,255,0.03)"
				border="1px solid"
				borderColor={`${GOLD}33`}
				borderRadius="2xl"
				p={{ base: 5, md: 6 }}
			>
				{/* Two columns on a real window: verdict + hashes on the left, the
				    trust chain and the commands on the right. One column below md. */}
				<SimpleGrid columns={{ base: 1, md: 2 }} gap={{ base: 4, md: 8 }} alignItems="start">
				<VStack gap={3} align="stretch">
					<HStack gap={3} align="center">
						<Box color={accent}><FaShieldAlt size={22} /></Box>
						<Text fontSize="lg" fontWeight="800" color="white" letterSpacing="-0.02em">
							{headline}
						</Text>
						{verdict === "unrecognized" && (
							<Box
								flexShrink={0}
								px="2"
								py="0.5"
								borderRadius="full"
								border="1px solid"
								borderColor={AMBER}
								color={AMBER}
								fontSize="2xs"
								fontWeight="700"
								letterSpacing="0.08em"
							>
								DEV BUILD
							</Box>
						)}
					</HStack>

					<Text fontSize="sm" color="gray.400" lineHeight="1.6">
						{body}
					</Text>

					<Box h="1px" bg="whiteAlpha.100" />

					{firmwareHash && <HashRow label="Firmware hash (reported by device)" value={firmwareHash} />}
					{bootloaderHash && (
						<HashRow
							label={`Bootloader hash${bootloaderVerified === true ? " — known" : bootloaderVerified === false ? " — unrecognised" : ""}`}
							value={bootloaderHash}
						/>
					)}
				</VStack>

				<VStack gap={3} align="stretch">
					<VStack gap="3" align="stretch">
						<TrustRow
							actor="checked"
							title="Matches an official release"
							body={
								verdict === "verified"
									? `The hash above is the full-file SHA-256 of the published ${firmwareRelease} binary. Download it and run sha256sum to get the same value.`
									: "The hash above does not match any release pinned in this app."
							}
							action={
								verdict === "verified" && firmwareRelease
									? {
											label: `Open the ${firmwareRelease} release`,
											url: `https://github.com/keepkey/keepkey-firmware/releases/tag/${firmwareRelease}`,
									  }
									: undefined
							}
						/>

						<TrustRow
							actor="verify"
							title="Built from public source"
							body={
								"Releases are built deterministically, so anyone can rebuild this binary " +
								"from the public source and get the same bytes. Vault cannot check that for " +
								"you — it is the one link you have to walk yourself, or take from an " +
								"independent reproducer. Note this proves the binary matches the source, " +
								"not that the source is free of bugs."
							}
							action={{
								label: "How to reproduce the build",
								url: "https://github.com/keepkey/keepkey-firmware/blob/master/docs/ReproducibleBuilds.md",
							}}
						/>

						<TrustRow
							actor="device"
							title="Authorised by the bootloader"
							body={
								"Before it runs anything, your KeepKey checks the firmware carries three " +
								"distinct valid KeepKey signatures. That check is the one that actually " +
								"stops unsigned firmware, and no software on this computer takes part in " +
								"it. If it ever fails, the device says so on its own screen and makes you " +
								"press the button before it will boot."
							}
						/>
					</VStack>

					{/* Two commands, two links in the chain. Shipping only one of them is
					    how people end up comparing a payload hash to a device hash and
					    concluding their wallet is compromised. */}
					{/* ponytail: native <details> — no state, no animation lib. */}
					<Box bg="rgba(0,0,0,0.25)" borderRadius="md" p={2.5} as="details">
						<Text
							as="summary"
							fontSize="2xs"
							color="gray.500"
							cursor="pointer"
							_marker={{ color: "gray.600" }}
						>
							Check it yourself
						</Text>
						<Box h="1.5" />

						<Text fontSize="2xs" fontFamily="mono" color="gray.300">
							sha256sum firmware.keepkey.bin
						</Text>
						<Text fontSize="2xs" color="gray.600" mb="2" lineHeight="1.5">
							On the release binary. Must equal the firmware hash above — that is
							release → device.
						</Text>

						<Text fontSize="2xs" fontFamily="mono" color="gray.300">
							tail -c +257 firmware.keepkey.bin | sha256sum
						</Text>
						<Text fontSize="2xs" color="gray.600" lineHeight="1.5">
							On both the release binary and your own build — that is source →
							release. Your build has no signatures in its 256-byte header, so both
							sides skip it. This is <Text as="span" color="gray.400">not</Text> the
							hash the device reports.
						</Text>
					</Box>

					{/* The limit is the feature. Do not compress it into the tick. */}
					<Text fontSize="2xs" color="gray.600" lineHeight="tall">
						Only the first line was checked here, and it compares what the firmware
						reports about itself against a list built into this app. Treat it as
						corroboration, not proof.
					</Text>
				</VStack>
				</SimpleGrid>
			</Box>

			<Button
				w="100%"
				maxW="360px"
				size="md"
				bg={GOLD}
				color="black"
				fontWeight="700"
				_hover={{ opacity: 0.9 }}
				_active={{ transform: "scale(0.98)" }}
				onClick={onContinue}
			>
				<Flex gap={2} align="center" justify="center">
					<Text>Continue</Text>
					<FaChevronRight size={10} />
				</Flex>
			</Button>
		</VStack>
	)
}
