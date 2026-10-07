/**
 * First screen of the setup wizard — before the tutorial cards, before
 * anything is written to the device: is this a genuine KeepKey?
 *
 * THE CLAIM THIS SCREEN MAKES, AND THE ONE IT DOES NOT. The device reports
 * SHA-256(meta_descriptor + app_code), which equals the full-file hash of the
 * released .bin and, because the meta descriptor covers the signature slots,
 * pins the exact signed artifact. It also reports its bootloader hash. We look
 * both up in release tables shipped with this app.
 *
 * That is corroboration, not proof: the device self-reports the hashes. What
 * actually refuses to run unsigned firmware silently is the bootloader's
 * signature check, on the device, at every power-on. The headline is earned
 * by a release match; the "How this is checked" panel keeps the limits and
 * the commands to check it yourself one click away.
 *
 * A brand-new device runs factory firmware too old to report a hash. Its
 * bootloader still reports one, so a known bootloader is enough to say
 * "genuine" — the factory firmware is replaced in the next step anyway.
 */
import type { ComponentProps, ReactNode } from "react"
import { Box, Button, Flex, HStack, SimpleGrid, Text, VStack } from "@chakra-ui/react"
import { FaCheck, FaChevronRight, FaKey, FaShieldAlt } from "react-icons/fa"
import { rpcRequest } from "../lib/rpc"
import { authenticityVerdict } from "../../shared/firmware-authenticity"

const GOLD = "#E9C46A"
const GREEN = "#48BB78"
const AMBER = "#ED8936"


function openUrl(url: string) {
	// target="_blank" is a dead click in Electrobun.
	rpcRequest("openUrl", { url }).catch(() => {})
}

/** Seal that draws itself once: ring, then tick. Static under reduced motion. */
function Seal() {
	return (
		<Box position="relative" w="60px" h="60px" flexShrink={0} className="kkAuthSeal">
			<svg width="60" height="60" viewBox="0 0 92 92" aria-hidden="true">
				<circle cx="46" cy="46" r="40" fill="none" stroke="rgba(72,187,120,0.15)" strokeWidth="6" />
				<circle className="kkAuthRing" cx="46" cy="46" r="40" fill="none" stroke={GREEN} strokeWidth="6"
					strokeLinecap="round" transform="rotate(-90 46 46)" />
				<path className="kkAuthTick" d="M30 47 L41 58 L63 35" fill="none" stroke={GREEN} strokeWidth="7"
					strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</Box>
	)
}

type RowTone = "pass" | "info" | "warn"

