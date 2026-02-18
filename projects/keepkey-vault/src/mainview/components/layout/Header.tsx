import { Flex, Text, Box, HStack } from "@chakra-ui/react";
import type { ConnectionStatus, DeviceInfo } from "../../types";

interface HeaderProps {
	status: ConnectionStatus;
	deviceInfo: DeviceInfo | null;
}

export function Header({ status, deviceInfo }: HeaderProps) {
	return (
		<Flex
			position="fixed"
			top="0"
			left="0"
			right="0"
			h="56px"
			bg="kk.cardBg"
			borderBottom="1px solid"
			borderColor="kk.border"
			alignItems="center"
			px="5"
			zIndex="100"
		>
			<HStack gap="3">
				<Box
					w="8"
					h="8"
					borderRadius="md"
					bg="kk.gold"
					display="flex"
					alignItems="center"
					justifyContent="center"
					fontWeight="bold"
					color="black"
					fontSize="sm"
				>
					KK
				</Box>
				<Text fontWeight="bold" fontSize="lg" color="kk.textPrimary">
					KeepKey Vault
				</Text>
			</HStack>

			<Box flex="1" />

			<HStack gap="4">
				{deviceInfo && (
					<Text fontSize="sm" color="kk.textSecondary">
						{deviceInfo.label}
					</Text>
				)}
				<HStack gap="2">
					<StatusDot
						active={status.desktop}
						label={status.desktop ? "Desktop Connected" : "Desktop Offline"}
					/>
					<StatusDot
						active={status.device}
						label={status.device ? "Device Connected" : "No Device"}
					/>
				</HStack>
			</HStack>
		</Flex>
	);
}

function StatusDot({ active, label }: { active: boolean; label: string }) {
	return (
		<Flex alignItems="center" gap="1.5" title={label}>
			<Box
				w="8px"
				h="8px"
				borderRadius="full"
				bg={active ? "kk.success" : "kk.error"}
			/>
			<Text fontSize="xs" color="kk.textMuted">
				{label}
			</Text>
		</Flex>
	);
}
