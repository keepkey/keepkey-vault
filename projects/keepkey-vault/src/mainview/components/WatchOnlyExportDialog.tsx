import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, Button, Spinner } from "@chakra-ui/react"
import { BitcoinQrDialog } from "./BitcoinQrDialog"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { BtcAccount } from "../../shared/types"

type ExportScriptType = "p2wpkh" | "p2sh-p2wpkh" | "p2pkh" | "p2tr"
type ExportData = { key: string; fingerprint: string | null; derivation: string; publicWallet: string | null; filePath?: string }

const SCRIPT_TYPES: Array<{ scriptType: ExportScriptType; label: string }> = [
	{ scriptType: "p2wpkh", label: "Native SegWit (bc1q)" },
	{ scriptType: "p2sh-p2wpkh", label: "Nested SegWit (3...)" },
	{ scriptType: "p2pkh", label: "Legacy (1...)" },
	{ scriptType: "p2tr", label: "Taproot (bc1p)" },
]

const card = { bg: "rgba(255,255,255,0.03)", borderRadius: "lg", border: "1px solid", borderColor: "kk.border", p: "3" } as const

/**
 * WatchOnlyExportDialog — hand one Bitcoin account to Electrum (or Sparrow) as watch-only.
 *
 * Bun builds everything from the loaded account xpub and the master fingerprint
 * read from the KeepKey; this dialog only picks the account and shows the result.
 */
