import { Flex, Text, Box, Button } from "@chakra-ui/react"

interface TopNavProps {
	label?: string
	connected: boolean
	tab: string
	onTabChange: (tab: any) => void
}

const TABS = [
	{ id: "dashboard", label: "Dashboard" },
	{ id: "device", label: "Device" },
] as const

export function TopNav({ label, connected, tab, onTabChange }: TopNavProps) {
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
			zIndex={1000}
		>
			{/* Left: device status */}
			<Flex align="center" gap="2" minW="180px">
				<Box w="8px" h="8px" borderRadius="full" bg={connected ? "kk.success" : "kk.textMuted"} />
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" truncate>
					{label || "KeepKey"}
				</Text>
			</Flex>

			{/* Center: tabs */}
			<Flex flex="1" justify="center" gap="1">
				{TABS.map((t) => (
					<Button
						key={t.id}
						onClick={() => onTabChange(t.id)}
						size="sm"
						variant="ghost"
						color={tab === t.id ? "kk.gold" : "kk.textSecondary"}
						bg={tab === t.id ? "rgba(255,215,0,0.08)" : "transparent"}
						borderRadius="md"
						fontWeight={tab === t.id ? "600" : "400"}
						fontSize="13px"
						px="4"
						_hover={{ bg: "rgba(255,255,255,0.06)", color: "kk.textPrimary" }}
					>
						{t.label}
					</Button>
				))}
			</Flex>

			{/* Right: spacer for balance */}
			<Box minW="180px" />
		</Flex>
	)
}
