/**
 * Guided Safe creation. Owners and threshold are chosen here, Desktop computes
 * and checks everything the deploy commits to, and the new Safe is read back
 * from the chain before it is shown as ready. Firmware 7.16 cannot read the
 * deploy, so the review below is what the user checks; the KeepKey signs it
 * under AdvancedMode, which Desktop turns off again right after.
 */
import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { Box, Flex, Text, Spinner, VStack, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { playAttention, playSent } from "../lib/sounds"
import { useEvmAddresses } from "../hooks/useEvmAddresses"
import { useDeviceState } from "../hooks/useDeviceState"
import { lookalikeOf } from "../../shared/address-lookalike"
import type { AddressBookEntry } from "../../shared/types"

type Plan = {
	plan: { chainId: number; owners: string[]; threshold: number; saltNonce: string; factory: string; singleton: string; fallbackHandler: string; predicted: string }
	ownerCode: Record<string, "none" | "contract">; payer: string; fee: string; balance: string; payerOwnsSafe: boolean; advancedMode: boolean | null; calldataHash: string
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const eth = (wei: string) => (Number(BigInt(wei)) / 1e18).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")

function Row({ k, v }: { k: string; v: string }) {
	return (
		<Flex gap="3" fontSize="12px" py="0.5">
			<Text color="var(--text-2)" minW="140px">{k}</Text>
			<Text color="var(--text-0)" fontFamily="mono" wordBreak="break-all">{v}</Text>
		</Flex>
	)
}

function Creating() {
	return createPortal(
		<Flex position="fixed" inset={0} bg="blackAlpha.800" zIndex={Z.dialog} align="center" justify="center" p="4" role="dialog" aria-modal="true" aria-label="Creating Safe">
			<VStack bg="var(--bg-1, #111)" border="1px solid" borderColor="var(--line)" borderRadius="xl" p="6" maxW="440px" gap="3" align="stretch">
				<Flex justify="center"><Spinner color="kk.gold" /></Flex>
				<Text fontSize="15px" fontWeight="600" color="var(--text-0)" textAlign="center">Creating your Safe</Text>
				<Text fontSize="13px" color="var(--text-2)">Your KeepKey will ask you to:</Text>
				<Text fontSize="13px" color="var(--text-1)">1. Turn Advanced Mode on, for this one transaction.</Text>
				<Text fontSize="13px" color="var(--text-1)">2. Sign the transaction to Safe's factory. It shows the factory address and data it cannot read; compare them with the review.</Text>
				<Text fontSize="13px" color="var(--text-1)">3. Turn Advanced Mode off again.</Text>
				<Text fontSize="12px" color="var(--text-2)">Then Desktop waits for the transaction and reads the new Safe back from the chain.</Text>
			</VStack>
		</Flex>,
		document.body,
	)
}

export function SafeCreateWizard({ chainId, chainName, symbol, onClose, onCreated }: {
	chainId: number; chainName: string; symbol: string; onClose: () => void; onCreated: () => void
}) {
	const { evmAddresses } = useEvmAddresses()
	const { isHiddenWallet } = useDeviceState()
	const [owners, setOwners] = useState<string[]>([])
	const [pasted, setPasted] = useState("")
	const [pastedName, setPastedName] = useState("")
	const [saveCosigner, setSaveCosigner] = useState(true)
	const [entries, setEntries] = useState<AddressBookEntry[]>([])
	const [showOthers, setShowOthers] = useState(false)
	const [threshold, setThreshold] = useState(1)
	const [review, setReview] = useState<Plan | null>(null)
	const [busy, setBusy] = useState<"planning" | "creating" | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState<{ address: string; txHash: string } | null>(null)

	const ownList = evmAddresses.addresses
	const selected = ownList.find(a => a.addressIndex === evmAddresses.selectedIndex)?.address
	const chosen = owners.length ? owners : selected ? [selected] : []
	const toggle = (a: string) => { setReview(null); setOwners(chosen.some(o => same(o, a)) ? chosen.filter(o => !same(o, a)) : [...chosen, a]) }

	const loadBook = () => rpcRequest<AddressBookEntry[]>("listAddressBook", {}, 10000).then(setEntries).catch(() => setEntries([]))
	useEffect(() => { loadBook() }, [])
	// Saved EVM addresses (any network: a Safe owner is the same address everywhere), one row per
	// address, co-signers first. This KeepKey's own accounts are listed above, not here.
	const book = useMemo(() => {
		const byAddr = new Map<string, { address: string; name?: string; cosigner: boolean; source: string; ids: string[] }>()
		for (const e of entries) {
			if (!e.networkId.startsWith("eip155:") || ownList.some(o => same(o.address, e.address))) continue
			const key = e.address.toLowerCase()
			const row = byAddr.get(key) ?? { address: e.address, cosigner: false, source: e.kind === "own" ? `Your wallet${e.deviceLabel ? `: ${e.deviceLabel}` : ""}` : "Contact", ids: [] }
			row.name ||= e.label
			row.cosigner ||= !!e.cosigner
			row.ids.push(e.id)
			byAddr.set(key, row)
		}
		return [...byAddr.values()].sort((a, b) => Number(b.cosigner) - Number(a.cosigner) || (a.name || "~").localeCompare(b.name || "~"))
	}, [entries, ownList])

	const addPasted = async () => {
		const a = pasted.trim()
		if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { setError("Paste a full 0x address (40 hex characters)"); return }
		setError(null); setReview(null)
		// This KeepKey's own accounts are listed above; never save them as contacts.
		if (saveCosigner && !isHiddenWallet && !ownList.some(o => same(o.address, a))) {
			const saved = book.find(b => same(b.address, a))
			try {
				// Already saved: only set the flag, never overwrite the name the user gave it.
				if (saved) await Promise.all(saved.ids.map(id => rpcRequest("updateAddressBook", { id, cosigner: true }, 8000)))
				else await rpcRequest("addAddressBook", { networkId: `eip155:${chainId}`, address: a, label: pastedName.trim() || undefined, cosigner: true }, 8000)
				await loadBook()
			} catch (e: any) {
				// Not added as an owner either: a save refused for a bad checksum means the address is wrong.
				setError(`Not added: ${e?.message || e}`)
				return
			}
		}
		if (!chosen.some(o => same(o, a))) setOwners([...chosen, a])
		setPasted(""); setPastedName("")
	}
	const label = (a: string) => {
		const own = ownList.find(o => same(o.address, a))
		if (own) return `KeepKey account ${own.addressIndex}`
		const saved = book.find(b => same(b.address, a))
		return saved ? `${saved.name || "Unnamed"} (your address book, not verified)` : "Another key (pasted)"
	}
	const t = Math.min(threshold, Math.max(chosen.length, 1))

	// Owners that are not this KeepKey: if they alone reach the threshold, the KeepKey is not needed to spend.
	const others = chosen.filter(o => !ownList.some(a => same(a.address, o)))
	const keepkeyOptional = others.length >= t
	const known = [...ownList.map(o => ({ address: o.address, name: `KeepKey account ${o.addressIndex}` })), ...book.map(b => ({ address: b.address, name: b.name || "a saved address" }))]
	const twinOf = (o: string) => lookalikeOf(o, known.concat(chosen.map(c => ({ address: c, name: "another owner" }))).filter(k => !same(k.address, o)))
	const twinWarning = (o: string) => {
		const twin = twinOf(o)
		return twin && <Text fontSize="11px" color="#F56565" pl="6">Looks like {twin.name} ({twin.address}) but is a different address. Check it character by character.</Text>
	}

	const plan = async () => {
		setBusy("planning"); setError(null)
		try { setReview(await rpcRequest<Plan>("safeCreatePlan", { chainId, owners: chosen, threshold: t }, 60000)) }
		catch (e: any) { setError(e?.message || "Could not plan the Safe") }
		finally { setBusy(null) }
	}
	const create = async () => {
		if (!review) return
		setBusy("creating"); setError(null)
		playAttention()
		try {
			const r = await rpcRequest<{ address: string; txHash: string }>("safeCreate", {
				chainId, owners: review.plan.owners, threshold: review.plan.threshold, saltNonce: review.plan.saltNonce, predicted: review.plan.predicted,
			}, 0)
			playSent()
			setDone(r)
		} catch (e: any) {
			setError(e?.message || "Creating the Safe failed")
		} finally {
			setBusy(null)
		}
	}

	if (done) return (
		<Box p="4" borderRadius="xl" border="1px solid" borderColor="#48BB78">
			<Text fontSize="14px" fontWeight="600" color="var(--text-0)">Your Safe is ready</Text>
			<Text fontSize="12px" fontFamily="mono" color="var(--text-0)" wordBreak="break-all" mt="1">{done.address}</Text>
			<Text fontSize="12px" color="var(--text-2)" mt="1">
				Read back from {chainName}: it runs Safe's own code with exactly the owners and threshold you chose.
			</Text>
			<Text fontSize="11px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all" mt="1">Transaction {done.txHash}</Text>
			<Text as="button" fontSize="13px" fontWeight="600" color="var(--gold)" mt="3" onClick={() => { onCreated(); onClose() }}>Done</Text>
		</Box>
	)

	const cannotPay = review && (review.payerOwnsSafe || BigInt(review.balance) < BigInt(review.fee))
	return (
		<Box p="4" borderRadius="xl" border="1px solid" borderColor="var(--line)" bg="rgba(255,255,255,0.02)">
			<Text fontSize="14px" fontWeight="600" color="var(--text-0)">Create a Safe on {chainName}</Text>
			<Text fontSize="12px" color="var(--text-2)" mt="1">
				A Safe is an account that only moves funds when enough owners sign. Use keys on different devices, so losing or
				compromising one is not enough to take the funds.
			</Text>

			<Text fontSize="12px" fontWeight="600" color="var(--text-1)" mt="3" mb="1">Owners</Text>
			{ownList.map(a => (
				<Flex key={a.address} as="label" gap="2" align="center" fontSize="12px" py="0.5" cursor="pointer">
					<input type="checkbox" checked={chosen.some(o => same(o, a.address))} onChange={() => toggle(a.address)} />
					<Text color="var(--text-1)" minW="130px">KeepKey account {a.addressIndex}</Text>
					<Text fontFamily="mono" color="var(--text-0)" wordBreak="break-all">{a.address}</Text>
				</Flex>
			))}
			{book.filter(b => b.cosigner || showOthers || chosen.some(o => same(o, b.address))).map(b => (
				<Box key={b.address}>
					<Flex as="label" gap="2" align="center" fontSize="12px" py="0.5" cursor="pointer">
						<input type="checkbox" checked={chosen.some(o => same(o, b.address))} onChange={() => toggle(b.address)} />
						<Text color="var(--text-1)" minW="130px">{b.name || "Unnamed"}</Text>
						<Text fontSize="10px" color={b.cosigner ? "var(--gold)" : "var(--text-2)"} whiteSpace="nowrap">{b.cosigner ? "Co-signer" : b.source}</Text>
						<Text fontFamily="mono" color="var(--text-0)" wordBreak="break-all">{b.address}</Text>
					</Flex>
					{chosen.some(o => same(o, b.address)) && twinWarning(b.address)}
				</Box>
			))}
			{book.some(b => !b.cosigner) && (
				<Text as="button" fontSize="11px" color="var(--text-2)" onClick={() => setShowOthers(v => !v)}>
					{showOthers ? "Hide other saved addresses" : `Show other saved addresses (${book.filter(b => !b.cosigner).length})`}
				</Text>
			)}
			{others.filter(o => !book.some(b => same(b.address, o))).map(o => (
				<Box key={o}>
					<Flex gap="2" align="center" fontSize="12px" py="0.5">
						<Text as="button" color="var(--text-2)" onClick={() => toggle(o)}>✕</Text>
						<Text color="var(--text-1)" minW="130px">Another key</Text>
						<Text fontFamily="mono" color="var(--text-0)" wordBreak="break-all">{o}</Text>
					</Flex>
					{twinWarning(o)}
				</Box>
			))}
			<Flex gap="2" mt="2">
				<Input size="sm" fontFamily="mono" fontSize="12px" placeholder="Add another owner: 0x…" value={pasted} onChange={e => setPasted(e.target.value)} />
				{saveCosigner && !isHiddenWallet && (
					<Input size="sm" fontSize="12px" maxW="140px" maxLength={24} placeholder="Name (optional)" value={pastedName} onChange={e => setPastedName(e.target.value)} />
				)}
				<Text as="button" fontSize="12px" color="var(--gold)" whiteSpace="nowrap" onClick={addPasted}>Add</Text>
			</Flex>
			{isHiddenWallet
				? <Text fontSize="11px" color="var(--text-2)" mt="1">A passphrase wallet is open, so pasted owners are not saved to the address book.</Text>
				: (
					<Flex as="label" gap="2" align="center" fontSize="11px" color="var(--text-2)" mt="1" cursor="pointer">
						<input type="checkbox" checked={saveCosigner} onChange={e => setSaveCosigner(e.target.checked)} />
						Save to the address book as a co-signer
					</Flex>
				)}
			<Text fontSize="11px" color="var(--text-2)" mt="1">
				Check every owner that is not this KeepKey on that wallet's own screen. A saved name is only what you typed; Desktop cannot tell who controls an address.
			</Text>

			<Text fontSize="12px" fontWeight="600" color="var(--text-1)" mt="3" mb="1">Signatures needed to move funds</Text>
			<Flex gap="2" wrap="wrap">
				{chosen.map((_, i) => (
					<Text key={i} as="button" fontSize="12px" px="2.5" py="1" borderRadius="md" border="1px solid"
						borderColor={t === i + 1 ? "var(--gold)" : "var(--line)"} color={t === i + 1 ? "var(--gold)" : "var(--text-1)"}
						onClick={() => { setThreshold(i + 1); setReview(null) }}>{i + 1} of {chosen.length}</Text>
				))}
			</Flex>
			{chosen.length > 1 && t === 1 && <Text fontSize="11px" color="#f5c542" mt="1">With 1 signature, any single owner can move everything.</Text>}
			{others.length === chosen.length
				? <Text fontSize="11px" color="#F56565" mt="1">This KeepKey is not an owner of this Safe.</Text>
				: keepkeyOptional && <Text fontSize="11px" color="#F56565" mt="1">{others.length} owner{others.length > 1 ? "s" : ""} that {others.length > 1 ? "are" : "is"} not this KeepKey can move funds without it. If they share one computer or service, that one place can empty the Safe.</Text>}

			{!review && (
				<Flex gap="4" mt="4" align="center">
					<Text as="button" fontSize="13px" fontWeight="600" color="var(--gold)" onClick={plan}>Review</Text>
					<Text as="button" fontSize="13px" color="var(--text-2)" onClick={onClose}>Cancel</Text>
					{busy === "planning" && <Spinner size="sm" color="kk.gold" />}
				</Flex>
			)}

			{review && (
				<Box mt="4" p="3" borderRadius="md" border="1px solid" borderColor="var(--line)">
					<Text fontSize="12px" color="var(--text-1)" mb="2">
						Checked on {chainName} just now: Safe's factory matches Safe's published build, and a dry run lands the Safe at the address below.
					</Text>
					<Row k="Safe address" v={review.plan.predicted} />
					{review.plan.owners.map((o, i) => (
					<Box key={o}>
						<Row k={i === 0 ? "Owners" : ""} v={`${o}  (${label(o)})${review.ownerCode[o] === "contract" ? `  · contract on ${chainName}` : ""}`} />
						{twinWarning(o)}
					</Box>
				))}
				{review.plan.owners.some(o => review.ownerCode[o] === "contract") && (
					<Text fontSize="11px" color="#f5c542" mt="1">A contract owner signs through its own code. Desktop can only co-sign with regular wallet owners today.</Text>
				)}
				{keepkeyOptional && <Text fontSize="11px" color="#F56565" mt="1">Owners other than this KeepKey can reach {review.plan.threshold} of {review.plan.owners.length} without it.</Text>}
					<Row k="Signatures needed" v={`${review.plan.threshold} of ${review.plan.owners.length}`} />
					<Row k="Safe version" v="1.4.1 (SafeL2)" />
					<Row k="Factory (KeepKey shows)" v={review.plan.factory} />
					<Row k="Data hash" v={review.calldataHash} />
					<Row k="Paid from" v={`${review.payer} (selected account)`} />
					<Row k="Network fee, at most" v={`${eth(review.fee)} ${symbol}`} />
					<Text fontSize="12px" color="var(--text-2)" mt="2">
						Your KeepKey (firmware 7.16) cannot read this transaction, so it never shows the owners or threshold. Desktop turns
						Advanced Mode on for this one signature and off again right after, and checks the new Safe on {chainName} before
						showing it as ready.
					</Text>
					{review.payerOwnsSafe && <Text fontSize="12px" color="#F56565" mt="2">The selected account already owns a Safe on {chainName}. Select an account that owns none to pay for this one.</Text>}
					{!review.payerOwnsSafe && BigInt(review.balance) < BigInt(review.fee) && (
						<Text fontSize="12px" color="#F56565" mt="2">{review.payer} has {eth(review.balance)} {symbol}; it needs {eth(review.fee)} {symbol} for the fee.</Text>
					)}
					<Flex gap="4" mt="3">
						{!cannotPay && <Text as="button" fontSize="13px" fontWeight="600" color="var(--gold)" onClick={create}>Create on KeepKey</Text>}
						<Text as="button" fontSize="13px" color="var(--text-2)" onClick={() => setReview(null)}>Back</Text>
					</Flex>
				</Box>
			)}
			{error && <Text fontSize="12px" color="#F56565" mt="2">{error}</Text>}
			{busy === "creating" && <Creating />}
		</Box>
	)
}
