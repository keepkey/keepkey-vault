import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Text, Flex, Button, Input } from "@chakra-ui/react"

interface PassphraseEntryProps {
	onSubmit: (passphrase: string) => void
	onCancel: () => void
}

/**
 * Passphrase entry overlay — full-screen modal with password input.
 * Triggered when the device requests a passphrase (BIP-39 passphrase protection).
 * Submit empty string to use default (no passphrase) wallet.
 */
export function PassphraseEntry({ onSubmit, onCancel }: PassphraseEntryProps) {
	const [passphrase, setPassphrase] = useState("")
	const [showPassphrase, setShowPassphrase] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	// Auto-focus the input on mount
	useEffect(() => {
		setTimeout(() => inputRef.current?.focus(), 100)
	}, [])

	const handleSubmit = useCallback(() => {
		onSubmit(passphrase)
		setPassphrase("")
	}, [passphrase, onSubmit])

	// Keyboard: Enter on input submits; Escape anywhere dismisses
	const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault()
			handleSubmit()
		}
	}, [handleSubmit])

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel()
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [onCancel])

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
				maxW="420px"
				w="90%"
				boxShadow="0 8px 32px rgba(0,0,0,0.6)"
			>
				<Text fontSize="xl" fontWeight="bold" mb="2" textAlign="center" color="kk.textPrimary">
					Enter Passphrase
				</Text>
				<Text color="kk.textSecondary" fontSize="sm" mb="6" textAlign="center">
					Your device has passphrase protection enabled.
					Enter your BIP-39 passphrase to unlock. Leave empty
					for the default wallet.
				</Text>

				{/* Passphrase input */}
				<Box position="relative" mb="5">
					<Input
						ref={inputRef}
						type={showPassphrase ? "text" : "password"}
						value={passphrase}
						onChange={(e) => setPassphrase(e.target.value)}
						onKeyDown={handleInputKeyDown}
						placeholder="Passphrase (optional)"
						bg="kk.bg"
						border="1px solid"
						borderColor="kk.border"
						color="kk.textPrimary"
						fontSize="md"
						px="4"
						py="3"
						pr="14"
						borderRadius="md"
						_focus={{ borderColor: "kk.gold", outline: "none" }}
						_placeholder={{ color: "kk.textMuted" }}
						autoComplete="off"
						autoCorrect="off"
						spellCheck={false}
					/>
					<Box
						as="button"
						position="absolute"
						right="3"
						top="50%"
						transform="translateY(-50%)"
						onClick={() => setShowPassphrase((v) => !v)}
						color="kk.textSecondary"
						_hover={{ color: "kk.textPrimary" }}
						cursor="pointer"
						p="1"
					>
						{showPassphrase ? (
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
								<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
								<line x1="1" y1="1" x2="23" y2="23" />
							</svg>
						) : (
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
								<circle cx="12" cy="12" r="3" />
							</svg>
						)}
					</Box>
				</Box>

				<Text color="kk.textMuted" fontSize="xs" mb="5" textAlign="center">
					Passphrases are case-sensitive. A different passphrase
					generates a completely different wallet.
				</Text>

				{/* Action buttons */}
				<Flex gap="3" justifyContent="center">
					<Button
						onClick={onCancel}
						size="md"
						variant="outline"
						borderColor="kk.border"
						color="kk.textSecondary"
						_hover={{ borderColor: "kk.gold", color: "kk.textPrimary" }}
						flex={1}
					>
						Cancel
					</Button>
					<Button
						onClick={handleSubmit}
						size="md"
						bg="kk.gold"
						color="black"
						fontWeight="semibold"
						_hover={{ bg: "kk.goldHover" }}
						flex={1}
					>
						Unlock
					</Button>
				</Flex>
			</Box>
		</Flex>
	)
}
