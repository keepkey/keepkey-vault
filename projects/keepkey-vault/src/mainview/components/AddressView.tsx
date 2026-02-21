import { useState, useCallback } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { ChainDef } from "../lib/chains"

interface AddressViewProps {
	chain: ChainDef
	address: string | null
	loading: boolean
	onDerive: () => void
}

export function AddressView({ chain, address, loading, onDerive }: AddressViewProps) {
	const [copied, setCopied] = useState(false)
	const [showing, setShowing] = useState(false)

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
				addressNList: chain.defaultPath,
				showDisplay: true,
				coin: chain.coin,
			}
			if (chain.scriptType) params.scriptType = chain.scriptType
			await rpcRequest(chain.rpcMethod, params, 60000)
		} catch (e: any) { console.error("showOnDevice:", e) }
		setShowing(false)
	}, [chain])

	if (!address && !loading) {
		return (
			<Box textAlign="center" py="8">
				<Text fontSize="sm" color="kk.textMuted" mb="4">No address derived yet</Text>
				<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} onClick={onDerive}>
					Derive Address
				</Button>
			</Box>
		)
	}

	if (loading) {
		return (
			<Box textAlign="center" py="8">
				<Text fontSize="sm" color="kk.textMuted">Deriving address...</Text>
			</Box>
		)
	}

	return (
		<Box py="4">
			<Text fontSize="xs" color="kk.textMuted" mb="2">Address</Text>
			<Box bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="lg" p="4" mb="4">
				<Text fontSize="sm" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">
					{address}
				</Text>
			</Box>
			<Flex gap="3" flexWrap="wrap">
				<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={copyAddress}>
					{copied ? "Copied!" : "Copy"}
				</Button>
				<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={showOnDevice} disabled={showing}>
					{showing ? "Check device..." : "Show on Device"}
				</Button>
				<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={onDerive}>
					Re-derive
				</Button>
			</Flex>
		</Box>
	)
}
