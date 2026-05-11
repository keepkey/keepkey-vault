import { Flex, Text, Box, Image, IconButton, HStack } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../lib/z-index"
import { IS_WINDOWS, IS_MAC } from "../lib/platform"
import { useWindowDrag } from "../hooks/useWindowDrag"
import { rpcRequest } from "../lib/rpc"
import kkIcon from "../assets/icon.png"

export type NavTab = "vault" | "shapeshift" | "apps"

interface TopNavProps {
	label?: string
	connected: boolean
	firmwareVersion?: string
	firmwareVerified?: boolean
	needsFirmwareUpdate?: boolean
	latestFirmware?: string
	isEmulator?: boolean
	onSettingsToggle: () => void
	onMobileToggle?: () => void
	onWalletConnectToggle?: () => void
	settingsOpen?: boolean
	mobileOpen?: boolean
	walletConnectOpen?: boolean
	activeTab: NavTab
	onTabChange: (tab: NavTab) => void
	watchOnly?: boolean
	onExitToDeviceSelect?: () => void
	passphraseActive?: boolean
}

/* The bar height is locked at 50px because App.tsx pads its main content
   area by `pt="54px"` (nav + 4px gap). Changing this would mis-align every
   ready-phase screen — adjust both, not just one. */
const NAV_H = "50px"

const NAV_BG = "rgba(11,11,14,0.92)"
const FONT_SANS = "var(--font-sans, 'Space Grotesk', system-ui, sans-serif)"
const FONT_MONO = "var(--font-mono, 'Geist Mono', ui-monospace, monospace)"

/** Lock icon for passphrase mode */
const PassphraseLockIcon = () => (
	<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
		<path d="M7 11V7a5 5 0 0 1 10 0v4" />
	</svg>
)

/** Construction/hard-hat icon for dev firmware */
const ConstructionIcon = () => (
	<svg width="11" height="11" viewBox="0 0 24 24" fill="none">
		<path d="M2 20h20v2H2zM4 18h16v-2H4z" fill="var(--violet)" />
		<path d="M12 2C8.69 2 6 4.69 6 8v2h12V8c0-3.31-2.69-6-6-6z" fill="var(--violet)" />
		<rect x="5" y="10" width="14" height="3" rx="1" fill="var(--violet)" opacity="0.7" />
	</svg>
)

/** Shield icon for verified/signed firmware */
const ShieldCheckIcon = ({ color }: { color: string }) => (
	<svg width="11" height="11" viewBox="0 0 24 24" fill="none">
		<path d="M12 2L3 7v5c0 5.25 3.75 10.14 9 11.25C17.25 22.14 21 17.25 21 12V7l-9-5z" fill={color} fillOpacity="0.18" stroke={color} strokeWidth="2" />
		<path d="M9 12l2 2 4-4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
)

/** Logo tile reused by both nav variants. Subtle ambient glow when active
    /signing — gold/teal hint without the alarm-bell red of the old border. */
const LogoTile = ({ glow, onClick, title }: { glow?: 'idle' | 'connected' | 'signing'; onClick?: () => void; title?: string }) => {
	const halo =
		glow === 'signing'   ? '0 0 14px rgba(233,196,106,0.45)'
		: glow === 'connected' ? '0 0 12px rgba(139,227,196,0.30)'
		: 'none'
	return (
		<Box
			as="button"
			onClick={onClick}
			title={title}
			className="electrobun-webkit-app-region-no-drag"
			cursor={onClick ? "pointer" : "default"}
			w="29px"
			h="29px"
			borderRadius="7px"
			bg="#000"
			border="1px solid var(--line-2)"
			overflow="hidden"
			boxShadow={halo}
			transition="box-shadow 0.4s"
			flexShrink={0}
			p={0}
			display="grid"
			placeItems="center"
		>
			<Image src={kkIcon} alt="KeepKey" w="100%" h="100%" objectFit="cover" />
		</Box>
	)
}

/** Minimal nav bar for splash / setup phases. */
export function SplashNav() {
	const windowDrag = useWindowDrag()
	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			right={0}
			h={NAV_H}
			bg={NAV_BG}
			backdropFilter="blur(20px)"
			borderBottom="1px solid var(--line)"
			align="center"
			px="4"
			zIndex={Z.nav}
			{...(IS_MAC ? { className: "electrobun-webkit-app-region-drag" } : {})}
			{...(windowDrag ? { onMouseDown: windowDrag.onMouseDown } : {})}
			onDoubleClick={IS_WINDOWS ? () => rpcRequest("windowMaximize") : undefined}
		>
			<Flex align="center" gap="2.5">
				<LogoTile />
				<Text fontSize="13px" fontWeight="600" letterSpacing="-0.01em" color="var(--text-0)" fontFamily={FONT_SANS}>
					KeepKey Vault
				</Text>
			</Flex>
		</Flex>
	)
}

