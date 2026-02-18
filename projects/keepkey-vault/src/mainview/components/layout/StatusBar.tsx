import { Flex, Text, Box, HStack } from "@chakra-ui/react";
import type { ConnectionStatus } from "../../types";

interface StatusBarProps {
	status: ConnectionStatus;
}

export function StatusBar({ status }: StatusBarProps) {
	const desktopLabel = status.desktop ? "Desktop: Connected" : "Desktop: Offline";
	const deviceLabel = status.device ? "Device: Connected" : "Device: Disconnected";
	const pairLabel = status.paired ? "Paired" : "Not Paired";

	return (
		<Flex
			position="fixed"
			bottom="0"
			left="0"
			right="0"
			h="32px"
			bg="kk.cardBg"
			borderTop="1px solid"
			borderColor="kk.border"
			alignItems="center"
			px="4"
			zIndex="100"
		>
			<HStack gap="4" fontSize="xs" color="kk.textMuted">
				<HStack gap="1.5">
					<Box w="6px" h="6px" borderRadius="full" bg={status.desktop ? "kk.success" : "kk.error"} />
					<Text>{desktopLabel}</Text>
				</HStack>
				<HStack gap="1.5">
					<Box w="6px" h="6px" borderRadius="full" bg={status.device ? "kk.success" : "kk.error"} />
					<Text>{deviceLabel}</Text>
				</HStack>
				<HStack gap="1.5">
					<Box w="6px" h="6px" borderRadius="full" bg={status.paired ? "kk.gold" : "kk.textMuted"} />
					<Text>{pairLabel}</Text>
				</HStack>
			</HStack>
			<Box flex="1" />
			<Text fontSize="xs" color="kk.textMuted">
				KeepKey Vault v0.1.0
			</Text>
		</Flex>
	);
}