export function WatchOnlyExportDialog({ accounts, isHiddenWallet, onClose }: { accounts: BtcAccount[]; isHiddenWallet?: boolean; onClose: () => void }) {
	const [accountIndex, setAccountIndex] = useState(accounts[0]?.accountIndex ?? 0)
	const [scriptType, setScriptType] = useState<ExportScriptType>("p2wpkh")
	const [data, setData] = useState<ExportData | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [showQr, setShowQr] = useState(false)
	const [copied, setCopied] = useState(false)
	const [savedFormat, setSavedFormat] = useState<'desktop' | 'electrum'>('desktop')

	useEffect(() => {
		let cancelled = false
		setData(null)
		setShowQr(false)
		setError(null)
		rpcRequest<ExportData>("btcWatchOnlyExport", { accountIndex, scriptType }, 60000)
			.then((d) => { if (!cancelled) setData(d) })
			.catch((e: any) => { if (!cancelled) setError(e?.message || "Could not read this account") })
		return () => { cancelled = true }
	}, [accountIndex, scriptType])

	const handleSave = useCallback(async (format: 'desktop' | 'electrum') => {
		setBusy(true)
		setError(null)
		try {
			setData(await rpcRequest<ExportData>("btcWatchOnlyExport", { accountIndex, scriptType, save: true, format }, 60000))
			setSavedFormat(format)
		} catch (e: any) {
			setError(e?.message || "Could not save the wallet file")
		}
		setBusy(false)
	}, [accountIndex, scriptType])

	const handleCopy = useCallback(() => {
		if (!data) return
		navigator.clipboard.writeText(`${data.key}\nMaster fingerprint: ${data.fingerprint ?? "unknown"}\nDerivation path: ${data.derivation}`)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}, [data])

	const goldButton = { size: "sm", bg: "kk.gold", color: "black", fontWeight: "600", px: "4", py: "2", _hover: { bg: "kk.goldHover" } } as const
	const plainButton = { size: "sm", variant: "outline", color: "kk.textSecondary", borderColor: "kk.border", px: "4", py: "2" } as const
	const pick = (active: boolean) => ({
		as: "button" as const, px: "2.5", py: "1", borderRadius: "md", fontSize: "xs", border: "1px solid",
		borderColor: active ? "kk.gold" : "kk.border", color: active ? "kk.gold" : "kk.textSecondary",
	})

	return (
		<>
			{showQr && data?.publicWallet && <BitcoinQrDialog bytes={new TextEncoder().encode(data.publicWallet)} title="Desktop public wallet QR" onClose={() => setShowQr(false)} />}
			<Box position="fixed" inset="0" bg="rgba(0,0,0,0.85)" zIndex={Z.dialog} onClick={busy ? undefined : onClose} />
			<Box
				position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)"
				w="520px" maxW="92vw" maxH="88vh" overflowY="auto"
				bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="xl"
				zIndex={Z.dialog + 1} role="dialog" aria-modal="true" aria-label="Export watch-only wallet"
			>
				<Box p="6">
					<Text fontSize="lg" fontWeight="700" color="kk.textPrimary">Export watch-only wallet</Text>
					<Text fontSize="xs" color="kk.textSecondary" mb="4">For Desktop, Electrum or Sparrow · Bitcoin mainnet</Text>

					<Flex direction="column" gap="3">
						<Box {...card} borderColor="rgba(233,196,106,0.4)" bg="rgba(233,196,106,0.06)">
							<Text fontSize="xs" color="var(--gold)">
								Anyone with this file or key can see every balance and transaction of this account, past and future. They cannot spend.
							</Text>
							{isHiddenWallet && (
								<Text fontSize="xs" color="var(--gold)" mt="1">
									This is a passphrase (hidden) wallet: the export reveals it to anyone who opens it. Desktop itself keeps nothing.
								</Text>
							)}
						</Box>

						{accounts.length > 1 && (
							<Flex gap="2" wrap="wrap">
								{accounts.map((a) => (
									<Box key={a.accountIndex} {...pick(a.accountIndex === accountIndex)} onClick={() => !busy && setAccountIndex(a.accountIndex)}>
										Account {a.accountIndex}
									</Box>
								))}
							</Flex>
						)}
						<Flex gap="2" wrap="wrap">
							{SCRIPT_TYPES.map((s) => (
								<Box key={s.scriptType} {...pick(s.scriptType === scriptType)} onClick={() => !busy && setScriptType(s.scriptType)}>
									{s.label}
								</Box>
							))}
						</Flex>
						<Text fontSize="xs" color="kk.textSecondary">Save a Desktop public wallet file to prepare transactions on an online computer without connecting your KeepKey. It includes the fingerprint, path, script type, network and receive/change branches.</Text>
						{scriptType === "p2tr" && <Text fontSize="xs" color="kk.textSecondary">Taproot signing uses Desktop. Sparrow's KeepKey USB integration and Electrum's KeepKey plugin do not support Taproot signing. File exchange is a separate compatibility check.</Text>}

						{!data && !error && (
							<Flex align="center" gap="2" py="3" justify="center">
								<Spinner size="sm" color="kk.gold" />
								<Text fontSize="sm" color="kk.textSecondary">Reading the account...</Text>
							</Flex>
						)}

						{data && (
							<Box {...card}>
								<Text fontSize="xs" color="kk.textSecondary">{scriptType === "p2tr" ? "BIP86 public key (Sparrow: Taproot)" : 'Public key (Electrum: "Use a master key")'}</Text>
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all" mb="2">{data.key}</Text>
								<Flex justify="space-between"><Text fontSize="xs" color="kk.textSecondary">Master fingerprint</Text><Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{data.fingerprint ?? "unknown"}</Text></Flex>
								<Flex justify="space-between"><Text fontSize="xs" color="kk.textSecondary">Derivation path</Text><Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{data.derivation}</Text></Flex>
								{data.filePath && (
									<Box mt="2">
										<Text fontSize="xs" color="var(--teal-2)">{savedFormat === 'desktop' ? 'Saved. Drop this public wallet file on Desktop on the online computer.' : 'Saved. Open it in Electrum with File > Open.'}</Text>
										<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">{data.filePath}</Text>
									</Box>
								)}
							</Box>
						)}

						{error && <Text fontSize="sm" color="var(--rose)">{error}</Text>}

						<Flex gap="2" justify="flex-end" wrap="wrap">
							<Button {...plainButton} onClick={onClose} disabled={busy}>Close</Button>
							<Button {...plainButton} disabled={!data?.publicWallet} onClick={() => setShowQr(true)}>Public wallet QR</Button>
							<Button {...plainButton} onClick={handleCopy} disabled={!data}>{copied ? "Copied" : "Copy key"}</Button>
							<Button {...plainButton} onClick={() => void handleSave('electrum')} disabled={!data || !data.fingerprint || busy || scriptType === "p2tr"}>
								Save Electrum file
							</Button>
							<Button {...goldButton} onClick={() => void handleSave('desktop')} disabled={!data || !data.fingerprint || busy}>
								{busy ? "Saving..." : "Save Desktop public wallet"}
							</Button>
						</Flex>
					</Flex>
				</Box>
			</Box>
		</>
	)
}
