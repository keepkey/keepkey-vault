import { useState } from "react";
import { Box, Text, VStack, Flex, Button, Input } from "@chakra-ui/react";
import { useApi } from "../../hooks/useApi";

interface DeviceSettingsProps {
	paired: boolean;
}

export function DeviceSettings({ paired }: DeviceSettingsProps) {
	const { call, api, loading, error } = useApi();
	const [label, setLabel] = useState("");
	const [message, setMessage] = useState<string | null>(null);

	if (!paired) {
		return (
			<VStack gap="4" align="stretch">
				<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Settings</Text>
				<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
					<Text color="kk.textSecondary">
						Pair with keepkey-desktop from the Dashboard to manage device settings.
					</Text>
				</Box>
			</VStack>
		);
	}

	const handleSetLabel = async () => {
		if (!label.trim()) return;
		const result = await call(() => api.applySettings({ label: label.trim() }));
		if (result) {
			setMessage("Label updated successfully");
			setLabel("");
		}
	};

	const handleChangePin = async () => {
		const result = await call(() => api.changePin());
		if (result) setMessage("Follow the prompts on your KeepKey to set a new PIN");
	};

	const handleRemovePin = async () => {
		const result = await call(() => api.changePin(true));
		if (result) setMessage("PIN removed");
	};

	const handleClearSession = async () => {
		const result = await call(() => api.clearSession());
		if (result) setMessage("Session cleared");
	};

	const handleWipe = async () => {
		const result = await call(() => api.wipeDevice());
		if (result) setMessage("Device wiped. Please reconnect and set up your KeepKey.");
	};

	return (
		<VStack gap="6" align="stretch">
			<Text fontSize="2xl" fontWeight="bold" color="kk.gold">Settings</Text>

			{/* Feedback */}
			{message && (
				<Box bg="rgba(255, 215, 0, 0.1)" borderRadius="lg" p="3" border="1px solid" borderColor="kk.gold">
					<Text color="kk.gold" fontSize="sm">{message}</Text>
				</Box>
			)}
			{error && (
				<Box bg="rgba(255, 23, 68, 0.1)" borderRadius="lg" p="3" border="1px solid" borderColor="kk.error">
					<Text color="kk.error" fontSize="sm">{error}</Text>
				</Box>
			)}

			{/* Device Label */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">Device Label</Text>
				<Flex gap="3">
					<Input
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="New device label"
						bg="kk.bg"
						border="1px solid"
						borderColor="kk.border"
						_focus={{ borderColor: "kk.gold" }}
						size="sm"
					/>
					<Button
						onClick={handleSetLabel}
						disabled={loading || !label.trim()}
						bg="kk.gold"
						color="black"
						fontWeight="semibold"
						_hover={{ bg: "kk.goldHover" }}
						size="sm"
						flexShrink={0}
					>
						Set Label
					</Button>
				</Flex>
			</Box>

			{/* PIN Management */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">PIN Management</Text>
				<Flex gap="3">
					<Button
						onClick={handleChangePin}
						disabled={loading}
						variant="outline"
						borderColor="kk.border"
						color="kk.textSecondary"
						_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
						size="sm"
					>
						Change PIN
					</Button>
					<Button
						onClick={handleRemovePin}
						disabled={loading}
						variant="outline"
						borderColor="kk.border"
						color="kk.warning"
						_hover={{ borderColor: "kk.warning" }}
						size="sm"
					>
						Remove PIN
					</Button>
				</Flex>
			</Box>

			{/* Session */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.border" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="4">Session</Text>
				<Button
					onClick={handleClearSession}
					disabled={loading}
					variant="outline"
					borderColor="kk.border"
					color="kk.textSecondary"
					_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
					size="sm"
				>
					Clear Session
				</Button>
			</Box>

			{/* Danger Zone */}
			<Box bg="kk.cardBg" borderRadius="xl" border="1px solid" borderColor="kk.error" p="6">
				<Text fontSize="lg" fontWeight="semibold" mb="2" color="kk.error">
					Danger Zone
				</Text>
				<Text color="kk.textMuted" fontSize="sm" mb="4">
					Wiping your device will erase all data. Make sure you have your recovery seed backed up.
				</Text>
				<Button
					onClick={handleWipe}
					disabled={loading}
					bg="kk.error"
					color="white"
					_hover={{ opacity: 0.9 }}
					size="sm"
				>
					Wipe Device
				</Button>
			</Box>
		</VStack>
	);
}