function CheckRow({ icon, tone, title, detail, who, index }: {
	icon: ReactNode
	tone: RowTone
	title: string
	detail: string
	who: string
	index: number
}) {
	const color = tone === "pass" ? GREEN : tone === "warn" ? AMBER : GOLD
	return (
		<HStack gap="2.5" align="start" w="100%" className="kkAuthRow" style={{ animationDelay: `${450 + index * 120}ms` }}>
			<Flex flexShrink={0} w="24px" h="24px" borderRadius="full" align="center" justify="center"
				bg={`${color}1F`} color={color} border="1px solid" borderColor={`${color}55`}>
				{icon}
			</Flex>
			<VStack gap="0" align="start" flex="1" minW={0}>
				<HStack gap="2" flexWrap="wrap">
					<Text fontSize="sm" fontWeight="600" color="gray.100">{title}</Text>
					<Text fontSize="2xs" color="gray.500" letterSpacing="0.04em" textTransform="uppercase">{who}</Text>
				</HStack>
				<Text fontSize="xs" color="gray.400" lineHeight="1.4">{detail}</Text>
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
	bootloaderRelease,
	firmwareSignaturesVerified,
	installFirmware,
	installBootloader,
	onContinue,
}: {
	firmwareHash?: string
	firmwareRelease?: string
	firmwareVerified?: boolean
	bootloaderHash?: string
	bootloaderVerified?: boolean
	bootloaderRelease?: string
	firmwareSignaturesVerified?: boolean
	installFirmware?: { version: string; signed: boolean }
	installBootloader?: { version: string; signed: boolean }
	onContinue: () => void
}) {
	const verdict = authenticityVerdict(firmwareHash, firmwareVerified, bootloaderVerified)
	const passed = verdict === "verified" || verdict === "genuine"

	const headline = passed
		? "Genuine KeepKey"
		: verdict === "unrecognized" ? "Firmware not in the release list" : "Firmware can't be checked"

	const subline = verdict === "verified"
		? firmwareSignaturesVerified
			? `Firmware${firmwareRelease ? ` ${firmwareRelease}` : ""} is signed by KeepKey. Desktop verified its release signatures.`
			: `Firmware${firmwareRelease ? ` ${firmwareRelease}` : ""} matches an official KeepKey release.`
		: verdict === "genuine"
			? `Its bootloader${bootloaderRelease ? ` ${bootloaderRelease}` : ""} matches an official KeepKey release.`
			: verdict === "unrecognized"
				? "This may be a custom, Bitcoin-only, or modified build. Compare its hash with the build you expected, and confirm the device showed no warning at startup."
				: "This firmware is too old to report its hash. The bootloader still checks firmware signatures before startup."

	const rows: Array<Omit<ComponentProps<typeof CheckRow>, "index">> = []
	if (bootloaderVerified === true) {
		rows.push({ icon: <FaCheck size={11} />, tone: "pass", title: "Bootloader", who: "Desktop checked",
			detail: `Official KeepKey release${bootloaderRelease ? ` ${bootloaderRelease}` : ""}.` })
	} else if (bootloaderVerified === false) {
		rows.push({ icon: <FaShieldAlt size={11} />, tone: "warn", title: "Bootloader", who: "Desktop checked",
			detail: "Not in the release list. Compare its hash with the bootloader you expected." })
	}
	if (verdict === "verified") {
		rows.push({ icon: <FaCheck size={11} />, tone: "pass", title: firmwareSignaturesVerified ? "Firmware signed by KeepKey" : "Firmware", who: "Desktop checked",
			detail: firmwareSignaturesVerified
				? `${firmwareRelease ? `Release ${firmwareRelease} carries` : "Carries"} three valid KeepKey release signatures.`
				: `Official KeepKey release${firmwareRelease ? ` ${firmwareRelease}` : ""}.` })
	} else if (verdict === "genuine") {
		// The factory firmware reports nothing to check, but what Desktop is about
		// to install is in hand: its release signatures are verified right here.
		const signedInstalls = [
			installFirmware?.signed && `firmware ${installFirmware.version}`,
			installBootloader?.signed && `bootloader ${installBootloader.version}`,
		].filter(Boolean) as string[]
		rows.push(signedInstalls.length
			? { icon: <FaCheck size={11} />, tone: "pass", title: "Update signed by KeepKey", who: "Desktop checked",
				detail: `Next, Desktop installs ${signedInstalls.join(" and ")}. Their KeepKey release signatures verified.` }
			: { icon: <FaChevronRight size={10} />, tone: "info", title: "Firmware", who: "Next step",
				detail: "Your KeepKey ships with factory firmware. Desktop installs the latest official firmware next." })
	}
	rows.push({ icon: <FaShieldAlt size={11} />, tone: passed ? "pass" : "info", title: "Signature check", who: "On the device",
		detail: "Before it runs any firmware, your KeepKey checks it for KeepKey's release signatures and warns you if they are missing." })
	if (passed) {
		rows.push({ icon: <FaKey size={10} />, tone: "pass", title: "Recovery phrase", who: "On the device",
			detail: "Created on your KeepKey and shown only on its screen. It never leaves the device." })
	}

	const accent = passed ? GREEN : verdict === "unrecognized" ? AMBER : "gray.500"

	return (
		<VStack gap={3} w="100%" maxW="760px" mx="auto">
			<style>{`
				.kkAuthRing { stroke-dasharray: 252; stroke-dashoffset: 252; animation: kkAuthDraw 700ms ease-out 100ms forwards; }
				.kkAuthTick { stroke-dasharray: 50; stroke-dashoffset: 50; animation: kkAuthDraw 350ms ease-out 650ms forwards; }
				.kkAuthSeal { animation: kkAuthGlow 1600ms ease-out 900ms 1; border-radius: 9999px; }
				.kkAuthRow { animation: kkAuthRise 380ms ease-out both; }
				@keyframes kkAuthDraw { to { stroke-dashoffset: 0; } }
				@keyframes kkAuthGlow { 0% { box-shadow: 0 0 0 0 rgba(72,187,120,0.45); } 100% { box-shadow: 0 0 0 26px rgba(72,187,120,0); } }
				@keyframes kkAuthRise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
				@media (prefers-reduced-motion: reduce) {
					.kkAuthRing, .kkAuthTick { animation: none; stroke-dashoffset: 0; }
					.kkAuthSeal, .kkAuthRow { animation: none; }
				}
			`}</style>

			<Box w="100%" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor={passed ? `${GREEN}40` : `${GOLD}33`}
				borderRadius="2xl" p={{ base: 4, md: 5 }}>
				<VStack gap={4} align="stretch">
					{passed ? (
						<HStack gap={4} align="center">
							<Seal />
							<VStack gap="0.5" align="start" minW={0}>
								<Text fontSize="2xl" fontWeight="800" color="white" letterSpacing="-0.02em" lineHeight="1.15">
									{headline}
								</Text>
								<Text fontSize="sm" color="gray.400">{subline}</Text>
							</VStack>
						</HStack>
					) : (
						<VStack gap={2} align="stretch">
							<HStack gap={3} align="center">
								<Box color={accent}><FaShieldAlt size={22} /></Box>
								<Text fontSize="lg" fontWeight="800" color="white" letterSpacing="-0.02em">{headline}</Text>
								{verdict === "unrecognized" && (
									<Box flexShrink={0} px="2" py="0.5" borderRadius="full" border="1px solid" borderColor={AMBER}
										color={AMBER} fontSize="2xs" fontWeight="700" letterSpacing="0.08em">
										UNLISTED
									</Box>
								)}
							</HStack>
							<Text fontSize="sm" color="gray.400" lineHeight="1.5">{subline}</Text>
						</VStack>
					)}

					<SimpleGrid columns={{ base: 1, md: 2 }} gapX={5} gapY={3}>
						{rows.map((r, i) => <CheckRow key={r.title} index={i} {...r} />)}
					</SimpleGrid>

					{/* The limits and the do-it-yourself path stay one click away.
					    ponytail: native <details> — no state, no animation lib. */}
					<Box bg="rgba(0,0,0,0.25)" borderRadius="md" px={3} py={2} as="details">
						<Text as="summary" fontSize="xs" color="gray.500" cursor="pointer" _marker={{ color: "gray.600" }}>
							How this is checked
						</Text>
						<VStack gap={3} align="stretch" mt={3}>
							<Text fontSize="2xs" color="gray.500" lineHeight="1.6">
								Your KeepKey reports the hashes of its bootloader and firmware. Desktop compares them with
								KeepKey's published releases, using a list shipped with the app. This is a cross-check, not
								independent proof. The signature check that actually guards your device runs on the device itself.
							</Text>
							{firmwareHash && <HashRow label="Firmware · reported by device" value={firmwareHash} />}
							{bootloaderHash && (
								<HashRow
									label={`Bootloader${bootloaderVerified === true ? ` · official${bootloaderRelease ? ` ${bootloaderRelease}` : ""}` : bootloaderVerified === false ? " · unrecognized" : ""}`}
									value={bootloaderHash}
								/>
							)}
							<HStack gap={4} flexWrap="wrap">
								{verdict === "verified" && firmwareRelease && (
									<Box as="button" type="button" fontSize="2xs" color={GOLD} textDecoration="underline"
										onClick={() => openUrl(`https://github.com/keepkey/keepkey-firmware/releases/tag/${firmwareRelease}`)}>
										Open the {firmwareRelease} release
									</Box>
								)}
								<Box as="button" type="button" fontSize="2xs" color={GOLD} textDecoration="underline"
									onClick={() => openUrl("https://github.com/keepkey/keepkey-firmware/blob/master/docs/ReproducibleBuilds.md")}>
									How to reproduce the build
								</Box>
							</HStack>
							{/* Two commands, two links in the chain. Shipping only one of them is
							    how people end up comparing a payload hash to a device hash and
							    concluding their wallet is compromised. */}
							<Box>
								<Text fontSize="2xs" fontFamily="mono" color="gray.300">sha256sum firmware.keepkey.bin</Text>
								<Text fontSize="2xs" color="gray.600" mb="2" lineHeight="1.5">
									Run on the release binary. It must match the firmware hash shown here.
								</Text>
								<Text fontSize="2xs" fontFamily="mono" color="gray.300">tail -c +257 firmware.keepkey.bin | sha256sum</Text>
								<Text fontSize="2xs" color="gray.600" lineHeight="1.5">
									Run on the release and your own build to compare unsigned app code.
									This is <Text as="span" color="gray.400">not</Text> the device-reported hash.
								</Text>
							</Box>
						</VStack>
					</Box>
				</VStack>
			</Box>

			<Button w="100%" maxW="360px" size="md" bg={GOLD} color="black" fontWeight="700"
				_hover={{ opacity: 0.9 }} _active={{ transform: "scale(0.98)" }} onClick={onContinue}>
				<Flex gap={2} align="center" justify="center">
					<Text>{verdict === "unrecognized" ? "Continue with this build" : passed ? "Set up my KeepKey" : "Continue"}</Text>
					<FaChevronRight size={10} />
				</Flex>
			</Button>
		</VStack>
	)
}