export function TopNav({
	label,
	connected,
	firmwareVersion,
	firmwareVerified,
	needsFirmwareUpdate,
	latestFirmware,
	isEmulator,
	onSettingsToggle,
	onMobileToggle,
	onWalletConnectToggle,
	settingsOpen,
	mobileOpen,
	walletConnectOpen,
	activeTab,
	onTabChange,
	watchOnly,
	onExitToDeviceSelect,
	passphraseActive,
}: TopNavProps) {
	const { t } = useTranslation("nav")
	const windowDrag = useWindowDrag()

	const TAB_DEFS: { id: NavTab; label: string; icon: JSX.Element }[] = [
		{
			id: "apps",
			label: t("apps"),
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
					<rect x="3" y="3" width="7" height="7" rx="1.5"/>
					<rect x="14" y="3" width="7" height="7" rx="1.5"/>
					<rect x="3" y="14" width="7" height="7" rx="1.5"/>
					<rect x="14" y="14" width="7" height="7" rx="1.5"/>
				</svg>
			),
		},
		{
			id: "vault",
			label: t("keepkey"),
			icon: <Image src={kkIcon} alt="KeepKey" w="14px" h="14px" borderRadius="3px" />,
		},
		{
			id: "shapeshift",
			label: t("shapeshift"),
			icon: <Image src="https://pioneers.dev/coins/fox.png" alt="ShapeShift" w="14px" h="14px" borderRadius="3px" />,
		},
	]

	const dotColor = connected ? "var(--teal)" : "var(--text-3)"
	const logoGlow = passphraseActive ? 'signing' : connected ? 'connected' : 'idle'

	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			right={0}
			h={NAV_H}
			bg={NAV_BG}
			backdropFilter="blur(20px)"
			borderBottom="1px solid var(--line)"
			align="center"
			px="4"
			zIndex={Z.nav}
			{...(IS_MAC ? { className: "electrobun-webkit-app-region-drag" } : {})}
			{...(windowDrag ? { onMouseDown: windowDrag.onMouseDown } : {})}
			onDoubleClick={IS_WINDOWS ? () => rpcRequest("windowMaximize") : undefined}
		>
			{/* Left: logo tile + identity stack */}
			<Flex align="center" gap="2.5" flex="1" minW={0}>
				<LogoTile
					glow={logoGlow}
					onClick={onExitToDeviceSelect || (() => rpcRequest("openUrl", { url: "https://keepkey.com" }).catch(() => {}))}
					title={onExitToDeviceSelect ? "Back to device select" : "KeepKey"}
				/>
				<Flex direction="column" minW={0} gap="0">
					<Flex align="center" gap="1.5" minW={0}>
						<Text fontSize="13px" fontWeight="600" letterSpacing="-0.01em" color="var(--text-0)" fontFamily={FONT_SANS} truncate>
							{label || "KeepKey"}
						</Text>
						{watchOnly && (
							<Text fontSize="9.5px" color="var(--gold)" fontWeight="500" bg="rgba(233,196,106,0.10)" px="1.5" py="0.5" borderRadius="sm" letterSpacing="0.04em" textTransform="uppercase" fontFamily={FONT_MONO}>
								{t("watchOnly")}
							</Text>
						)}
						{watchOnly && onExitToDeviceSelect && (
							<Box
								as="button"
								fontSize="9.5px"
								color="var(--text-2)"
								fontWeight="500"
								px="1.5"
								py="0.5"
								borderRadius="sm"
								bg="var(--ink-3)"
								border="1px solid var(--line)"
								cursor="pointer"
								_hover={{ color: "var(--text-0)", bg: "var(--ink-4)" }}
								transition="all 0.15s"
								onClick={onExitToDeviceSelect}
								className="electrobun-webkit-app-region-no-drag"
								fontFamily={FONT_MONO}
							>
								Exit
							</Box>
						)}
						{isEmulator && (
							<>
								<Text fontSize="9px" color="var(--rose)" fontWeight="600" bg="rgba(224,140,123,0.12)" px="1.5" py="0.5" borderRadius="sm" textTransform="uppercase" letterSpacing="0.08em" fontFamily={FONT_MONO}>
									EMU
								</Text>
								{onExitToDeviceSelect && (
									<Box
										as="button"
										w="14px"
										h="14px"
										borderRadius="full"
										display="flex"
										alignItems="center"
										justifyContent="center"
										fontSize="9px"
										fontWeight="700"
										color="var(--rose)"
										bg="rgba(224,140,123,0.10)"
										border="1px solid rgba(224,140,123,0.3)"
										cursor="pointer"
										_hover={{ bg: "rgba(224,140,123,0.25)" }}
										transition="all 0.15s"
										onClick={onExitToDeviceSelect}
										className="electrobun-webkit-app-region-no-drag"
										title="Back to device select"
									>
										&times;
									</Box>
								)}
							</>
						)}
						{passphraseActive && (
							<Flex align="center" gap="0.5" bg="rgba(233,196,106,0.10)" px="1.5" py="0.5" borderRadius="sm" color="var(--gold)">
								<PassphraseLockIcon />
								<Text fontSize="9px" fontWeight="500" letterSpacing="0.04em" textTransform="uppercase" fontFamily={FONT_MONO}>
									{t("passphraseMode")}
								</Text>
							</Flex>
						)}
					</Flex>
					{/* Sub-line: connection dot + version. Replaces the hot kk.gold border
					    of the old layout — same information, calmer signal. */}
					{!watchOnly && firmwareVersion ? (
						<Flex align="center" gap="1" mt="1px" lineHeight="1">
							<Box w="5px" h="5px" borderRadius="full" bg={dotColor} />
							{firmwareVerified === false ? (
								<>
									<ConstructionIcon />
									<Text fontSize="10px" color="var(--violet)" fontFamily={FONT_MONO} letterSpacing="0.02em">
										v{firmwareVersion} · dev
									</Text>
								</>
							) : needsFirmwareUpdate ? (
								<>
									<ShieldCheckIcon color="var(--gold)" />
									<Text fontSize="10px" color="var(--gold)" fontFamily={FONT_MONO} letterSpacing="0.02em">
										v{firmwareVersion}{latestFirmware ? ` → v${latestFirmware}` : ""}
									</Text>
								</>
							) : (
								<>
									<ShieldCheckIcon color="var(--teal)" />
									<Text fontSize="10px" color="var(--text-2)" fontFamily={FONT_MONO} letterSpacing="0.02em">
										v{firmwareVersion} · {connected ? "connected" : "offline"}
									</Text>
								</>
							)}
						</Flex>
					) : !watchOnly ? (
						<Flex align="center" gap="1" mt="1px" lineHeight="1">
							<Box w="5px" h="5px" borderRadius="full" bg={dotColor} />
							<Text fontSize="10px" color="var(--text-3)" fontFamily={FONT_MONO} letterSpacing="0.02em">
								{connected ? "connected" : "offline"}
							</Text>
						</Flex>
					) : null}
				</Flex>
			</Flex>

			{/* Center: pill-style section nav */}
			<HStack
				gap="0"
				bg="var(--ink-2)"
				border="1px solid var(--line)"
				borderRadius="999px"
				p="3px"
				className="electrobun-webkit-app-region-no-drag"
			>
				{TAB_DEFS.map((tab) => {
					const isActive = activeTab === tab.id
					return (
						<Box
							key={tab.id}
							as="button"
							display="flex"
							alignItems="center"
							gap="1.5"
							px="2.5"
							py="1"
							borderRadius="999px"
							fontSize="11.5px"
							fontWeight="500"
							fontFamily={FONT_SANS}
							letterSpacing="-0.005em"
							color={isActive ? "var(--text-0)" : "var(--text-2)"}
							bg={isActive ? "var(--ink-4)" : "transparent"}
							_hover={{ color: "var(--text-0)", bg: isActive ? "var(--ink-4)" : "var(--ink-3)" }}
							transition="all 0.18s"
							cursor="pointer"
							onClick={() => onTabChange(tab.id)}
						>
							{tab.icon}
							{tab.label}
						</Box>
					)
				})}
			</HStack>

			{/* Right: walletconnect + mobile + settings */}
			<Flex flex="1" justify="flex-end" align="center" gap="1">
				{onWalletConnectToggle && (
					<IconButton
						aria-label={t("walletConnect", { defaultValue: "WalletConnect" })}
						onClick={onWalletConnectToggle}
						size="sm"
						variant="ghost"
						color={walletConnectOpen ? "var(--gold)" : "var(--text-2)"}
						_hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }}
						className="electrobun-webkit-app-region-no-drag"
					>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
							<path d="M5.5 9.5c3.6-3.6 9.4-3.6 13 0" />
							<path d="M3 12l3 3 3-3 3 3 3-3 3 3 3-3" />
						</svg>
					</IconButton>
				)}
				{onMobileToggle && (
					<IconButton
						aria-label={t("mobileApp", { defaultValue: "Mobile App" })}
						onClick={onMobileToggle}
						size="sm"
						variant="ghost"
						color={mobileOpen ? "var(--gold)" : "var(--text-2)"}
						_hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }}
						className="electrobun-webkit-app-region-no-drag"
					>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
							<rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
							<line x1="12" y1="18" x2="12.01" y2="18" />
						</svg>
					</IconButton>
				)}
				<IconButton
					aria-label={t("deviceSettings")}
					onClick={onSettingsToggle}
					size="sm"
					variant="ghost"
					color={settingsOpen ? "var(--gold)" : "var(--text-2)"}
					_hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }}
					className="electrobun-webkit-app-region-no-drag"
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="3" />
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
					</svg>
				</IconButton>
			</Flex>
		</Flex>
	)
}
