import { useState, useEffect, useCallback } from "react"
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react"
import type { PinRequestType } from "../../../shared/types"
import { KeepKeyUILogo } from "../logo/keepkey-ui"

interface PinEntryProps {
	type?: PinRequestType
	onSubmit: (pin: string) => void
	onCancel: () => void
}

const TITLES: Record<PinRequestType, string> = {
	"current": "Enter PIN",
	"new-first": "Create a PIN",
	"new-second": "Confirm Your PIN",
}

const DESCRIPTIONS: Record<PinRequestType, string> = {
	"current": "Use the positions shown on your KeepKey to enter your PIN",
	"new-first": "Look at your KeepKey screen and tap the positions to set a new PIN",
	"new-second": "Enter the same PIN again to confirm",
}

/**
 * PIN entry pad matching KeepKey's scrambled 3x3 layout.
 * The device screen shows scrambled numbers; the user taps
 * position-based buttons (1-9) on this grid.
 */
export function PinEntry({ type = "current", onSubmit, onCancel }: PinEntryProps) {
	const [pin, setPin] = useState("")

	// Reset pin when type changes (e.g. new-first → new-second)
	useEffect(() => {
		setPin("")
	}, [type])

	const handleDigit = useCallback((digit: string) => {
		setPin((p) => (p.length < 9 ? p + digit : p))
	}, [])

	const handleBackspace = useCallback(() => {
		setPin((p) => p.slice(0, -1))
	}, [])

	const handleSubmit = useCallback(() => {
		if (pin.length > 0) {
			onSubmit(pin)
			setPin("")
		}
	}, [pin, onSubmit])

	// Keyboard support: 1-9 digits, backspace, enter
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key >= "1" && e.key <= "9") {
				handleDigit(e.key)
			} else if (e.key === "Backspace") {
				handleBackspace()
			} else if (e.key === "Enter") {
				handleSubmit()
			}
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [handleDigit, handleBackspace, handleSubmit])

	// KeepKey PIN pad layout: 7 8 9 / 4 5 6 / 1 2 3
	const rows = [
		["7", "8", "9"],
		["4", "5", "6"],
		["1", "2", "3"],
	]

	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			w="100vw"
			h="100vh"
			bg="blackAlpha.800"
			align="center"
			justify="center"
			zIndex={2000}
		>
			<Box
				bg="kk.cardBg"
				borderRadius="xl"
				border="1px solid"
				borderColor="kk.border"
				p="8"
				maxW="360px"
				w="90%"
				boxShadow="0 8px 32px rgba(0,0,0,0.6)"
			>
				<Text fontSize="xl" fontWeight="bold" mb="2" textAlign="center" color="kk.textPrimary">
					{TITLES[type]}
				</Text>
				<Text color="kk.textSecondary" fontSize="sm" mb="6" textAlign="center">
					{DESCRIPTIONS[type]}
				</Text>

				{/* PIN display — masked dots */}
				<Box
					bg="kk.bg"
					borderRadius="md"
					border="1px solid"
					borderColor="kk.border"
					p="3"
					mb="5"
					textAlign="center"
					fontFamily="mono"
					fontSize="2xl"
					letterSpacing="8px"
					minH="48px"
					color="kk.gold"
				>
					{"\u2022".repeat(pin.length) || "\u00A0"}
				</Box>

				{/* 3x3 PIN pad */}
				<VStack gap="3" mb="5">
					{rows.map((row, i) => (
						<Flex key={i} gap="3" justifyContent="center">
							{row.map((digit) => (
								<Button
									key={digit}
									onClick={() => handleDigit(digit)}
									w="72px"
									h="72px"
									bg="kk.cardBg"
									border="2px solid"
									borderColor="kk.border"
									color="kk.textPrimary"
									fontSize="xl"
									fontWeight="bold"
									borderRadius="xl"
									_hover={{ borderColor: "kk.gold", bg: "kk.cardBgHover" }}
									_active={{ bg: "kk.gold", borderColor: "kk.gold", color: "black" }}
									disabled={pin.length >= 9}
								>
									{"\u2022"}
								</Button>
							))}
						</Flex>
					))}
				</VStack>

				{/* Action buttons */}
				<Flex gap="3" justifyContent="center">
					<Button
						onClick={handleBackspace}
						size="md"
						variant="outline"
						borderColor="kk.border"
						color="kk.textSecondary"
						_hover={{ borderColor: "kk.gold", color: "kk.textPrimary" }}
						disabled={pin.length === 0}
						flex={1}
					>
						Backspace
					</Button>
					<Button
						onClick={handleSubmit}
						size="md"
						bg="kk.gold"
						color="black"
						fontWeight="semibold"
						_hover={{ bg: "kk.goldHover" }}
						disabled={pin.length === 0}
						flex={1}
					>
						{type === "current" ? "Unlock" : "Confirm"}
					</Button>
				</Flex>

				{type === "current" && (
					<Button
						onClick={onCancel}
						size="sm"
						variant="ghost"
						color="kk.textMuted"
						_hover={{ color: "kk.error" }}
						w="100%"
						mt="3"
					>
						Cancel
					</Button>
				)}

				<Flex justify="flex-end" mt="3">
					<Box w="24px" h="24px" opacity={0.3}>
						<KeepKeyUILogo />
					</Box>
				</Flex>
			</Box>
		</Flex>
	)
}
