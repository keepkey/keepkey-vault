import { useState, useCallback } from "react"
import { Box, Text, Button, Flex } from "@chakra-ui/react"
import { generateQRSvg } from "../lib/qr"
import { rpcRequest } from "../lib/rpc"
import { PathEditDialog } from "./PathEditDialog"
import type { ChainDef } from "../../shared/chains"

interface ReceiveViewProps {
	chain: ChainDef
	address: string | null
	loading: boolean
	currentPath: number[]
	onDerive: (path?: number[]) => void
}

const HARDENED = 0x80000000

function pathToString(path: number[]): string {
	return "m/" + path.map(n => n >= HARDENED ? `${n - HARDENED}'` : `${n}`).join("/")
}

export function ReceiveView({ chain, address, loading, currentPath, onDerive }: ReceiveViewProps) {
	const [copied, setCopied] = useState(false)
	const [showing, setShowing] = useState(false)
	const [pathDialogOpen, setPathDialogOpen] = useState(false)

	const copyAddress = useCallback(() => {
		if (!address) return
		navigator.clipboard.writeText(address).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}, [address])

	const showOnDevice = useCallback(async () => {
		setShowing(true)
		try {
			const params: any = {
				addressNList: currentPath,
				showDisplay: true,
				coin: chain.coin,
			}
			if (chain.scriptType) params.scriptType = chain.scriptType
			await rpcRequest(chain.rpcMethod, params, 60000)
		} catch (e: any) { console.error("showOnDevice:", e) }
		setShowing(false)
	}, [chain, currentPath])

	const handlePathApply = useCallback((newPath: number[]) => {
		setPathDialogOpen(false)
		onDerive(newPath)
	}, [onDerive])

	if (!address && !loading) {
		return (
			<Flex direction="column" align="center" py="8" gap="4">
				<Text fontSize="sm" color="kk.textMuted">No address derived yet</Text>
				<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} onClick={() => onDerive()}>
					Derive Address
				</Button>
			</Flex>
		)
	}

	if (loading) {
		return (
			<Flex align="center" justify="center" py="8">
				<Text fontSize="sm" color="kk.textMuted">Deriving address...</Text>
			</Flex>
		)
	}

	const qrSvg = generateQRSvg(address!, 4, 4)

	return (
		<>
			<Flex direction="column" align="center" py="3" gap="3">
				<Text fontSize="xs" color="kk.textMuted">Send {chain.symbol} to this address</Text>

				{/* QR Code */}
				<Box
					bg="white"
					borderRadius="xl"
					p="2"
					dangerouslySetInnerHTML={{ __html: qrSvg }}
					w={{ base: "160px", md: "180px" }}
					h={{ base: "160px", md: "180px" }}
				/>

				{/* Address */}
				<Box bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="lg" px="3" py="2" w="100%">
					<Text fontSize={{ base: "xs", md: "sm" }} fontFamily="mono" color="kk.textPrimary" wordBreak="break-all" textAlign="center">
						{address}
					</Text>
				</Box>

				{/* Derivation Path */}
				<Flex align="center" gap="1.5">
					<Text fontSize="xs" fontFamily="mono" color="kk.textMuted">
						{pathToString(currentPath)}
					</Text>
					<Box
						as="button"
						onClick={() => setPathDialogOpen(true)}
						cursor="pointer"
						color="kk.textMuted"
						_hover={{ color: "kk.gold" }}
						transition="color 0.15s"
						title="Edit derivation path"
						display="flex"
						alignItems="center"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
						</svg>
					</Box>
				</Flex>

				{/* Action Buttons */}
				<Flex gap="2" flexWrap="wrap" justify="center">
					<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={copyAddress}>
						{copied ? "Copied!" : "Copy"}
					</Button>
					<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={showOnDevice} disabled={showing}>
						{showing ? "Check device..." : "Show on Device"}
					</Button>
				</Flex>
			</Flex>

			{pathDialogOpen && (
				<PathEditDialog
					path={currentPath}
					onApply={handlePathApply}
					onClose={() => setPathDialogOpen(false)}
				/>
			)}
		</>
	)
}
