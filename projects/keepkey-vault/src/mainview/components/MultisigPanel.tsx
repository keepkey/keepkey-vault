/**
 * Safe multisig, inside Desktop. Everything shown is read from the chain or
 * re-derived on this computer: owners, threshold and nonce come from the Safe
 * contract, and each pending proposal's hash and signatures are recomputed,
 * so a proposal a phishing site or a compromised service altered shows as a
 * mismatch rather than as something to sign.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Box, Flex, Text, Spinner, VStack } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { playAttention, playSent } from "../lib/sounds"
import type { SafeInfo, PendingSafeTx } from "../../shared/types"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function nativeAmount(wei: string, symbol: string): string {
	const v = BigInt(wei || "0")
	if (v === 0n) return ""
	const whole = v / 10n ** 18n
	const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 6)
	return `${whole}${frac ? "." + frac : ""} ${symbol}`
}

function describe(tx: PendingSafeTx, info: SafeInfo): string {
	if (same(tx.to, info.address) && tx.decoded) return `Change this Safe: ${tx.decoded.method}`
	if (tx.decoded) return `${tx.decoded.dappName !== "Unknown" ? tx.decoded.dappName + " · " : ""}${tx.decoded.method}`
	if (!tx.data || tx.data === "0x") return "Send"
	return `Contract call ${tx.data.slice(0, 10)}`
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) {
	const c = { ok: "#48BB78", warn: "#f5c542", bad: "#F56565", muted: "var(--text-2)" }[tone]
	return (
		<Text as="span" fontSize="11px" fontWeight="600" color={c} px="2" py="0.5" borderRadius="999px"
			border="1px solid" borderColor={c} opacity={0.9} whiteSpace="nowrap">{children}</Text>
	)
}

const ZERO = "0x0000000000000000000000000000000000000000"

/** The fields in the order the KeepKey shows them, so they can be compared screen by screen. */
function reviewRows(tx: PendingSafeTx, info: SafeInfo, symbol: string): [string, string][] {
	const data = tx.data && tx.data !== "0x" ? tx.data : "0x"
	return [
		["Chain ID", String(info.chainId)],
		["Safe (verifying contract)", info.address],
		["to", tx.to],
		["value", `${tx.value} wei${nativeAmount(tx.value, symbol) ? ` (${nativeAmount(tx.value, symbol)})` : ""}`],
		["data", data === "0x" ? "none" : `${(data.length - 2) / 2} bytes: ${data}`],
		["operation", tx.operation === 1 ? "1 (delegate call)" : "0 (call)"],
		["safeTxGas", tx.safeTxGas],
		["baseGas", tx.baseGas],
		["gasPrice", tx.gasPrice],
		["gasToken", tx.gasToken === ZERO ? `${ZERO} (native)` : tx.gasToken],
		["refundReceiver", tx.refundReceiver],
		["nonce", tx.nonce],
	]
}

function SignOnDevice() {
	return createPortal(
		<Flex position="fixed" inset={0} bg="blackAlpha.800" zIndex={Z.dialog} align="center" justify="center" p="4"
			role="dialog" aria-modal="true" aria-label="Signing on KeepKey">
			<VStack bg="var(--bg-1, #111)" border="1px solid" borderColor="var(--line)" borderRadius="xl" p="6" maxW="420px" gap="3">
				<Spinner color="kk.gold" />
				<Text fontSize="15px" fontWeight="600" color="var(--text-0)">Confirm on your KeepKey</Text>
				<Text fontSize="13px" color="var(--text-2)" textAlign="center">
					Your KeepKey shows each field of this Safe transaction. Check every screen against the review in Desktop,
					and reject on the device if anything differs.
				</Text>
			</VStack>
		</Flex>,
		document.body,
	)
}

