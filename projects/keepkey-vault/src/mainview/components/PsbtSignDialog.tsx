import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Spinner, Textarea } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { looksLikePsbt } from "../../shared/psbt-sniff"
import type { BtcPsbtReview } from "../../shared/types"

/** FirmwareDropZone fires this with the dropped File once its content sniffs as a PSBT. */
export const PSBT_DROP_EVENT = "keepkey-psbt-drop"
const MAX_PSBT_BYTES = 1024 * 1024

type Review = Extract<BtcPsbtReview, { kind: "review" }>
type Phase = "idle" | "paste" | "analyzing" | "review" | "signing" | "done" | "signed" | "error"

function toBase64(bytes: Uint8Array): string {
	const CHUNK = 8192
	let binary = ""
	for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
	return btoa(binary)
}

/** Exact: "12,345 sats (0.00012345 BTC)". Amounts arrive as decimal strings. */
function sats(v: string): string {
	const n = BigInt(v)
	return `${n.toLocaleString()} sats (${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")} BTC)`
}

function Mono({ children, color = "kk.textPrimary" }: { children: React.ReactNode; color?: string }) {
	return <Text fontSize="xs" fontFamily="mono" color={color} wordBreak="break-all">{children}</Text>
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
	return (
		<Box as="span" px="1.5" py="0.5" borderRadius="sm" fontSize="10px" fontWeight="700" whiteSpace="nowrap"
			bg={ok ? "rgba(168,239,210,0.12)" : "rgba(233,196,106,0.12)"} color={ok ? "var(--teal-2)" : "var(--gold)"}>
			{children}
		</Box>
	)
}

const card = { bg: "rgba(255,255,255,0.03)", borderRadius: "lg", border: "1px solid", borderColor: "kk.border", p: "3" } as const

/**
 * PsbtSignDialog — review and sign a Bitcoin PSBT dropped on the window or pasted.
 *
 * Bun decodes the PSBT, proves every input is ours from Desktop's own xpubs and
 * holds the analysis; this dialog only shows it and sends the review id back on
 * an explicit Sign click. No network: works online and offline.
 */
