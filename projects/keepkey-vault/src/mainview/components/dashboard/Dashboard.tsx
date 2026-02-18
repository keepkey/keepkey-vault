import { Box, Text, VStack, HStack, Flex, Button } from "@chakra-ui/react";
import { useNavigate } from "react-router-dom";
import {
	MdAccountBalanceWallet,
	MdEdit,
	MdDevices,
} from "react-icons/md";
import type { ConnectionStatus, DeviceInfo } from "../../types";

interface DashboardProps {
	status: ConnectionStatus;
	deviceInfo: DeviceInfo | null;
	onPair: () => Promise<boolean>;
	pairing: boolean;
	error: string | null;
}

export function Dashboard({ status, deviceInfo, onPair, pairing, error }: DashboardProps) {
	const navigate = useNavigate();

	return (
		<VStack gap="6" align="stretch">
			<Text fontSize="2xl" fontWeight="bold" color="kk.gold">
				Dashboard
			</Text>

			{/* Connection Status Card */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">
					Connection Status
				</Text>
				<VStack gap="3" align="stretch">
					<StatusRow
						label="keepkey-desktop"
						connected={status.desktop}
						detail={status.desktop ? "Running on port 1646" : "Not detected"}
					/>
					<StatusRow
						label="Device"
						connected={status.device}
						detail={status.device && deviceInfo ? `${deviceInfo.label} (${deviceInfo.firmwareVersion})` : "Not connected"}
					/>
					<StatusRow
						label="API Paired"
						connected={status.paired}
						detail={status.paired ? "Authenticated" : "Not paired"}
					/>
				</VStack>

				{!status.paired && status.desktop && (
					<Box mt="4">
						<Button
							onClick={onPair}
							disabled={pairing}
							bg="kk.gold"
							color="black"
							fontWeight="semibold"
							_hover={{ bg: "kk.goldHover" }}
							size="sm"
						>
							{pairing ? "Pairing..." : "Pair with KeepKey Desktop"}
						</Button>
						{error && (
							<Text color="kk.error" fontSize="sm" mt="2">
								{error}
							</Text>
						)}
					</Box>
				)}

				{!status.desktop && (
					<Text color="kk.textMuted" fontSize="sm" mt="4">
						Start keepkey-desktop to connect your device.
					</Text>
				)}
			</Box>

			{/* Device Info Card */}
			{deviceInfo && (
				<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
					<Text fontSize="lg" fontWeight="semibold" mb="4">
						Device Info
					</Text>
					<VStack gap="2" align="stretch">
						<InfoRow label="Label" value={deviceInfo.label} />
						<InfoRow label="Model" value={deviceInfo.model} />
						<InfoRow label="Firmware" value={deviceInfo.firmwareVersion} />
						<InfoRow label="Device ID" value={deviceInfo.deviceId} />
						<InfoRow label="PIN Protection" value={deviceInfo.pinProtection ? "Enabled" : "Disabled"} />
						<InfoRow label="Passphrase" value={deviceInfo.passphraseProtection ? "Enabled" : "Disabled"} />
					</VStack>
				</Box>
			)}

			{/* Quick Actions */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">
					Quick Actions
				</Text>
				<HStack gap="4" flexWrap="wrap">
					<ActionCard
						icon={<MdAccountBalanceWallet size={24} />}
						label="Addresses"
						description="Derive wallet addresses"
						onClick={() => navigate("/addresses")}
						disabled={!status.paired}
					/>
					<ActionCard
						icon={<MdEdit size={24} />}
						label="Sign"
						description="Sign transactions"
						onClick={() => navigate("/sign")}
						disabled={!status.paired}
					/>
					<ActionCard
						icon={<MdDevices size={24} />}
						label="Device"
						description="Device management"
						onClick={() => navigate("/device")}
						disabled={!status.paired}
					/>
				</HStack>
			</Box>
		</VStack>
	);
}

function StatusRow({ label, connected, detail }: { label: string; connected: boolean; detail: string }) {
	return (
		<Flex alignItems="center" gap="3">
			<Box w="8px" h="8px" borderRadius="full" bg={connected ? "kk.success" : "kk.error"} />
			<Text fontWeight="medium" w="140px">{label}</Text>
			<Text color="kk.textSecondary" fontSize="sm">{detail}</Text>
		</Flex>
	);
}

function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<Flex>
			<Text color="kk.textSecondary" w="140px" fontSize="sm">{label}</Text>
			<Text fontSize="sm" fontFamily="mono">{value}</Text>
		</Flex>
	);
}

function ActionCard({
	icon,
	label,
	description,
	onClick,
	disabled,
}: {
	icon: React.ReactNode;
	label: string;
	description: string;
	onClick: () => void;
	disabled: boolean;
}) {
	return (
		<Box
			as="button"
			onClick={onClick}
			disabled={disabled}
			bg="kk.bg"
			border="1px solid"
			borderColor="kk.border"
			borderRadius="lg"
			p="4"
			minW="160px"
			textAlign="left"
			cursor={disabled ? "not-allowed" : "pointer"}
			opacity={disabled ? 0.5 : 1}
			_hover={disabled ? {} : { borderColor: "kk.gold", bg: "kk.cardBgHover" }}
			transition="all 0.15s ease"
		>
			<Box color="kk.gold" mb="2">{icon}</Box>
			<Text fontWeight="semibold" fontSize="sm">{label}</Text>
			<Text color="kk.textMuted" fontSize="xs">{description}</Text>
		</Box>
	);
}