function PendingRow({ tx, info, me, symbol, onSigned }: { tx: PendingSafeTx; info: SafeInfo; me: string; symbol: string; onSigned: () => void }) {
	const [reviewing, setReviewing] = useState(false)
	const [signing, setSigning] = useState(false)
	const [signError, setSignError] = useState<string | null>(null)
	const isOwner = info.owners.some(o => same(o, me))
	// Only signatures checked here count toward the threshold.
	const confirmations = tx.confirmedBy.length
	const signedByMe = tx.confirmedBy.some(a => same(a, me))
	const canSign = isOwner && !signedByMe && tx.hashMatches

	const sign = async () => {
		setSigning(true); setSignError(null)
		playAttention()
		try {
			await rpcRequest("safeConfirm", { chainId: info.chainId, address: info.address, safeTxHash: tx.safeTxHash }, 600000)
			playSent()
			setReviewing(false)
			onSigned()
		} catch (e: any) {
			setSignError(e?.message || "Signing failed")
		} finally {
			setSigning(false)
		}
	}
	return (
		<Box p="3" borderRadius="lg" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor={tx.hashMatches ? "var(--line)" : "#F56565"}>
			<Flex justify="space-between" align="center" gap="2" wrap="wrap">
				<Text fontSize="13px" fontWeight="600" color="var(--text-0)">#{tx.nonce} · {describe(tx, info)}</Text>
				<Flex gap="1.5" wrap="wrap">
					{tx.hashMatches ? <Badge tone="ok">Hash matches</Badge> : <Badge tone="bad">Hash mismatch: do not sign</Badge>}
					{tx.delegateCall && <Badge tone="warn">Delegate call</Badge>}
					<Badge tone={confirmations >= info.threshold ? "ok" : "muted"}>{confirmations} of {info.threshold} signed</Badge>
					{tx.unverifiedConfirmations.length > 0 && <Badge tone="muted">{tx.unverifiedConfirmations.length} not verifiable</Badge>}
					{signedByMe && <Badge tone="ok">Signed by you</Badge>}
				</Flex>
			</Flex>
			<Text fontSize="12px" color="var(--text-2)" mt="1.5">
				To <Text as="span" fontFamily="mono" wordBreak="break-all">{tx.to}</Text>{nativeAmount(tx.value, symbol) && <> · {nativeAmount(tx.value, symbol)}</>}
			</Text>
			{tx.delegateCall && (
				<Text fontSize="12px" color="#f5c542" mt="1">A delegate call runs other code with this Safe's full authority. Only approve it if you know exactly what it does.</Text>
			)}
			<Text fontSize="11px" color="var(--text-2)" fontFamily="mono" mt="1.5" wordBreak="break-all">Safe tx hash {tx.safeTxHash}</Text>
			{canSign && !reviewing && (
				<Text as="button" fontSize="12px" fontWeight="600" color="var(--gold)" mt="2" onClick={() => setReviewing(true)}>Review and sign</Text>
			)}
			{reviewing && (
				<Box mt="2" p="3" borderRadius="md" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="var(--line)">
					<Text fontSize="12px" color="var(--text-1)" mb="2">Your KeepKey will show these fields. Each one must match.</Text>
					{reviewRows(tx, info, symbol).map(([k, v]) => (
						<Flex key={k} gap="3" fontSize="12px" py="0.5">
							<Text color="var(--text-2)" minW="150px">{k}</Text>
							<Text color="var(--text-0)" fontFamily="mono" wordBreak="break-all">{v}</Text>
						</Flex>
					))}
					{signError && <Text fontSize="12px" color="#F56565" mt="2">{signError}</Text>}
					<Flex gap="4" mt="3">
						<Text as="button" fontSize="13px" fontWeight="600" color="var(--gold)" onClick={sign}>Sign on KeepKey</Text>
						<Text as="button" fontSize="13px" color="var(--text-2)" onClick={() => { setReviewing(false); setSignError(null) }}>Cancel</Text>
					</Flex>
				</Box>
			)}
			{signing && <SignOnDevice />}
		</Box>
	)
}

