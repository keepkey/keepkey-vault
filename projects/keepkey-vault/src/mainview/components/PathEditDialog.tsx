import { useState, useCallback, useEffect } from "react"
import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"

interface PathEditDialogProps {
	path: number[]
	onApply: (newPath: number[]) => void
	onClose: () => void
}

const HARDENED = 0x80000000

function pathToString(path: number[]): string {
	return "m/" + path.map(n => n >= HARDENED ? `${n - HARDENED}'` : `${n}`).join("/")
}

function stringToPath(str: string): number[] | null {
	const s = str.trim().replace(/^m\/?/, "")
	if (!s) return null
	const parts = s.split("/")
	const result: number[] = []
	for (const p of parts) {
		const hardened = p.endsWith("'") || p.endsWith("h") || p.endsWith("H")
		const num = parseInt(hardened ? p.slice(0, -1) : p, 10)
		if (isNaN(num) || num < 0) return null
		result.push(hardened ? num + HARDENED : num)
	}
	return result
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
			setError("Invalid path format. Use m/44'/0'/0'/0/0")
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
			zIndex="1500"
			display="flex"
			alignItems="center"
			justifyContent="center"
			onClick={onClose}
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
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" mb="1">
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
						variant="ghost"
						color="kk.textSecondary"
						_hover={{ color: "kk.textPrimary" }}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						size="sm"
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
