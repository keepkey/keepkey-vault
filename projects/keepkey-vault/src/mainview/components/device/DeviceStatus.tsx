import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react";
import type { ConnectionStatus, DeviceInfo } from "../../types";

interface DeviceStatusProps {
	status: ConnectionStatus;
	deviceInfo: DeviceInfo | null;
	onRefresh: () => Promise<void>;
}

export function DeviceStatus({ status, deviceInfo, onRefresh }: DeviceStatusProps) {
	if (!status.paired) {
		return (
			<VStack gap="4" align="stretch">
				<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Device</Text>
				<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
					<Text color="kk.textSecondary">
						Pair with keepkey-desktop from the Dashboard to view device details.
					</Text>
				</Box>
			</VStack>
		);
	}

	return (
		<VStack gap="6" align="stretch">
			<Flex alignItems="center" justifyContent="space-between">
				<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Device</Text>
				<Button
					onClick={onRefresh}
					size="sm"
					variant="outline"
					borderColor="kk.border"
					color="kk.textSecondary"
					_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
				>
					Refresh
				</Button>
			</Flex>

			{/* Device Details */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">Device Details</Text>
				{deviceInfo ? (
					<VStack gap="3" align="stretch">
						<DetailRow label="Label" value={deviceInfo.label} />
						<DetailRow label="Vendor" value={deviceInfo.vendor} />
						<DetailRow label="Model" value={deviceInfo.model} />
						<DetailRow label="Device ID" value={deviceInfo.deviceId} />
						<DetailRow label="Firmware" value={deviceInfo.firmwareVersion} />
						<DetailRow label="Initialized" value={deviceInfo.initialized ? "Yes" : "No"} />
						<DetailRow label="PIN Protection" value={deviceInfo.pinProtection ? "Enabled" : "Disabled"} />
						<DetailRow label="Passphrase" value={deviceInfo.passphraseProtection ? "Enabled" : "Disabled"} />
					</VStack>
				) : (
					<Text color="kk.textMuted">Loading device info...</Text>
				)}
			</Box>

			{/* Connection Status */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">Connection</Text>
				<VStack gap="3" align="stretch">
					<Flex alignItems="center" gap="3">
						<Box w="10px" h="10px" borderRadius="full" bg={status.desktop ? "kk.success" : "kk.error"} />
						<Text>keepkey-desktop</Text>
						<Text color="kk.textMuted" fontSize="sm" ml="auto">
							{status.desktop ? "Port 1646" : "Not running"}
						</Text>
					</Flex>
					<Flex alignItems="center" gap="3">
						<Box w="10px" h="10px" borderRadius="full" bg={status.device ? "kk.success" : "kk.error"} />
						<Text>KeepKey Device</Text>
						<Text color="kk.textMuted" fontSize="sm" ml="auto">
							{status.device ? "Connected via USB" : "Disconnected"}
						</Text>
					</Flex>
					<Flex alignItems="center" gap="3">
						<Box w="10px" h="10px" borderRadius="full" bg={status.paired ? "kk.gold" : "kk.textMuted"} />
						<Text>API Pairing</Text>
						<Text color="kk.textMuted" fontSize="sm" ml="auto">
							{status.paired ? "Authenticated" : "Not paired"}
						</Text>
					</Flex>
				</VStack>
			</Box>
		</VStack>
	);
}

function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<Flex>
			<Text color="kk.textSecondary" w="160px" fontSize="sm" flexShrink={0}>{label}</Text>
			<Text fontSize="sm" fontFamily="mono" wordBreak="break-all">{value}</Text>
		</Flex>
	);
}