export function PsbtSignDialog() {
	const [phase, setPhase] = useState<Phase>("idle")
	const [name, setName] = useState("")
	const [review, setReview] = useState<Review | null>(null)
	const [signed, setSigned] = useState<{ txid: string; txHex: string; fee?: string | null; filePath?: string } | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [pasted, setPasted] = useState("")
	const [copied, setCopied] = useState(false)
	const phaseRef = useRef(phase)
	phaseRef.current = phase

	const analyze = useCallback(async (bytes: Uint8Array, fileName: string) => {
		setPhase("analyzing")
		setName(fileName)
		setError(null)
		setReview(null)
		setSigned(null)
		try {
			if (bytes.length > MAX_PSBT_BYTES) throw new Error("PSBT is larger than 1 MB, refusing")
			const result = await rpcRequest<BtcPsbtReview>("btcPsbtAnalyze", { data: toBase64(bytes), name: fileName }, 60000)
			if (result.kind === "signed") {
				setSigned(result)
				setPhase("signed")
			} else {
				setReview(result)
				setPhase("review")
			}
		} catch (err: any) {
			setError(err?.message || "Could not read this PSBT")
			setPhase("error")
		}
	}, [])

	// Drops (from FirmwareDropZone) and a PSBT pasted anywhere outside a text field.
	// Neither signs: both only open the review. New input is ignored while busy.
	useEffect(() => {
		const busy = () => phaseRef.current === "analyzing" || phaseRef.current === "signing"
		const onDrop = async (e: Event) => {
			const file = (e as CustomEvent<File>).detail
			if (busy() || !file) return
			if (file.size > MAX_PSBT_BYTES) {
				setName(file.name)
				setError("PSBT is larger than 1 MB, refusing")
				setPhase("error")
				return
			}
			await analyze(new Uint8Array(await file.arrayBuffer()), file.name)
		}
		const onPaste = (e: ClipboardEvent) => {
			const target = e.target as HTMLElement | null
			if (busy() || target?.closest("input, textarea, [contenteditable='true']")) return
			const text = e.clipboardData?.getData("text") || ""
			const bytes = new TextEncoder().encode(text)
			if (!looksLikePsbt(bytes)) return
			e.preventDefault()
			void analyze(bytes, "pasted")
		}
		window.addEventListener(PSBT_DROP_EVENT, onDrop)
		document.addEventListener("paste", onPaste)
		return () => {
			window.removeEventListener(PSBT_DROP_EVENT, onDrop)
			document.removeEventListener("paste", onPaste)
		}
	}, [analyze])

	const handleSign = useCallback(async () => {
		if (!review) return
		setPhase("signing")
		setError(null)
		try {
			// No timeout: the user confirms every output, then the total and fee, on the device.
			const result = await rpcRequest<{ filePath: string; txHex: string; txid: string }>("btcPsbtSign", { id: review.id }, 0)
			setSigned(result)
			setPhase("done")
		} catch (err: any) {
			setError(err?.message || "Signing failed")
			setPhase("error")
		}
	}, [review])

	const handleCopy = useCallback(() => {
		if (!signed) return
		navigator.clipboard.writeText(signed.txHex)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}, [signed])

	const handleDismiss = useCallback(() => {
		setPhase("idle")
		setReview(null)
		setSigned(null)
		setError(null)
		setPasted("")
		setName("")
	}, [])

	if (phase === "idle") return null

	const goldButton = { size: "sm", bg: "kk.gold", color: "black", fontWeight: "600", px: "4", py: "2", _hover: { bg: "kk.goldHover" } } as const
	const plainButton = { size: "sm", variant: "outline", color: "kk.textSecondary", borderColor: "kk.border", px: "4", py: "2" } as const
	const warnings: string[] = []
	if (review) {
		const f = review.flags
		if (f.unverifiedAmounts) warnings.push("The input amount is not verified: this file has no previous transaction, so the fee is taken on trust from it.")
		if (f.multiAccount) warnings.push("Inputs come from more than one account. The KeepKey will show every output, change included.")
		if (f.ownOutputShown) warnings.push("An output pays back to this wallet but is not standard change. The KeepKey shows its address.")
		if (f.noChange) warnings.push("No change output: everything except the outputs below goes to the fee.")
		if (review.feePercent !== null && review.feePercent > 5) warnings.push(`High fee: ${review.feePercent}% of the amount sent.`)
		if (f.nonZeroLocktime) warnings.push(`Locktime ${review.locktime}: the KeepKey does not show this.`)
		if (f.unusualVersion) warnings.push(`Unusual transaction version ${review.version}.`)
	}

	return (
		<>
			<Box position="fixed" inset="0" bg="rgba(0,0,0,0.85)" zIndex={Z.dialog}
				onClick={phase === "signing" || phase === "analyzing" ? undefined : handleDismiss} />
			<Box
				position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)"
				w="560px" maxW="92vw" maxH="88vh" overflowY="auto"
				bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="xl"
				zIndex={Z.dialog + 1} role="dialog" aria-modal="true" aria-label="Sign Bitcoin PSBT"
			>
				<Box p="6">
					<Text fontSize="lg" fontWeight="700" color="kk.textPrimary">Sign Bitcoin PSBT</Text>
					<Text fontSize="xs" color="kk.textSecondary" mb="4">Bitcoin mainnet{name ? ` · ${name}` : ""}</Text>

					{phase === "analyzing" && (
						<Flex align="center" gap="2" py="6" justify="center">
							<Spinner size="sm" color="kk.gold" />
							<Text fontSize="sm" color="kk.textSecondary">Checking the PSBT against this wallet...</Text>
						</Flex>
					)}

					{phase === "paste" && (
						<>
							<Text fontSize="sm" color="kk.textSecondary" mb="2">Paste a PSBT (base64 or hex):</Text>
							<Textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} fontFamily="mono" fontSize="xs" mb="3" placeholder="cHNidP8..." />
							<Flex gap="2" justify="flex-end">
								<Button {...plainButton} onClick={handleDismiss}>Cancel</Button>
								<Button {...goldButton} disabled={!pasted.trim()} onClick={() => void analyze(new TextEncoder().encode(pasted), "pasted")}>Check</Button>
							</Flex>
						</>
					)}

					{(phase === "review" || phase === "signing") && review && (
						<Flex direction="column" gap="3">
							{warnings.length > 0 && (
								<Box {...card} borderColor="rgba(233,196,106,0.4)" bg="rgba(233,196,106,0.06)">
									{warnings.map((w) => <Text key={w} fontSize="xs" color="var(--gold)">{w}</Text>)}
								</Box>
							)}

							<Box {...card}>
								<Text fontSize="xs" fontWeight="700" color="kk.textSecondary" mb="2">FROM ({review.inputs.length})</Text>
								{review.inputs.map((x) => (
									<Box key={`${x.txid}:${x.vout}`} mb="2">
										<Mono>{x.address}</Mono>
										<Flex justify="space-between" align="center" gap="2" mt="0.5">
											<Text fontSize="xs" color="kk.textSecondary">{x.path} · {x.scriptType}</Text>
											<Badge ok={x.amountVerified}>{x.amountVerified ? "amount verified" : "amount not verified"}</Badge>
										</Flex>
										<Text fontSize="xs" color="kk.textPrimary">{sats(x.amount)}</Text>
									</Box>
								))}
							</Box>

							<Box {...card}>
								<Text fontSize="xs" fontWeight="700" color="kk.textSecondary" mb="2">TO ({review.outputs.length})</Text>
								{review.outputs.map((o) => (
									<Box key={o.index} mb="2">
										{o.opReturn ? (
											<>
												<Mono>OP_RETURN {o.opReturn.hex}</Mono>
												{o.opReturn.text && <Text fontSize="xs" color="kk.textSecondary">"{o.opReturn.text}"</Text>}
											</>
										) : (
											<Mono>{o.address}</Mono>
										)}
										<Flex justify="space-between" align="center" gap="2" mt="0.5">
											<Text fontSize="xs" color="kk.textPrimary">{sats(o.amount)}</Text>
											<Badge ok={o.deviceWillShow !== "address" || o.kind === "payment"}>
												{o.deviceWillShow === "hidden-change" ? `change, hidden on KeepKey · ${o.path}`
													: o.deviceWillShow === "op-return" ? "KeepKey shows the data"
													: o.kind === "own" ? `yours (${o.path}) · KeepKey shows address`
													: "KeepKey shows address"}
											</Badge>
										</Flex>
									</Box>
								))}
							</Box>

							<Box {...card}>
								<Flex justify="space-between"><Text fontSize="xs" color="kk.textSecondary">Sent (excluding change)</Text><Text fontSize="xs" color="kk.textPrimary">{sats(review.sent)}</Text></Flex>
								<Flex justify="space-between"><Text fontSize="xs" color="kk.textSecondary">Fee</Text><Text fontSize="xs" color="kk.textPrimary">{sats(review.fee)}</Text></Flex>
								<Flex justify="space-between">
									<Text fontSize="xs" color="kk.textSecondary">Fee rate</Text>
									<Text fontSize="xs" color="kk.textPrimary">~{review.satPerVbyte} sat/vB (est. {review.estVsize} vB){review.feePercent !== null ? ` · ${review.feePercent}% of sent` : ""}</Text>
								</Flex>
								<Flex justify="space-between" mt="1">
									<Text fontSize="xs" color="kk.textSecondary">KeepKey "total" screen (sent + fee)</Text>
									<Text fontSize="xs" fontWeight="700" color="kk.gold">{sats(review.deviceTotal)}</Text>
								</Flex>
								<Text fontSize="xs" color="kk.textSecondary" mt="2">
									Version {review.version} · Locktime {review.locktime} · {review.flags.rbf ? "Replaceable (RBF)" : "Not replaceable"} — not shown on the KeepKey
								</Text>
							</Box>

							{phase === "signing" ? (
								<Flex align="center" gap="2" justify="center" py="2">
									<Spinner size="sm" color="kk.gold" />
									<Text fontSize="sm" color="kk.textPrimary">Confirm each recipient, then the total and fee, on your KeepKey.</Text>
								</Flex>
							) : (
								<Flex gap="2" justify="flex-end">
									<Button {...plainButton} onClick={handleDismiss}>Cancel</Button>
									<Button {...goldButton} onClick={handleSign}>Sign with KeepKey</Button>
								</Flex>
							)}
						</Flex>
					)}

					{(phase === "done" || phase === "signed") && signed && (
						<Flex direction="column" gap="3">
							<Text fontSize="sm" fontWeight="600" color="var(--teal-2)">
								{phase === "done" ? "Signed. Load the file back into your wallet, or broadcast the raw transaction." : "This PSBT is already signed."}
							</Text>
							<Box {...card}>
								{signed.filePath && (
									<Box mb="2">
										<Text fontSize="xs" color="kk.textSecondary">Saved to</Text>
										<Mono>{signed.filePath}</Mono>
									</Box>
								)}
								<Text fontSize="xs" color="kk.textSecondary">Transaction ID</Text>
								<Mono>{signed.txid}</Mono>
								{phase === "signed" && (
									<Text fontSize="xs" color="kk.textSecondary" mt="2">
										Fee: {signed.fee != null ? sats(signed.fee) : "unknown (the file does not prove its input amounts)"}
									</Text>
								)}
							</Box>
							<Flex gap="2" justify="flex-end">
								{signed.filePath && <Button {...plainButton} onClick={() => void rpcRequest("btcPsbtShowFile")}>Show in Finder</Button>}
								<Button {...plainButton} onClick={handleCopy}>{copied ? "Copied" : "Copy raw hex"}</Button>
								<Button {...goldButton} onClick={handleDismiss}>Done</Button>
							</Flex>
						</Flex>
					)}

					{phase === "error" && (
						<Flex direction="column" gap="3">
							<Text fontSize="sm" color="var(--rose)">{error || "Unknown error"}</Text>
							<Flex gap="2" justify="flex-end">
								{review && <Button {...plainButton} onClick={() => setPhase("review")}>Back to review</Button>}
								<Button {...plainButton} onClick={() => { setReview(null); setPhase("paste") }}>Paste a PSBT</Button>
								<Button {...goldButton} onClick={handleDismiss}>Close</Button>
							</Flex>
						</Flex>
					)}
				</Box>
			</Box>
		</>
	)
}
