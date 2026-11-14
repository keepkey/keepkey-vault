import { normalizeAmountInput } from '../../shared/locale'
import { getNumberLocale } from '../lib/number-locale'
import { useTranslation } from 'react-i18next'
import { useUiTranslation } from "../i18n/ui"
import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Input, Spinner } from "@chakra-ui/react"
import { actionToneProps } from "./ui/ActionButton"
import { base64 } from "@scure/base"
import { BitcoinQrDialog } from "./BitcoinQrDialog"
import { rpcRequest } from "../lib/rpc"
import type { BtcWatchOnlyAccounts, BtcWatchOnlyPsbt } from "../../shared/types"

const SCRIPT_LABEL: Record<string, string> = { p2wpkh: "Native SegWit", "p2sh-p2wpkh": "SegWit", p2pkh: "Legacy", p2tr: "Taproot" }
const FEE_LEVELS = [{ level: 1, label: "Slow" }, { level: 3, label: "Average" }, { level: 5, label: "Fast" }] as const

/** Exact: "12,345 sats (0.00012345 BTC)". Amounts arrive as decimal strings. */
function sats(v: string): string {
	const n = BigInt(v)
	return `${n.toLocaleString(getNumberLocale())} sats (${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")} BTC)`
}

const card = { bg: "rgba(255,255,255,0.03)", borderRadius: "lg", border: "1px solid", borderColor: "kk.border", p: "3" } as const

/**
 * CreatePsbtPanel — watch-only Bitcoin "Send": builds an unsigned PSBT with no
 * device (bun, strict: nothing guessed), saves it to Downloads and copies it.
 * A KeepKey signs it later: on Desktop with the device, or in Electrum.
 */
