import { useState, useCallback, useEffect } from "react"
import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"
import { pathToString, stringToPath } from "../lib/bip44"
import { Z } from "../lib/z-index"

interface PathEditDialogProps {
	path: number[]
	onApply: (newPath: number[]) => void
	onClose: () => void
}

export function PathEditDialog({ path, onApply, onClose }: PathEditDialogProps) {
	const [value, setValue] = useState(pathToString(path))
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setValue(pathToString(path))
		setError(null)
	}, [path])

	const handleApply = useCallback(() => {
		const parsed = stringToPath(value)
		if (!parsed || parsed.length === 0) {
			setError("Invalid path. Use m/44'/0'/0'/0/0 (max 10 levels)")
			return
		}
		onApply(parsed)
	}, [value, onApply])

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleApply()
		if (e.key === "Escape") onClose()
	}, [handleApply, onClose])

	return (
		<Box
			position="fixed"
			inset="0"
			zIndex={Z.dialog}
			display="flex"
			alignItems="center"
			justifyContent="center"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="path-dialog-title"
		>
			<Box position="absolute" inset="0" bg="blackAlpha.700" />
			<Box
				position="relative"
				bg="kk.cardBg"
				border="1px solid"
				borderColor="kk.border"
				borderRadius="xl"
				p="5"
				w="380px"
				maxW="90vw"
				onClick={(e) => e.stopPropagation()}
			>
				<Text id="path-dialog-title" fontSize="sm" fontWeight="600" color="kk.textPrimary" mb="1">
					Derivation Path
				</Text>
				<Text fontSize="xs" color="kk.textMuted" mb="3">
					Edit the BIP44 derivation path. Use ' for hardened indices.
				</Text>
				<Input
					value={value}
					onChange={(e) => { setValue(e.target.value); setError(null) }}
					onKeyDown={handleKeyDown}
					fontFamily="mono"
					fontSize="sm"
					bg="kk.bg"
					border="1px solid"
					borderColor={error ? "red.500" : "kk.border"}
					color="kk.textPrimary"
					_hover={{ borderColor: "kk.gold" }}
					_focus={{ borderColor: "kk.gold", boxShadow: "none" }}
					placeholder="m/44'/0'/0'/0/0"
					autoFocus
				/>
				{error && (
					<Text fontSize="xs" color="red.400" mt="1">{error}</Text>
				)}
				<Flex gap="2" mt="4" justify="flex-end">
					<Button
						size="sm"
						px="4"
						py="2"
						variant="ghost"
						color="kk.textSecondary"
						_hover={{ color: "kk.textPrimary" }}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						px="4"
						py="2"
						bg="kk.gold"
						color="black"
						_hover={{ bg: "kk.goldHover" }}
						onClick={handleApply}
					>
						Apply & Re-derive
					</Button>
				</Flex>
			</Box>
		</Box>
	)
}
