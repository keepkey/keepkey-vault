import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { BtcBroadcastReview } from "../../shared/types"

/** Fired with a File: a dropped signed raw tx (FirmwareDropZone), or a signed PSBT (PsbtSignDialog). */
export const BTC_BROADCAST_EVENT = "keepkey-btc-broadcast"
const MAX_BYTES = 1024 * 1024

type Phase = "idle" | "checking" | "review" | "sending" | "done" | "error"

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

function Mono({ children }: { children: React.ReactNode }) {
	return <Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">{children}</Text>
}

const card = { bg: "rgba(255,255,255,0.03)", borderRadius: "lg", border: "1px solid", borderColor: "kk.border", p: "3" } as const

/**
 * BroadcastSignedDialog — show a signed Bitcoin transaction (PSBT or raw hex) and
 * broadcast it only on an explicit click. Bun broadcasts through the BTC backend
 * (the user's own node when active) and checks the returned txid.
 */
export function BroadcastSignedDialog() {
	const [phase, setPhase] = useState<Phase>("idle")
	const [name, setName] = useState("")
	const [data, setData] = useState("")
	const [review, setReview] = useState<BtcBroadcastReview | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const phaseRef = useRef(phase)
	phaseRef.current = phase

	useEffect(() => {
		const onFile = async (e: Event) => {
			const file = (e as CustomEvent<File>).detail
			if (!file || phaseRef.current === "checking" || phaseRef.current === "sending") return
			setName(file.name)
			setReview(null)
			setError(null)
			if (file.size > MAX_BYTES) {
				setError("Transaction is larger than 1 MB, refusing")
				setPhase("error")
				return
			}
			setPhase("checking")
			try {
				const b64 = toBase64(new Uint8Array(await file.arrayBuffer()))
				setData(b64)
				setReview(await rpcRequest<BtcBroadcastReview>("btcBroadcastSigned", { data: b64 }, 60000))
				setPhase("review")
			} catch (err: any) {
				setError(err?.message || "Could not read this transaction")
				setPhase("error")
			}
		}
		window.addEventListener(BTC_BROADCAST_EVENT, onFile)
		return () => window.removeEventListener(BTC_BROADCAST_EVENT, onFile)
	}, [])

	const handleBroadcast = useCallback(async () => {
		setPhase("sending")
		setError(null)
		try {
			const res = await rpcRequest<BtcBroadcastReview>("btcBroadcastSigned", { data, send: true, backend: review?.backend, backendId: review?.backendId }, 120000)
			// Keep the fee the review proved from hash-checked previous txs (a raw tx alone cannot prove it).
			setReview(r => ({ ...res, fee: r?.fee ?? res.fee, feeSource: r?.feeSource ?? res.feeSource }))
			setPhase("done")
		} catch (err: any) {
			setError(err?.message || "Broadcast failed")
			setPhase("error")
		}
	}, [data, review])

	const handleCopy = useCallback((text: string) => {
		navigator.clipboard.writeText(text)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}, [])

	const handleDismiss = useCallback(() => {
		setPhase("idle")
		setReview(null)
		setError(null)
		setData("")
	}, [])

	if (phase === "idle") return null

	const goldButton = { size: "sm", bg: "kk.gold", color: "black", fontWeight: "600", px: "4", py: "2", _hover: { bg: "kk.goldHover" } } as const
	const plainButton = { size: "sm", variant: "outline", color: "kk.textSecondary", borderColor: "kk.border", px: "4", py: "2" } as const
	const busy = phase === "checking" || phase === "sending"
	const offline = review?.backend === "device-only"

	return (
		<>
			<Box position="fixed" inset="0" bg="rgba(0,0,0,0.85)" zIndex={Z.dialog} onClick={busy ? undefined : handleDismiss} />
			<Box
				position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)"
				w="560px" maxW="92vw" maxH="88vh" overflowY="auto"
				bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="xl"
				zIndex={Z.dialog + 1} role="dialog" aria-modal="true" aria-label="Broadcast Bitcoin transaction"
			>
				<Box p="6">
					<Text fontSize="lg" fontWeight="700" color="kk.textPrimary">Broadcast Bitcoin transaction</Text>
					<Text fontSize="xs" color="kk.textSecondary" mb="4">Bitcoin mainnet{name ? ` · ${name}` : ""}</Text>

					{phase === "checking" && (
						<Flex align="center" gap="2" py="6" justify="center">
							<Spinner size="sm" color="kk.gold" />
							<Text fontSize="sm" color="kk.textSecondary">Reading the signed transaction...</Text>
						</Flex>
					)}

					{(phase === "review" || phase === "sending" || phase === "done") && review && (
						<Flex direction="column" gap="3">
							{phase === "done" && (
								<Text fontSize="sm" fontWeight="600" color="var(--teal-2)">Broadcast endpoint returned the expected transaction ID. This does not establish network propagation or confirmation.</Text>
							)}
							<Box {...card}>
								<Text fontSize="xs" fontWeight="700" color="kk.textSecondary" mb="2">TO ({review.outputs.length})</Text>
								{review.outputs.map((o, i) => (
									<Box key={i} mb="2">
										<Mono>{o.address ?? (o.opReturnHex !== undefined ? `OP_RETURN ${o.opReturnHex}` : `script ${o.scriptHex}`)}</Mono>
										<Text fontSize="xs" color="kk.textPrimary">{sats(o.amount)}</Text>
									</Box>
								))}
							</Box>
							<Box {...card}>
								<Flex justify="space-between" gap="2">
									<Text fontSize="xs" color="kk.textSecondary">Fee</Text>
									<Text fontSize="xs" color="kk.textPrimary" textAlign="right">
										{review.fee !== null ? sats(review.fee) : "Unknown: the input amounts could not be proven (Desktop does not guess)"}
									</Text>
								</Flex>
								<Text fontSize="xs" color="kk.textSecondary" mt="2">Transaction ID</Text>
								<Mono>{review.txid}</Mono>
								<Text fontSize="xs" color="kk.textSecondary" mt="2">
									Outputs come from the transaction itself. Your change is listed as an output too: check every address.
								</Text>
							</Box>
							<Text fontSize="xs" color="kk.textSecondary" textAlign="right">
								{offline ? "Offline mode: copy the raw hex, or go online to broadcast."
									: review.backend === "pioneer" ? "Broadcast via Pioneer"
									: `Broadcast via your own ${review.backend === "core" ? "Bitcoin Core" : review.backend} node`}
							</Text>
							{phase === "sending" ? (
								<Flex align="center" gap="2" justify="center" py="2">
									<Spinner size="sm" color="kk.gold" />
									<Text fontSize="sm" color="kk.textPrimary">Broadcasting...</Text>
								</Flex>
							) : (
								<Flex gap="2" justify="flex-end">
									<Button {...plainButton} onClick={() => handleCopy(phase === "done" ? review.txid : review.txHex)}>
										{copied ? "Copied" : phase === "done" ? "Copy transaction ID" : "Copy raw hex"}
									</Button>
									{phase === "done" ? (
										<Button {...goldButton} onClick={handleDismiss}>Done</Button>
									) : (
										<>
											<Button {...plainButton} onClick={handleDismiss}>Cancel</Button>
											{!offline && <Button {...goldButton} onClick={handleBroadcast}>Broadcast</Button>}
										</>
									)}
								</Flex>
							)}
						</Flex>
					)}

					{phase === "error" && (
						<Flex direction="column" gap="3">
							<Text fontSize="sm" color="var(--rose)">{error || "Unknown error"}</Text>
							<Flex gap="2" justify="flex-end">
								{review && <Button {...plainButton} onClick={() => setPhase("review")}>Back</Button>}
								<Button {...goldButton} onClick={handleDismiss}>Close</Button>
							</Flex>
						</Flex>
					)}
				</Box>
			</Box>
		</>
	)
}
