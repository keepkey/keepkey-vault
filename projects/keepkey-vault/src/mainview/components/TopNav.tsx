import { useState } from "react"
import { Flex, Text, Box, Image, IconButton, HStack } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import kkIcon from "../assets/icon.png"

export type NavTab = "vault" | "shapeshift" | "apps"

interface TopNavProps {
	label?: string
	connected: boolean
	firmwareVersion?: string
	firmwareVerified?: boolean
	onSettingsToggle: () => void
	settingsOpen?: boolean
	activeTab: NavTab
	onTabChange: (tab: NavTab) => void
	watchOnly?: boolean
}

/** Grid icon (11px) for Apps tab */
const GridIcon = () => (
	<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
		<rect x="3" y="3" width="7" height="7" />
		<rect x="14" y="3" width="7" height="7" />
		<rect x="14" y="14" width="7" height="7" />
		<rect x="3" y="14" width="7" height="7" />
	</svg>
)

/** macOS-style traffic light buttons */
function TrafficLights() {
	const [hover, setHover] = useState(false)
	const dots: { color: string; hoverColor: string; action: string; icon: JSX.Element | null }[] = [
		{ color: "#FF5F57", hoverColor: "#FF5F57", action: "windowClose", icon: hover ? (
			<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7" stroke="#4D0000" strokeWidth="1.2" strokeLinecap="round" /></svg>
		) : null },
		{ color: "#FEBC2E", hoverColor: "#FEBC2E", action: "windowMinimize", icon: hover ? (
			<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 4h6" stroke="#985600" strokeWidth="1.2" strokeLinecap="round" /></svg>
		) : null },
		{ color: "#28C840", hoverColor: "#28C840", action: "windowMaximize", icon: hover ? (
			<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5L4 0.5L7 2.5V6L4 7.5L1 6z" fill="#006500" /></svg>
		) : null },
	]
	return (
		<Flex
			align="center"
			gap="8px"
			pl="4px"
			pr="4px"
			h="100%"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{ appRegion: "no-drag" } as any}
		>
			{dots.map((d) => (
				<Box
					key={d.action}
					as="button"
					w="12px"
					h="12px"
					borderRadius="full"
					bg={d.color}
					display="flex"
					alignItems="center"
					justifyContent="center"
					cursor="pointer"
					_hover={{ opacity: 0.9 }}
					onClick={() => rpcRequest(d.action as any)}
				>
					{d.icon}
				</Box>
			))}
		</Flex>
	)
}

export function TopNav({ label, connected, firmwareVersion, firmwareVerified, onSettingsToggle, settingsOpen, activeTab, onTabChange, watchOnly }: TopNavProps) {
	const { t } = useTranslation("nav")

	const TAB_DEFS: { id: NavTab; label: string; icon: JSX.Element }[] = [
		{
			id: "apps",
			label: t("apps"),
			icon: <GridIcon />,
		},
		{
			id: "vault",
			label: t("keepkey"),
			icon: <Image src={kkIcon} alt="KeepKey" w="11px" h="11px" borderRadius="2px" />,
		},
		{
			id: "shapeshift",
			label: t("shapeshift"),
			icon: <Image src="https://pioneers.dev/coins/fox.png" alt="ShapeShift" w="11px" h="11px" borderRadius="2px" />,
		},
	]
	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			right={0}
			h="50px"
			bg="rgba(0,0,0,0.92)"
			backdropFilter="blur(12px)"
			borderBottom="1px solid"
			borderColor="kk.border"
			align="center"
			pr="4"
			zIndex={Z.nav}
			style={{ appRegion: "drag" } as any}
		>
			{/* Left: device icon + label */}
			<Flex align="center" gap="2" flex="1" pl="14px">
				<Box position="relative">
					<Image
						src={kkIcon}
						alt="KeepKey"
						w="24px"
						h="24px"
						borderRadius="4px"
					/>
					<Box
						position="absolute"
						bottom="-1px"
						right="-1px"
						w="8px"
						h="8px"
						borderRadius="full"
						bg={connected ? "#3B82F6" : "kk.textMuted"}
						border="2px solid"
						borderColor="rgba(0,0,0,0.92)"
					/>
				</Box>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" truncate>
					{label || "KeepKey"}
				</Text>
				{watchOnly ? (
					<Text fontSize="10px" color="kk.gold" fontWeight="500" bg="rgba(255,215,0,0.12)" px="1.5" py="0.5" borderRadius="sm">
						{t("watchOnly")}
					</Text>
				) : firmwareVersion ? (
					<Flex align="center" gap="1">
						{firmwareVerified === false && (
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
								<path d="M12 2L1 21h22L12 2z" fill="#FB923C" />
								<path d="M12 9v4M12 17h.01" stroke="white" strokeWidth="2" strokeLinecap="round" />
							</svg>
						)}
						<Text fontSize="xs" color={firmwareVerified === false ? "#FB923C" : "#4ADE80"} fontWeight="400">
							v{firmwareVersion}
						</Text>
					</Flex>
				) : null}
			</Flex>

			{/* Center: navigation tabs (icon above label) */}
			<HStack gap="1" style={{ appRegion: "no-drag" } as any}>
				{TAB_DEFS.map((tab) => {
					const isActive = activeTab === tab.id
					return (
						<Box
							key={tab.id}
							as="button"
							display="flex"
							flexDirection="column"
							alignItems="center"
							justifyContent="center"
							gap="0.5"
							px="3"
							py="1"
							borderRadius="md"
							fontWeight="500"
							color={isActive ? "white" : "kk.textMuted"}
							bg={isActive ? "rgba(255,255,255,0.08)" : "transparent"}
							_hover={{ color: "white", bg: "rgba(255,255,255,0.06)" }}
							transition="all 0.15s"
							cursor="pointer"
							onClick={() => onTabChange(tab.id)}
							minW="48px"
						>
							{tab.icon}
							<Text fontSize="9px" lineHeight="1">{tab.label}</Text>
						</Box>
					)
				})}
			</HStack>

			{/* Right: settings gear + traffic lights */}
			<Flex flex="1" justify="flex-end" align="center" gap="2" style={{ appRegion: "no-drag" } as any}>
				<IconButton
					aria-label={t("deviceSettings")}
					onClick={watchOnly ? undefined : onSettingsToggle}
					size="sm"
					variant="ghost"
					color={settingsOpen ? "kk.gold" : "kk.textSecondary"}
					_hover={watchOnly ? {} : { color: "kk.gold", bg: "rgba(255,255,255,0.06)" }}
					disabled={watchOnly}
					opacity={watchOnly ? 0.4 : 1}
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="3" />
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
					</svg>
				</IconButton>
				<TrafficLights />
			</Flex>
		</Flex>
	)
}