function SafeCard({ info, me, symbol }: { info: SafeInfo; me: string; symbol: string }) {
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState<PendingSafeTx[] | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!open || pending) return
		rpcRequest<{ info: SafeInfo; pending: PendingSafeTx[] }>("safePending", { chainId: info.chainId, address: info.address }, 60000)
			.then(r => setPending(r.pending))
			.catch(e => setError(e?.message || "Could not load pending transactions"))
	}, [open, pending, info.chainId, info.address])

	return (
		<Box p="4" borderRadius="xl" bg="rgba(255,255,255,0.02)" border="1px solid" borderColor="var(--line)">
			<Flex as="button" w="100%" justify="space-between" align="center" onClick={() => setOpen(o => !o)} textAlign="left">
				<Box>
					<Text fontSize="14px" fontWeight="600" color="var(--text-0)" fontFamily="mono" wordBreak="break-all">{info.address}</Text>
					<Text fontSize="12px" color="var(--text-2)">{info.threshold} of {info.owners.length} owners must sign · Safe {info.version} · next nonce {info.nonce}</Text>
					<Flex mt="1" gap="1.5" wrap="wrap">
						{info.vetting.codeProblem ? <Badge tone="warn">Unrecognized Safe code</Badge> : <Badge tone="ok">Safe's own code</Badge>}
						{info.vetting.extensions.length > 0 && <Badge tone="muted">{info.vetting.extensions.length} extension{info.vetting.extensions.length > 1 ? "s" : ""}</Badge>}
					</Flex>
				</Box>
				<Text fontSize="12px" color="var(--gold)">{open ? "Hide" : "Open"}</Text>
			</Flex>
			{open && (
				<VStack align="stretch" gap="3" mt="3">
					{info.vetting.codeProblem && (
						<Text fontSize="12px" color="#f5c542">{info.vetting.codeProblem}, so its owners and threshold shown here cannot be confirmed.</Text>
					)}
					{info.vetting.extensions.length > 0 && (
						<Box>
							<Text fontSize="12px" fontWeight="600" color="var(--text-1)" mb="1">Extensions</Text>
							{info.vetting.extensions.map(e => <Text key={e} fontSize="12px" color="var(--text-2)">{e}</Text>)}
						</Box>
					)}
					<Box>
						<Text fontSize="12px" fontWeight="600" color="var(--text-1)" mb="1">Owners</Text>
						{info.owners.map(o => (
							<Text key={o} fontSize="12px" fontFamily="mono" color={same(o, me) ? "var(--gold)" : "var(--text-2)"}>
								{o}{same(o, me) ? "  (this KeepKey)" : ""}
							</Text>
						))}
					</Box>
					<Box>
						<Text fontSize="12px" fontWeight="600" color="var(--text-1)" mb="1">Waiting for signatures</Text>
						{error ? <Text fontSize="12px" color="#F56565">{error}</Text>
							: !pending ? <Spinner size="sm" color="kk.gold" />
							: pending.length === 0 ? <Text fontSize="12px" color="var(--text-2)">Nothing pending.</Text>
							: <VStack align="stretch" gap="2">{pending.map(tx => <PendingRow key={tx.safeTxHash} tx={tx} info={info} me={me} symbol={symbol} onSigned={() => setPending(null)} />)}</VStack>}
					</Box>
				</VStack>
			)}
		</Box>
	)
}

export function MultisigPanel({ chainId, chainName, symbol }: { chainId: number; chainName: string; symbol: string }) {
	const [state, setState] = useState<{ owner: string; safes: SafeInfo[]; errors: { address: string; error: string }[] } | null>(null)
	const [error, setError] = useState<string | null>(null)

	const load = useCallback(() => {
		setState(null); setError(null)
		rpcRequest<{ owner: string; safes: SafeInfo[]; errors: { address: string; error: string }[] }>("safeMine", { chainId }, 60000)
			.then(setState)
			.catch(e => setError(e?.message || "Could not load Safes"))
	}, [chainId])
	useEffect(load, [load])

	return (
		<VStack align="stretch" gap="3" py="2">
			<Box>
				<Text fontSize="15px" fontWeight="600" color="var(--text-0)">Multisig (Safe)</Text>
				<Text fontSize="12px" color="var(--text-2)">
					Safes on {chainName} whose contract lists this KeepKey as an owner. Owners and threshold are read
					from the blockchain, and each pending transaction's hash and signatures are checked on this computer.
					Anyone can create a Safe that lists your address, so only use Safes you recognize.
				</Text>
			</Box>
			{error ? (
				<Flex align="center" gap="2"><Text fontSize="13px" color="#F56565">{error}</Text><Text as="button" fontSize="12px" color="var(--gold)" onClick={load}>Retry</Text></Flex>
			) : !state ? (
				<Flex align="center" gap="2"><Spinner size="sm" color="kk.gold" /><Text fontSize="13px" color="var(--text-2)">Looking for your Safes…</Text></Flex>
			) : (
				<>
					{state.errors.length > 0 && (
						<Flex align="center" gap="2" wrap="wrap">
							<Text fontSize="13px" color="#F56565">
								Could not read {state.errors.length} Safe{state.errors.length > 1 ? "s" : ""} from the blockchain: {state.errors[0].error}
							</Text>
							<Text as="button" fontSize="12px" color="var(--gold)" onClick={load}>Retry</Text>
						</Flex>
					)}
					{state.safes.length === 0 && state.errors.length === 0 && (
						<Text fontSize="13px" color="var(--text-2)">No Safe on {chainName} lists this KeepKey ({state.owner}) as an owner yet.</Text>
					)}
					{state.safes.map(s => <SafeCard key={s.address} info={s} me={state.owner} symbol={symbol} />)}
				</>
			)}
			<Text fontSize="11px" color="var(--text-2)">Executing, and guided setup for new Safes and owner changes, are coming next.</Text>
		</VStack>
	)
}
