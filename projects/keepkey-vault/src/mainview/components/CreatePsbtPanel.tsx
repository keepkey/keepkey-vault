import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, Button, Input, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { BtcWatchOnlyAccounts, BtcWatchOnlyPsbt } from "../../shared/types"

const SCRIPT_LABEL: Record<string, string> = { p2wpkh: "Native SegWit", "p2sh-p2wpkh": "SegWit", p2pkh: "Legacy" }
const FEE_LEVELS = [{ level: 1, label: "Slow" }, { level: 3, label: "Average" }, { level: 5, label: "Fast" }] as const

/** Exact: "12,345 sats (0.00012345 BTC)". Amounts arrive as decimal strings. */
function sats(v: string): string {
	const n = BigInt(v)
	return `${n.toLocaleString()} sats (${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")} BTC)`
}

const card = { bg: "rgba(255,255,255,0.03)", borderRadius: "lg", border: "1px solid", borderColor: "kk.border", p: "3" } as const

/**
 * CreatePsbtPanel — watch-only Bitcoin "Send": builds an unsigned PSBT with no
 * device (bun, strict: nothing guessed), saves it to Downloads and copies it.
 * A KeepKey signs it later: on Desktop with the device, or in Electrum.
 */
export function CreatePsbtPanel({ deviceId }: { deviceId?: string }) {
	const [info, setInfo] = useState<BtcWatchOnlyAccounts | null>(null)
	const [account, setAccount] = useState(0)
	const [to, setTo] = useState("")
	const [amount, setAmount] = useState("")
	const [isMax, setIsMax] = useState(false)
	const [feeLevel, setFeeLevel] = useState<1 | 3 | 5>(3)
	const [busy, setBusy] = useState(false)
	const [result, setResult] = useState<BtcWatchOnlyPsbt | null>(null)
	const [copied, setCopied] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		// Another saved wallet: drop the previous wallet's accounts, choice and PSBT before loading.
		setInfo(null)
		setAccount(0)
		setResult(null)
		setError(null)
		rpcRequest<BtcWatchOnlyAccounts>("btcWatchOnlyAccounts", deviceId ? { deviceId } : undefined)
			.then(setInfo)
			.catch((e: any) => setError(e?.message || "Could not read the saved Bitcoin accounts"))
	}, [deviceId])

	const handleCreate = useCallback(async () => {
		const a = info?.accounts[account]
		if (!a) return
		setBusy(true)
		setError(null)
		setResult(null)
		try {
			const r = await rpcRequest<BtcWatchOnlyPsbt>("btcWatchOnlyBuildPsbt", {
				...(deviceId ? { deviceId } : {}), scriptType: a.scriptType, accountIndex: a.accountIndex, to, amount, isMax, feeLevel,
			}, 300000)
			setResult(r)
			try { await navigator.clipboard.writeText(r.psbtBase64); setCopied(true) } catch { setCopied(false) }
		} catch (e: any) {
			setError(e?.message || "Could not create the PSBT")
		} finally {
			setBusy(false)
		}
	}, [info, account, deviceId, to, amount, isMax, feeLevel])

	const goldButton = { size: "sm", bg: "kk.gold", color: "black", fontWeight: "600", px: "4", py: "2", _hover: { bg: "kk.goldHover" } } as const
	const pick = (active: boolean) => ({
		as: "button" as const, px: "2.5", py: "1", borderRadius: "md", fontSize: "xs", border: "1px solid",
		borderColor: active ? "kk.gold" : "kk.border", color: active ? "kk.gold" : "kk.textSecondary",
	})

	return (
		<Flex direction="column" gap="3">
			<Text fontSize="md" fontWeight="700" color="kk.textPrimary">Create PSBT</Text>
			<Box {...card} borderColor="rgba(233,196,106,0.4)" bg="rgba(233,196,106,0.06)">
				<Text fontSize="xs" color="var(--gold)">
					This builds an unsigned transaction without a KeepKey. Only a KeepKey can sign it: drop the file on KeepKey Desktop
					with the device connected (offline mode works), or open it in Electrum with your KeepKey.
				</Text>
			</Box>

			{!info && !error && (
				<Flex align="center" gap="2" py="3" justify="center">
					<Spinner size="sm" color="kk.gold" />
					<Text fontSize="sm" color="kk.textSecondary">Reading the saved accounts...</Text>
				</Flex>
			)}
			{info && info.accounts.length === 0 && (
				<Text fontSize="sm" color="kk.textSecondary">No saved Bitcoin accounts for this wallet. Connect the KeepKey once to save them.</Text>
			)}

			{info && info.accounts.length > 0 && (
				<>
					{info.accounts.length > 1 && (
						<Flex gap="2" wrap="wrap">
							{info.accounts.map((a, i) => (
								<Box key={`${a.scriptType}:${a.accountIndex}`} {...pick(i === account)} onClick={() => !busy && setAccount(i)}>
									{SCRIPT_LABEL[a.scriptType]} · account {a.accountIndex}
								</Box>
							))}
						</Flex>
					)}
					<Text fontSize="xs" color="kk.textSecondary">
						From {SCRIPT_LABEL[info.accounts[account].scriptType]} {info.accounts[account].path} · chain data from {info.backend === "pioneer" ? "Pioneer" : `your own ${info.backend} node`}
					</Text>
					<Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient Bitcoin address (bc1..., 1..., 3...)" fontFamily="mono" fontSize="xs" disabled={busy} />
					<Flex gap="2" align="center">
						<Input value={isMax ? "" : amount} onChange={(e) => setAmount(e.target.value)} placeholder={isMax ? "Everything in this account, minus the fee" : "Amount in BTC"} fontSize="xs" disabled={busy || isMax} />
						<Box {...pick(isMax)} onClick={() => !busy && setIsMax(!isMax)} whiteSpace="nowrap">Send max</Box>
					</Flex>
					<Flex gap="2" align="center" wrap="wrap">
						<Text fontSize="xs" color="kk.textSecondary">Fee</Text>
						{FEE_LEVELS.map((f) => (
							<Box key={f.level} {...pick(f.level === feeLevel)} onClick={() => !busy && setFeeLevel(f.level)}>{f.label}</Box>
						))}
					</Flex>
					{!info.fingerprintKnown && (
						<Text fontSize="xs" color="kk.textSecondary">
							This wallet's master fingerprint isn't saved yet (connect this KeepKey once to record it), so the PSBT uses
							Electrum-style key paths. KeepKey Desktop signs it either way.
						</Text>
					)}
					<Flex justify="flex-end">
						<Button {...goldButton} onClick={handleCreate} disabled={busy || !to.trim() || (!isMax && !amount.trim())}>
							{busy ? "Building..." : "Create PSBT"}
						</Button>
					</Flex>
				</>
			)}

			{result && (
				<Box {...card}>
					<Text fontSize="xs" color="var(--teal-2)" mb="2">
						Saved{copied ? " and copied to the clipboard" : ""}. Not signed: sign it on a KeepKey, then drop the signed file here to broadcast it.
					</Text>
					<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all" mb="2">{result.filePath}</Text>
					{result.outputs.map((o, i) => (
						<Flex key={i} justify="space-between" gap="2">
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">{o.change ? `${o.address} (change)` : o.address}</Text>
							<Text fontSize="xs" color="kk.textPrimary" whiteSpace="nowrap">{sats(o.amount)}</Text>
						</Flex>
					))}
					<Flex justify="space-between" mt="1">
						<Text fontSize="xs" color="kk.textSecondary">Fee</Text>
						<Text fontSize="xs" color="kk.textPrimary">{sats(result.fee)} · ~{result.satPerVbyte} sat/vB (est. {result.estVsize} vB)</Text>
					</Flex>
				</Box>
			)}

			{error && <Text fontSize="sm" color="var(--rose)">{error}</Text>}
		</Flex>
	)
}
