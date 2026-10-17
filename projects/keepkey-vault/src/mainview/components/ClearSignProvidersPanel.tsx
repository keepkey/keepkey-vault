import { useCallback, useEffect, useState } from "react"
import { Box, Flex, Text, VStack, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { ClearSignProvider, ClearSignProviderContract } from "../../shared/types"

/** "1:0xabc…, 8453:0xdef…" → contract scope. Empty means any contract. */
function parseContracts(raw: string): ClearSignProviderContract[] {
	return raw.split(/[\s,]+/).filter(Boolean).map(entry => {
		const [chainId, address] = entry.split(":")
		return { chainId: Number(chainId), address: String(address || "") }
	})
}

/** Third-party ClearSign providers the user added (Device Settings → Signing Policy). */
export function ClearSignProvidersPanel() {
	const [providers, setProviders] = useState<ClearSignProvider[]>([])
	const [name, setName] = useState("")
	const [url, setUrl] = useState("")
	const [publicKey, setPublicKey] = useState("")
	const [contracts, setContracts] = useState("")
	const [busy, setBusy] = useState(false)
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

	useEffect(() => {
		rpcRequest<ClearSignProvider[]>("clearsignListProviders", undefined, 10000).then(setProviders).catch(() => {})
	}, [])

	const add = useCallback(async () => {
		setBusy(true)
		setMsg(null)
		try {
			const list = await rpcRequest<ClearSignProvider[]>("clearsignAddProvider", {
				name, url, publicKeyHex: publicKey, contracts: parseContracts(contracts),
			}, 10000)
			setProviders(list)
			setName(""); setUrl(""); setPublicKey(""); setContracts("")
			setMsg({ text: "Provider added", ok: true })
		} catch (e: any) {
			setMsg({ text: e?.message || "Failed to add provider", ok: false })
		}
		setBusy(false)
	}, [name, url, publicKey, contracts])

	const remove = useCallback(async (id: string) => {
		try {
			setProviders(await rpcRequest<ClearSignProvider[]>("clearsignRemoveProvider", { id }, 10000))
		} catch (e: any) {
			setMsg({ text: e?.message || "Failed to remove provider", ok: false })
		}
	}, [])

	return (
		<Box px="3" py="3" borderRadius="12px" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.18)">
			<Text fontSize="sm" color="kk.textPrimary" fontWeight="600">ClearSign providers</Text>
			<Text fontSize="xs" color="kk.textSecondary" mt="0.5">
				Services that describe transactions with their own key. Your KeepKey asks you to trust each one for the
				session and shows "NOT verified by KeepKey". Leave contracts empty to ask a provider about any contract.
			</Text>

			<VStack gap="2" align="stretch" mt="3">
				{providers.map(p => (
					<Flex key={p.id} align="center" gap="2" px="3" py="2" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="lg">
						<Box flex="1" minW="0">
							<Text fontSize="sm" fontWeight="500" color="kk.textPrimary" truncate>{p.name}</Text>
							<Text fontSize="12px" color="kk.textSecondary" fontFamily="mono" truncate>{p.url}</Text>
							<Text fontSize="12px" color="kk.textSecondary" fontFamily="mono">{p.fingerprint}</Text>
							<Text fontSize="12px" color="kk.textSecondary" truncate>
								{p.contracts.length ? p.contracts.map(c => `${c.chainId}:${c.address}`).join(", ") : "Any contract"}
							</Text>
						</Box>
						<Button size="xs" variant="ghost" color="kk.textSecondary" onClick={() => remove(p.id)}>Remove</Button>
					</Flex>
				))}
				<Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name shown on the device" />
				<Input size="sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://provider.example" fontFamily="mono" />
				<Input size="sm" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder="Public key (33-byte hex)" fontFamily="mono" />
				<Input size="sm" value={contracts} onChange={(e) => setContracts(e.target.value)} placeholder="Contracts (optional): 1:0xabc…, 8453:0xdef…" fontFamily="mono" />
				<Flex align="center" justify="space-between" gap="3">
					<Text fontSize="xs" color={msg?.ok === false ? "kk.error" : "kk.textSecondary"}>{msg?.text}</Text>
					<Button size="sm" variant="outline" borderColor="rgba(233,196,106,0.45)" color="kk.gold"
						disabled={busy || !name.trim() || !url.trim() || !publicKey.trim()} onClick={add}>
						Add provider
					</Button>
				</Flex>
			</VStack>
		</Box>
	)
}
