import {useBtcMultisigEnabled} from "../hooks/useBtcMultisigEnabled"
import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Spinner, Textarea } from "@chakra-ui/react"
import { base64, hex } from "@scure/base"
import { BitcoinQrDialog } from "./BitcoinQrDialog"
import { rpcRequest } from "../lib/rpc"
import { BITCOIN_QR_SCAN_EVENT } from "./BitcoinQrImport"
import { Z } from "../lib/z-index"
import { MULTISIG_POLICY_EVENT, MULTISIG_ENROLLED_EVENT, type BtcPsbtSigned } from "../../shared/multisig-policy"
import type { BtcPsbtReview } from "../../shared/types"
import { BTC_BROADCAST_EVENT } from "./BroadcastSignedDialog"

/** FirmwareDropZone fires this with the dropped File once its content sniffs as a PSBT. */
export const PSBT_DROP_EVENT = "keepkey-psbt-drop"
/** The BTC asset page fires this to open the paste box. */
export const PSBT_PASTE_EVENT = "keepkey-psbt-paste"
const MAX_PSBT_BYTES = 1024 * 1024

type Review = Extract<BtcPsbtReview, { kind: "review" }>
type Phase = "idle" | "policy" | "paste" | "analyzing" | "review" | "signing" | "done" | "error"

