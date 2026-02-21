import { Flex, Text, Box, Image, IconButton } from "@chakra-ui/react"
import { Z } from "../lib/z-index"
import kkIcon from "../assets/icon.png"

interface TopNavProps {
	label?: string
	connected: boolean
	firmwareVersion?: string
	onSettingsToggle: () => void
	settingsOpen?: boolean
}

export function TopNav({ label, connected, firmwareVersion, onSettingsToggle, settingsOpen }: TopNavProps) {
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
			px="4"
			zIndex={Z.nav}
		>
			{/* Left: device icon + label */}
			<Flex align="center" gap="2" flex="1">
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
				{firmwareVersion && (
					<Text fontSize="xs" color="#4ADE80" fontWeight="400">
						v{firmwareVersion}
					</Text>
				)}
			</Flex>

			{/* Right: settings gear */}
			<IconButton
				aria-label="Device settings"
				onClick={onSettingsToggle}
				size="sm"
				variant="ghost"
				color={settingsOpen ? "kk.gold" : "kk.textSecondary"}
				_hover={{ color: "kk.gold", bg: "rgba(255,255,255,0.06)" }}
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<circle cx="12" cy="12" r="3" />
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
				</svg>
			</IconButton>
		</Flex>
	)
}
