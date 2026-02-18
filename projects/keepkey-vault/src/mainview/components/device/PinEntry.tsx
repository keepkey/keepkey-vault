import { useState } from "react";
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react";

interface PinEntryProps {
	onSubmit: (pin: string) => void;
	onCancel: () => void;
}

/**
 * PIN entry pad that matches KeepKey's scrambled 3x3 layout.
 * The actual numbers are scrambled on-device; the user sees a grid
 * and enters position-based digits (1-9).
 */
export function PinEntry({ onSubmit, onCancel }: PinEntryProps) {
	const [pin, setPin] = useState("");

	const handleDigit = (digit: string) => {
		if (pin.length < 9) {
			setPin((p) => p + digit);
		}
	};

	const handleBackspace = () => {
		setPin((p) => p.slice(0, -1));
	};

	const handleSubmit = () => {
		if (pin.length > 0) {
			onSubmit(pin);
			setPin("");
		}
	};

	// KeepKey PIN pad layout: 7 8 9 / 4 5 6 / 1 2 3
	const rows = [
		["7", "8", "9"],
		["4", "5", "6"],
		["1", "2", "3"],
	];

	return (
		<Box
			bg="kk.cardBg"
			borderRadius="xl"
			border="1px solid"
			borderColor="kk.border"
			p="6"
			maxW="320px"
			mx="auto"
		>
			<Text fontSize="lg" fontWeight="semibold" mb="2" textAlign="center">
				Enter PIN
			</Text>
			<Text color="kk.textMuted" fontSize="sm" mb="4" textAlign="center">
				Use the positions shown on your KeepKey
			</Text>

			{/* PIN display */}
			<Box
				bg="kk.bg"
				borderRadius="md"
				border="1px solid"
				borderColor="kk.border"
				p="3"
				mb="4"
				textAlign="center"
				fontFamily="mono"
				fontSize="2xl"
				letterSpacing="8px"
				minH="48px"
			>
				{"*".repeat(pin.length)}
			</Box>

			{/* PIN pad */}
			<VStack gap="2" mb="4">
				{rows.map((row, i) => (
					<Flex key={i} gap="2" justifyContent="center">
						{row.map((digit) => (
							<Button
								key={digit}
								onClick={() => handleDigit(digit)}
								w="64px"
								h="64px"
								bg="kk.bg"
								border="1px solid"
								borderColor="kk.border"
								color="kk.textPrimary"
								fontSize="lg"
								fontWeight="bold"
								borderRadius="lg"
								_hover={{ borderColor: "kk.gold", bg: "kk.cardBgHover" }}
							>
								*
							</Button>
						))}
					</Flex>
				))}
			</VStack>

			{/* Actions */}
			<Flex gap="2" justifyContent="center">
				<Button
					onClick={handleBackspace}
					size="sm"
					variant="outline"
					borderColor="kk.border"
					color="kk.textSecondary"
					_hover={{ borderColor: "kk.gold" }}
				>
					Backspace
				</Button>
				<Button
					onClick={handleSubmit}
					size="sm"
					bg="kk.gold"
					color="black"
					fontWeight="semibold"
					_hover={{ bg: "kk.goldHover" }}
					disabled={pin.length === 0}
				>
					Submit
				</Button>
				<Button
					onClick={onCancel}
					size="sm"
					variant="outline"
					borderColor="kk.border"
					color="kk.textSecondary"
					_hover={{ borderColor: "kk.error", color: "kk.error" }}
				>
					Cancel
				</Button>
			</Flex>
		</Box>
	);
}