export function toBase64(bytes: Uint8Array): string {
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
	const multisigEnabled=useBtcMultisigEnabled()
	const [phase, setPhase] = useState<Phase>("idle")
	const [name, setName] = useState("")
	const [review, setReview] = useState<Review | null>(null)
	const [signed, setSigned] = useState<BtcPsbtSigned | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [pasted, setPasted] = useState("")
	const [showQr, setShowQr] = useState<"psbt" | "transaction" | null>(null)
	const [copied, setCopied] = useState(false)
	const pendingInput = useRef<{bytes:Uint8Array;name:string}|null>(null)
	const phaseRef = useRef(phase)
	phaseRef.current = phase

	const analyze = useCallback(async (bytes: Uint8Array, fileName: string) => {
		pendingInput.current={bytes,name:fileName}
		setPhase("analyzing")
		setName(fileName)
		setError(null)
		setReview(null)
		setSigned(null)
		try {
			if (bytes.length > MAX_PSBT_BYTES) throw new Error("PSBT is larger than 1 MB, refusing")
			const result = await rpcRequest<BtcPsbtReview>("btcPsbtAnalyze", { data: toBase64(bytes), name: fileName }, 60000)
			if (result.kind === "signed") {
				// Already signed: nothing to sign, so review it for broadcast instead.
				window.dispatchEvent(new CustomEvent(BTC_BROADCAST_EVENT, { detail: new File([new Uint8Array(bytes)], fileName) }))
				setPhase("idle")
			} else if (result.kind === "policy-required") {
				setError(result.message); setPhase("policy")
			} else {
				setReview(result)
				setPhase("review")
			}
		} catch (err: any) {
			setError(err?.message || "Could not read this PSBT")
			setPhase("error")
		}
	}, [])

	// Drops (from FirmwareDropZone) open the review; the asset page opens the paste box.
	// Neither signs. New input is ignored while busy.
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
		const onPaste = () => {
			if (busy()) return
			setReview(null)
			setSigned(null)
			setError(null)
			setName("")
			setPhase("paste")
		}
		const onEnrolled=()=>{const p=pendingInput.current;if(phaseRef.current==="policy"&&p)void analyze(p.bytes,p.name)}
		window.addEventListener(MULTISIG_ENROLLED_EVENT,onEnrolled)
		window.addEventListener(PSBT_DROP_EVENT, onDrop)
		window.addEventListener(PSBT_PASTE_EVENT, onPaste)
		return () => {
			window.removeEventListener(MULTISIG_ENROLLED_EVENT,onEnrolled)
			window.removeEventListener(PSBT_DROP_EVENT, onDrop)
			window.removeEventListener(PSBT_PASTE_EVENT, onPaste)
		}
	}, [analyze])

	const handleSign = useCallback(async () => {
		if (!review) return
		setPhase("signing")
		setError(null)
		try {
			// No timeout: the user confirms every output, then the total and fee, on the device.
			const result = await rpcRequest<BtcPsbtSigned>("btcPsbtSign", { id: review.id }, 0)
			setSigned(result)
			setPhase("done")
		} catch (err: any) {
			setError(err?.message || "Signing failed")
			setPhase("error")
		}
	}, [review])

	const handleCopy = useCallback(() => {
		if (!signed?.txHex) return
		navigator.clipboard.writeText(signed.txHex)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}, [signed])

	const handleDismiss = useCallback(() => {
		pendingInput.current=null
		setPhase("idle")
		setReview(null)
		setSigned(null)
		setShowQr(null)
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
		// Wallets set a block-height locktime by default (anti-fee-sniping, shown in the info line); a timestamp one is unusual.
		if (f.nonZeroLocktime && review.locktime >= 500000000) warnings.push(`Locktime ${review.locktime} is a timestamp: the KeepKey does not show this.`)
		if (f.unusualVersion) warnings.push(`Unusual transaction version ${review.version}.`)
	}

	return (
		<>
			{signed && showQr && <BitcoinQrDialog bytes={showQr === "psbt" ? base64.decode(signed.psbtBase64) : hex.decode(signed.txHex!)} title={showQr === "psbt" ? "Signed PSBT QR" : "Signed transaction QR"} onClose={() => setShowQr(null)} />}
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

					{phase === "policy" && <Flex direction="column" gap="3"><Text fontSize="sm">{error}</Text><Button {...plainButton} onClick={()=>window.dispatchEvent(new Event(MULTISIG_POLICY_EVENT))}>Import and verify multisig policy</Button><Button {...plainButton} onClick={handleDismiss}>Close</Button></Flex>}

					{phase === "paste" && (
						<>
							<Text fontSize="sm" color="kk.textSecondary" mb="2">Paste a PSBT (base64 or hex), or drop the file on this window:</Text>
							<Textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} fontFamily="mono" fontSize="xs" mb="3" placeholder="cHNidP8..." />
							<Flex gap="2" justify="flex-end">
								<Button {...plainButton} onClick={handleDismiss}>Cancel</Button>
								{multisigEnabled && <Button {...plainButton} onClick={()=>window.dispatchEvent(new Event(MULTISIG_POLICY_EVENT))}>Multisig setup</Button>}
								<Button {...plainButton} onClick={() => { handleDismiss(); window.dispatchEvent(new Event(BITCOIN_QR_SCAN_EVENT)) }}>Scan QR</Button>
								<Button {...goldButton} disabled={!pasted.trim()} onClick={() => void analyze(new TextEncoder().encode(pasted), "pasted")}>Check</Button>
							</Flex>
						</>
					)}

					{(phase === "review" || phase === "signing") && review && (
						<Flex direction="column" gap="3">
							<Text fontSize="xs" color="kk.textSecondary">
								KeepKey communicates with this computer over USB. For offline signing, disconnect the computer from the network.
								Removable media and transaction parsers remain attack surfaces. This review does not establish whether the inputs are still unspent.
							</Text>
							{review.multisig && <Box {...card}><Text fontSize="sm" fontWeight="600">{review.multisig.threshold} of {review.multisig.cosigners} multisig · KeepKey {review.multisig.fingerprint}</Text><Text fontSize="xs">Verified signatures per input: {review.multisig.signedCounts.join(", ")}. Desktop adds this KeepKey’s signature; return the PSBT to your coordinator.</Text></Box>}
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

					{phase === "done" && signed && (
						<Flex direction="column" gap="3">
							<Text fontSize="sm" fontWeight="600" color="var(--teal-2)">
								{signed.complete ? (signed.threshold ? "Signed. Quorum reached; return the PSBT to your coordinator or broadcast the completed transaction." : "Signed. Load the file back into your wallet, or broadcast the raw transaction.") : "KeepKey’s signature added. More signatures are needed. Return this PSBT to Sparrow or Electrum."}
							</Text>
							<Box {...card}>
								<Box mb="2">
									<Text fontSize="xs" color="kk.textSecondary">Saved to</Text>
									<Mono>{signed.filePath}</Mono>
								</Box>
								{signed.txid && <><Text fontSize="xs" color="kk.textSecondary">Transaction ID</Text><Mono>{signed.txid}</Mono></>}
							</Box>
							<Flex gap="2" justify="flex-end" wrap="wrap">
								<Button {...plainButton} onClick={() => setShowQr("psbt")}>Signed PSBT QR</Button>
								{signed.txHex && <Button {...plainButton} onClick={() => setShowQr("transaction")}>Raw transaction QR</Button>}
								<Button {...plainButton} onClick={() => void rpcRequest("btcPsbtShowFile")}>Show in Finder</Button>
								{signed.txHex && <Button {...plainButton} onClick={handleCopy}>{copied ? "Copied" : "Copy raw hex"}</Button>}
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