export function CreatePsbtPanel({ deviceId }: { deviceId?: string }) {
  const uiText = useUiTranslation()
  const { t, i18n } = useTranslation('send')

	const [info, setInfo] = useState<BtcWatchOnlyAccounts | null>(null)
	const [account, setAccount] = useState(0)
	const [to, setTo] = useState("")
	const [amount, setAmount] = useState("")
	const [isMax, setIsMax] = useState(false)
	const [feeLevel, setFeeLevel] = useState<1 | 3 | 5>(3)
	const [busy, setBusy] = useState(false)
	const [result, setResult] = useState<BtcWatchOnlyPsbt | null>(null)
	const [showQr, setShowQr] = useState(false)
	const [copied, setCopied] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const walletEpoch = useRef(0)

	useEffect(() => {
		const epoch = ++walletEpoch.current
		// Another saved wallet: drop the previous wallet's accounts, choice and PSBT before loading.
		setInfo(null)
		setAccount(0)
		setResult(null)
		setShowQr(false)
		setError(null)
		setBusy(false)
		rpcRequest<BtcWatchOnlyAccounts>("btcWatchOnlyAccounts", deviceId ? { deviceId } : undefined)
			.then((r) => { if (walletEpoch.current === epoch) setInfo(r) })
			.catch((e: any) => { if (walletEpoch.current === epoch) setError(e?.message || "Could not read the saved Bitcoin accounts") })
		return () => { walletEpoch.current++ }
	}, [deviceId])

	const handleCreate = useCallback(async () => {
		const a = info?.accounts[account]
		if (!a) return
    const canonicalAmount = normalizeAmountInput(amount, getNumberLocale(), i18n.language)
    if (!isMax && (canonicalAmount === null || !Number.isFinite(Number(canonicalAmount)) || Number(canonicalAmount) <= 0)) {
      setError(t('invalidAmount')); return
    }
		const epoch = walletEpoch.current
		setBusy(true)
		setError(null)
		setResult(null)
		try {
			const r = await rpcRequest<BtcWatchOnlyPsbt>("btcWatchOnlyBuildPsbt", {
				...(deviceId ? { deviceId } : {}), scriptType: a.scriptType, accountIndex: a.accountIndex, to, amount: isMax ? '0' : canonicalAmount!, isMax, feeLevel,
			}, 300000)
			if (walletEpoch.current !== epoch) return
			setResult(r)
			try { await navigator.clipboard.writeText(r.psbtBase64); setCopied(true) } catch { setCopied(false) }
		} catch (e: any) {
			if (walletEpoch.current === epoch) setError(e?.message || "Could not create the PSBT")
		} finally {
			if (walletEpoch.current === epoch) setBusy(false)
		}
	}, [info, account, deviceId, to, amount, isMax, feeLevel, t, i18n.language, uiText])

	// Shared primary/neutral variants (components/ui/ActionButton.tsx, theme.ts button recipe).
	const goldButton = { size: "sm" as const, ...actionToneProps("primary") }
	const pick = (active: boolean) => ({
		as: "button" as const, px: "2.5", py: "1", borderRadius: "md", fontSize: "xs", border: "1px solid",
		borderColor: active ? "kk.gold" : "kk.border", color: active ? "kk.gold" : "kk.textSecondary",
	})

	return (
		<Flex direction="column" gap="3">
			{showQr && result && <BitcoinQrDialog bytes={base64.decode(result.psbtBase64)} title={uiText("Unsigned PSBT QR")} onClose={() => setShowQr(false)} />}
			<Text fontSize="md" fontWeight="700" color="kk.textPrimary">{uiText("Create PSBT")}</Text>
			<Box {...card} borderColor="rgba(233,196,106,0.4)" bg="rgba(233,196,106,0.06)">
				<Text fontSize="xs" color="var(--gold)">{uiText("This builds an unsigned transaction without a KeepKey. Only a KeepKey can sign it: drop the file on KeepKey Desktop with the device connected (offline mode works), or open it in Electrum with your KeepKey.")}</Text>
			</Box>

			{!info && !error && (
				<Flex align="center" gap="2" py="3" justify="center">
					<Spinner size="sm" color="kk.gold" />
					<Text fontSize="sm" color="kk.textSecondary">{uiText("Reading the saved accounts...")}</Text>
				</Flex>
			)}
			{info && info.accounts.length === 0 && (
				<Text fontSize="sm" color="kk.textSecondary">{uiText("No saved Bitcoin accounts for this wallet. Connect the KeepKey once to save them.")}</Text>
			)}

			{info && info.accounts.length > 0 && (
				<>
					{info.accounts.length > 1 && (
						<Flex gap="2" wrap="wrap">
							{info.accounts.map((a, i) => (
								<Box key={`${a.scriptType}:${a.accountIndex}`} {...pick(i === account)} onClick={() => !busy && setAccount(i)}>
									{SCRIPT_LABEL[a.scriptType]}{" "}{uiText("· account")}{" "}{a.accountIndex}
								</Box>
							))}
						</Flex>
					)}
					<Text fontSize="xs" color="kk.textSecondary">{uiText("From")}{" "}{SCRIPT_LABEL[info.accounts[account].scriptType]} {info.accounts[account].path} · {info.backend === "device-only" ? uiText("Go online to fetch coins and fee estimates.") : `chain data from ${info.backend === "pioneer" ? "Pioneer" : `your own ${info.backend} node`}`}
					</Text>
					<Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={uiText("Recipient Bitcoin address (bc1..., 1..., 3...)")} fontFamily="mono" fontSize="xs" disabled={busy} />
					<Flex gap="2" align="center">
						<Input value={isMax ? "" : amount} inputMode="decimal" onChange={(e) => setAmount(normalizeAmountInput(e.target.value, getNumberLocale(), i18n.language) ?? e.target.value)} placeholder={isMax ? "Everything in this account, minus the fee" : "Amount in BTC"} fontSize="xs" disabled={busy || isMax} />
						<Box {...pick(isMax)} onClick={() => !busy && setIsMax(!isMax)} whiteSpace="nowrap">{uiText("Send max")}</Box>
					</Flex>
					<Flex gap="2" align="center" wrap="wrap">
						<Text fontSize="xs" color="kk.textSecondary">{uiText("Fee")}</Text>
						{FEE_LEVELS.map((f) => (
							<Box key={f.level} {...pick(f.level === feeLevel)} onClick={() => !busy && setFeeLevel(f.level)}>{f.label}</Box>
						))}
					</Flex>
					{!info.fingerprintKnown && (
						<Text fontSize="xs" color="kk.textSecondary">{uiText("This wallet's master fingerprint isn't saved yet (connect this KeepKey once to record it), so the PSBT uses Electrum-style key paths. KeepKey Desktop signs it either way.")}</Text>
					)}
					<Flex justify="flex-end">
						<Button {...goldButton} onClick={handleCreate} disabled={busy || info.backend === "device-only" || !to.trim() || (!isMax && !amount.trim())}>
							{busy ? uiText("Building...") : uiText("Create PSBT")}
						</Button>
					</Flex>
				</>
			)}

			{result && (
				<Box {...card}>
					<Text fontSize="xs" color="var(--teal-2)" mb="2">{uiText("Saved")}{copied ? uiText(" and copied to the clipboard") : ""}{uiText(". Not signed: sign it on a KeepKey, then drop the signed file here to broadcast it.")}</Text>
					<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all" mb="2">{result.filePath}</Text>
					<Button size="sm" variant="outline" mb="2" onClick={() => setShowQr(true)}>{uiText("Show unsigned QR")}</Button>
					{result.outputs.map((o, i) => (
						<Flex key={i} justify="space-between" gap="2">
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">{o.change ? `${o.address} (change)` : o.address}</Text>
							<Text fontSize="xs" color="kk.textPrimary" whiteSpace="nowrap">{sats(o.amount)}</Text>
						</Flex>
					))}
					<Flex justify="space-between" mt="1">
						<Text fontSize="xs" color="kk.textSecondary">{uiText("Fee")}</Text>
						<Text fontSize="xs" color="kk.textPrimary">{sats(result.fee)} · ~{result.satPerVbyte}{" "}{uiText("sat/vB (est.")}{" "}{result.estVsize}{" "}{uiText("vB)")}</Text>
					</Flex>
				</Box>
			)}

			{error && <Text fontSize="sm" color="var(--rose)">{error}</Text>}
		</Flex>
	)
}
