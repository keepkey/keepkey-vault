import { useState, useCallback } from "react"
import { Box, Text, Button, Flex } from "@chakra-ui/react"
import { generateQRSvg } from "../lib/qr"

interface ReceiveViewProps {
	address: string | null
	symbol: string
	onDerive: () => void
}

export function ReceiveView({ address, symbol, onDerive }: ReceiveViewProps) {
	const [copied, setCopied] = useState(false)

	const copyAddress = useCallback(() => {
		if (!address) return
		navigator.clipboard.writeText(address).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}, [address])

	if (!address) {
		return (
			<Box textAlign="center" py="8">
				<Text fontSize="sm" color="kk.textMuted" mb="4">Derive address first to show QR code</Text>
				<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} onClick={onDerive}>
					Derive Address
				</Button>
			</Box>
		)
	}

	const qrSvg = generateQRSvg(address, 4, 4)

	return (
		<Flex direction="column" align="center" py="4" gap="4">
			<Text fontSize="xs" color="kk.textMuted">Send {symbol} to this address</Text>
			<Box
				bg="white"
				borderRadius="xl"
				p="3"
				dangerouslySetInnerHTML={{ __html: qrSvg }}
				w="200px"
				h="200px"
			/>
			<Box bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="lg" p="3" maxW="100%">
				<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all" textAlign="center">
					{address}
				</Text>
			</Box>
			<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={copyAddress}>
				{copied ? "Copied!" : "Copy Address"}
			</Button>
		</Flex>
	)
}
