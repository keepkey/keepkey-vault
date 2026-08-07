import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Button, Flex, Input, Text, Textarea, VStack } from "@chakra-ui/react"

import type {
	ClearSignEvent,
	ClearSignSolanaArgType,
	ClearSignSolanaSchemaArtifact,
	ClearSignSolanaSchemaDraft,
} from "../../shared/types"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"

const RELAY_DRAFT: ClearSignSolanaSchemaDraft = {
	programId: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
	discriminator: "0d9e0ddf5fd51c06",
	programName: "Relay Bridge",
	instructionName: "depositNative",
	args: [
		{ type: "u64", label: "Amount" },
		{ type: "opaque32", label: "Order" },
	],
	accounts: [{ index: 3, label: "Vault" }],
}

const RELAY_SCHEMA_FIXTURE = [
	"4b4b534f4c53433101792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf",
	"080d9e0ddf5fd51c060c52656c6179204272696467650d6465706f7369744e6174697665020106416d",
	"6f756e7404054f726465720103055661756c74",
].join("")

const ARG_TYPES: Array<{ value: ClearSignSolanaArgType; label: string; width: string }> = [
	{ value: "u64", label: "u64 LE", width: "8B" },
	{ value: "u8", label: "u8", width: "1B" },
	{ value: "pubkey", label: "Public key", width: "32B" },
	{ value: "opaque32", label: "Opaque 32", width: "32B" },
]

type StudioTab = "author" | "signer" | "evidence"
type BusyAction = "identity" | "build" | "inspect" | "attest" | "load" | "history" | ""

type Attestation = {
	payload: string
	signature: string
	publicKey: string
	fingerprint: string
	eventId: string
}

interface ClearSignStudioProps {
	open: boolean
	onClose: () => void
	advancedMode: boolean
	firmwareVersion?: string
}

function shortHex(value: string, edge = 14): string {
	return value.length > edge * 2 ? `${value.slice(0, edge)}…${value.slice(-edge)}` : value
}

function eventTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString()
}

function hexToBase64(hex: string): string {
	const normalized = hex.replace(/^0x/i, "")
	let binary = ""
	for (let i = 0; i < normalized.length; i += 2) binary += String.fromCharCode(parseInt(normalized.slice(i, i + 2), 16))
	return btoa(binary)
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		try {
			const area = document.createElement("textarea")
			area.value = text
			area.style.position = "fixed"
			area.style.opacity = "0"
			document.body.appendChild(area)
			area.select()
			const copied = document.execCommand("copy")
			document.body.removeChild(area)
			return copied
		} catch {
			return false
		}
	}
}

function ResultRow({ label, value }: { label: string; value?: string }) {
	return (
		<Flex direction={{ base: "column", md: "row" }} gap="1" justify="space-between">
			<Text fontSize="11px" color="var(--text-2)" flexShrink={0}>{label}</Text>
			<Text fontSize="11px" color="var(--text-0)" fontFamily="mono" wordBreak="break-all" textAlign={{ base: "left", md: "right" }}>
				{value || "—"}
			</Text>
		</Flex>
	)
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
	return (
		<Flex justify="space-between" align="center" mb="1">
			<Text fontSize="10px" fontWeight="700" color="var(--text-1)">{children}</Text>
			{hint && <Text fontSize="9px" color="var(--text-2)">{hint}</Text>}
		</Flex>
	)
}

export function ClearSignStudio({ open, onClose, advancedMode, firmwareVersion }: ClearSignStudioProps) {
	const [tab, setTab] = useState<StudioTab>("author")
	const [draft, setDraft] = useState<ClearSignSolanaSchemaDraft>(RELAY_DRAFT)
	const [payload, setPayload] = useState(RELAY_SCHEMA_FIXTURE)
	const [artifact, setArtifact] = useState<ClearSignSolanaSchemaArtifact | null>(null)
	const [alias, setAlias] = useState("Studio Signer")
	const [slot, setSlot] = useState(1)
	const [publicKeyInput, setPublicKeyInput] = useState("")
	const [identity, setIdentity] = useState<{ publicKey: string; fingerprint: string } | null>(null)
	const [attestation, setAttestation] = useState<Attestation | null>(null)
	const [loaded, setLoaded] = useState(false)
	const [history, setHistory] = useState<ClearSignEvent[]>([])
	const [historyFilter, setHistoryFilter] = useState<"all" | "signed" | "blocked">("all")
	const [expandedEvent, setExpandedEvent] = useState<string | null>(null)
	const [busy, setBusy] = useState<BusyAction>("")
	const [error, setError] = useState("")
	const [notice, setNotice] = useState("")
	const [copied, setCopied] = useState("")

	const setDraftField = useCallback(<K extends keyof ClearSignSolanaSchemaDraft>(field: K, value: ClearSignSolanaSchemaDraft[K]) => {
		setDraft(current => ({ ...current, [field]: value }))
		setArtifact(null)
	}, [])

	const refreshHistory = useCallback(async (showBusy = false) => {
		if (!advancedMode) return
		if (showBusy) setBusy("history")
		try {
			const events = await rpcRequest<ClearSignEvent[]>("clearsignListEvents", { limit: 500, scope: "current-device" })
			setHistory(events)
		} catch (cause: any) {
			if (showBusy) setError(cause?.message || String(cause))
		} finally {
			if (showBusy) setBusy("")
		}
	}, [advancedMode])

	useEffect(() => {
		if (!open) return
		setError("")
		setNotice("")
		setLoaded(false)
		void refreshHistory()
	}, [open, refreshHistory])

	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose() }
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [open, busy, onClose])

	const buildPayload = useCallback(async () => {
		setBusy("build")
		setError("")
		setNotice("")
		try {
			const result = await rpcRequest<ClearSignSolanaSchemaArtifact>("clearsignBuildSolanaSchema", draft)
			setArtifact(result)
			setDraft(result.draft)
			setPayload(result.payload)
			setAttestation(null)
			setNotice(`Canonical ${result.format} payload built: ${result.byteLength} bytes.`)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [draft])

	const inspectPayload = useCallback(async () => {
		setBusy("inspect")
		setError("")
		setNotice("")
		try {
			const result = await rpcRequest<ClearSignSolanaSchemaArtifact>("clearsignInspectSolanaSchema", { payload })
			setArtifact(result)
			setDraft(result.draft)
			setPayload(result.payload)
			setNotice(`Payload is canonical and covers ${result.coverageBytes} instruction-data bytes.`)
		} catch (cause: any) {
			setArtifact(null)
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [payload])

	const getIdentity = useCallback(async () => {
		setBusy("identity")
		setError("")
		setNotice("")
		try {
			const result = await rpcRequest<{ publicKey: string; fingerprint: string }>("clearsignAttestorGetPublicKey", undefined, 120000)
			setIdentity(result)
			setPublicKeyInput(result.publicKey)
			setNotice(`Read attestor identity ${result.fingerprint} from the connected device.`)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [])

	const attest = useCallback(async () => {
		setBusy("attest")
		setError("")
		setNotice("")
		setLoaded(false)
		try {
			const result = await rpcRequest<Attestation>("clearsignAttestorSign", { payload }, 0)
			setAttestation(result)
			setIdentity({ publicKey: result.publicKey, fingerprint: result.fingerprint })
			setPublicKeyInput(result.publicKey)
			setNotice(`Device attested ${result.payload.length / 2} bytes as ${result.fingerprint}.`)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
			void refreshHistory()
		}
	}, [payload, refreshHistory])

	const loadSigner = useCallback(async () => {
		setBusy("load")
		setError("")
		setNotice("")
		try {
			const result = await rpcRequest<{ ok: true; keyId: number; alias: string; fingerprint: string; eventId: string }>(
				"clearsignLoadSessionSigner",
				{ keyId: slot, publicKey: publicKeyInput, alias },
				0,
			)
			setLoaded(true)
			setIdentity({ publicKey: publicKeyInput.replace(/^0x/i, "").replace(/\s+/g, ""), fingerprint: result.fingerprint })
			setNotice(`${result.alias} loaded into RAM slot ${result.keyId}. It clears on reboot or session clear.`)
		} catch (cause: any) {
			setLoaded(false)
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
			void refreshHistory()
		}
	}, [alias, publicKeyInput, refreshHistory, slot])

	const copy = useCallback(async (name: string, value: string) => {
		if (await copyText(value)) {
			setCopied(name)
			setTimeout(() => setCopied(""), 1600)
		}
	}, [])

	const signedBundle = useMemo(() => attestation ? JSON.stringify({
		format: "KKSOLSC1",
		program: artifact?.draft.programId,
		instruction: artifact?.draft.instructionName,
		publicKey: attestation.publicKey,
		fingerprint: attestation.fingerprint,
		schema: {
			payload: hexToBase64(attestation.payload),
			signature: hexToBase64(attestation.signature),
			signerKeyId: slot,
		},
	}, null, 2) : "", [artifact, attestation, slot])

	const filteredHistory = useMemo(() => history.filter(entry => {
		if (historyFilter === "blocked") return entry.outcome === "blocked"
		if (historyFilter === "signed") return entry.outcome === "signed"
		return true
	}), [history, historyFilter])

	if (!open) return null

	return (
		<Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" p="4" role="dialog" aria-modal="true" aria-label="ClearSign Studio">
			<Box position="absolute" inset="0" bg="rgba(3,7,18,0.82)" backdropFilter="blur(6px)" onClick={() => !busy && onClose()} />
			<Flex position="relative" direction="column" w="1120px" maxW="97vw" maxH="91vh" bg="var(--ink-1)" border="1px solid rgba(233,196,106,0.30)" borderRadius="20px" boxShadow="0 28px 90px rgba(0,0,0,0.60)" overflow="hidden">
				<Flex px={{ base: "4", md: "6" }} py="4" align="center" justify="space-between" borderBottom="1px solid var(--line)" gap="4">
					<Box>
						<Flex align="center" gap="2" mb="1" wrap="wrap">
							<Text fontSize="lg" fontWeight="700" color="var(--text-0)">ClearSign Studio</Text>
							<Text fontSize="10px" fontWeight="700" letterSpacing="0.08em" color="var(--gold)" bg="rgba(233,196,106,0.10)" border="1px solid rgba(233,196,106,0.25)" borderRadius="full" px="2" py="0.5">ADVANCED · TESTING GROUND</Text>
						</Flex>
						<Text fontSize="12px" color="var(--text-2)">Author canonical descriptors, attest and load identities, and retain signed or blocked evidence locally.</Text>
					</Box>
					<Button variant="ghost" size="sm" color="var(--text-2)" onClick={onClose} disabled={!!busy}>Close</Button>
				</Flex>

				<Flex px={{ base: "4", md: "6" }} py="2.5" gap="2" borderBottom="1px solid var(--line)" bg="rgba(0,0,0,0.10)" overflowX="auto">
					{(["author", "signer", "evidence"] as StudioTab[]).map(value => (
						<Button key={value} size="sm" variant={tab === value ? "solid" : "ghost"} bg={tab === value ? "var(--gold)" : undefined} color={tab === value ? "#15110a" : "var(--text-1)"} onClick={() => setTab(value)}>
							{value === "author" ? "Author & attest" : value === "signer" ? "Load identity" : `Evidence (${history.length})`}
						</Button>
					))}
				</Flex>

				<Box overflowY="auto" px={{ base: "4", md: "6" }} py="5">
					<VStack align="stretch" gap="4">
						<Flex gap="3" direction={{ base: "column", md: "row" }}>
							{[
								["RAM-only trust", "Studio loads never request flash persistence."],
								["Additive review", "Metadata augments; raw Advanced review remains."],
								["Local evidence", "Descriptors and outcomes stay in this Vault database."],
							].map(([title, body]) => (
								<Box key={title} flex="1" px="3" py="2.5" borderRadius="12px" bg="rgba(139,227,196,0.05)" border="1px solid rgba(139,227,196,0.16)">
									<Text fontSize="11px" fontWeight="700" color="var(--teal)">{title}</Text>
									<Text fontSize="11px" color="var(--text-2)" mt="0.5">{body}</Text>
								</Box>
							))}
						</Flex>

						{tab === "author" && (
							<Flex gap="4" direction={{ base: "column", lg: "row" }} align="stretch">
								<VStack flex="1.2" align="stretch" gap="4">
									<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
										<Flex justify="space-between" align="start" gap="3" mb="3">
											<Box>
												<Text fontSize="12px" fontWeight="700" color="var(--text-0)">1 · Author a Solana instruction schema</Text>
												<Text fontSize="11px" color="var(--text-2)" mt="1">One schema describes one program + discriminator. Firmware requires exact byte coverage.</Text>
											</Box>
											<Button size="xs" variant="ghost" color="var(--gold)" onClick={() => { setDraft(RELAY_DRAFT); setPayload(RELAY_SCHEMA_FIXTURE); setArtifact(null) }}>Relay fixture</Button>
										</Flex>
										<VStack align="stretch" gap="3">
											<Box><FieldLabel hint="base58 or 32-byte hex">Program ID</FieldLabel><Input value={draft.programId} onChange={event => setDraftField("programId", event.target.value)} size="sm" fontFamily="mono" bg="rgba(0,0,0,0.18)" /></Box>
											<Flex gap="3" direction={{ base: "column", md: "row" }}>
												<Box flex="1"><FieldLabel hint="1–8 bytes hex">Discriminator</FieldLabel><Input value={draft.discriminator} onChange={event => setDraftField("discriminator", event.target.value)} size="sm" fontFamily="mono" bg="rgba(0,0,0,0.18)" /></Box>
												<Box flex="1"><FieldLabel hint="max 20 ASCII">Program label</FieldLabel><Input value={draft.programName} onChange={event => setDraftField("programName", event.target.value)} maxLength={20} size="sm" bg="rgba(0,0,0,0.18)" /></Box>
												<Box flex="1"><FieldLabel hint="max 20 ASCII">Instruction label</FieldLabel><Input value={draft.instructionName} onChange={event => setDraftField("instructionName", event.target.value)} maxLength={20} size="sm" bg="rgba(0,0,0,0.18)" /></Box>
											</Flex>

											<Box>
												<Flex justify="space-between" align="center" mb="1"><FieldLabel hint="max 4">Arguments</FieldLabel><Button size="xs" variant="ghost" color="var(--gold)" disabled={draft.args.length >= 4} onClick={() => setDraftField("args", [...draft.args, { type: "u64", label: "Value" }])}>+ Add</Button></Flex>
												<VStack align="stretch" gap="2">
													{draft.args.length === 0 && <Text fontSize="10px" color="var(--text-2)">No arguments. The discriminator must then cover the entire instruction data.</Text>}
													{draft.args.map((arg, index) => (
														<Flex key={index} gap="2">
															<select value={arg.type} onChange={event => setDraftField("args", draft.args.map((item, i) => i === index ? { ...item, type: event.target.value as ClearSignSolanaArgType } : item))} style={{ height: 32, minWidth: 130, padding: "0 8px", fontSize: 11, color: "var(--text-0)", background: "var(--ink-1)", border: "1px solid var(--line)", borderRadius: 6 }}>
																{ARG_TYPES.map(type => <option key={type.value} value={type.value}>{type.label} · {type.width}</option>)}
															</select>
															<Input value={arg.label} onChange={event => setDraftField("args", draft.args.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} maxLength={16} size="sm" placeholder="Display label" bg="rgba(0,0,0,0.18)" />
															<Button size="xs" mt="0.5" variant="ghost" color="var(--rose)" onClick={() => setDraftField("args", draft.args.filter((_, i) => i !== index))}>Remove</Button>
														</Flex>
													))}
												</VStack>
											</Box>

											<Box>
												<Flex justify="space-between" align="center" mb="1"><FieldLabel hint="max 4">Displayed accounts</FieldLabel><Button size="xs" variant="ghost" color="var(--gold)" disabled={draft.accounts.length >= 4} onClick={() => setDraftField("accounts", [...draft.accounts, { index: 0, label: "Account" }])}>+ Add</Button></Flex>
												<VStack align="stretch" gap="2">
													{draft.accounts.length === 0 && <Text fontSize="10px" color="var(--text-2)">No accounts selected for labelled display.</Text>}
													{draft.accounts.map((account, index) => (
														<Flex key={index} gap="2">
															<Input type="number" min={0} max={255} value={account.index} onChange={event => setDraftField("accounts", draft.accounts.map((item, i) => i === index ? { ...item, index: Number(event.target.value) } : item))} size="sm" w="90px" bg="rgba(0,0,0,0.18)" />
															<Input value={account.label} onChange={event => setDraftField("accounts", draft.accounts.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} maxLength={16} size="sm" placeholder="Display label" bg="rgba(0,0,0,0.18)" />
															<Button size="xs" mt="0.5" variant="ghost" color="var(--rose)" onClick={() => setDraftField("accounts", draft.accounts.filter((_, i) => i !== index))}>Remove</Button>
														</Flex>
													))}
												</VStack>
											</Box>
											<Flex justify="flex-end"><Button size="sm" bg="var(--gold)" color="#15110a" onClick={buildPayload} loading={busy === "build"} disabled={!!busy}>Build canonical payload</Button></Flex>
										</VStack>
									</Box>
								</VStack>

								<VStack flex="0.85" align="stretch" gap="4">
									<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
										<Flex justify="space-between" align="start" gap="3" mb="2">
											<Box><Text fontSize="12px" fontWeight="700" color="var(--text-0)">2 · Review canonical bytes</Text><Text fontSize="10px" color="var(--text-2)" mt="1">Raw hex is always visible and remains editable for negative tests.</Text></Box>
											<Button size="xs" variant="outline" borderColor="var(--line)" onClick={inspectPayload} loading={busy === "inspect"} disabled={!!busy}>Inspect</Button>
										</Flex>
										<Textarea value={payload} onChange={event => { setPayload(event.target.value); setArtifact(null); setAttestation(null) }} rows={8} resize="vertical" fontFamily="mono" fontSize="10px" color="var(--text-0)" bg="rgba(0,0,0,0.18)" borderColor="var(--line)" spellCheck={false} />
										<Flex justify="space-between" mt="2"><Text fontSize="10px" color="var(--text-2)">{Math.ceil(payload.replace(/^0x/i, "").replace(/\s/g, "").length / 2)} bytes</Text><Text fontSize="10px" color={artifact ? "var(--teal)" : "var(--text-2)"}>{artifact ? `${artifact.coverageBytes}B exact instruction coverage` : "Not inspected"}</Text></Flex>
									</Box>

									<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
										<Text fontSize="12px" fontWeight="700" color="var(--text-0)">3 · Attest on device</Text>
										<Text fontSize="11px" color="var(--text-2)" mt="1">The device independently validates KKSOLSC1 and asks for physical confirmation.</Text>
										<Button mt="3" w="full" size="sm" bg="var(--gold)" color="#15110a" onClick={attest} loading={busy === "attest"} disabled={!!busy || !advancedMode || !payload.trim()}>Author / sign payload</Button>
										<Box mt="3" p="3" bg="rgba(255,255,255,0.025)" borderRadius="10px"><VStack align="stretch" gap="2"><ResultRow label="Signer" value={attestation?.fingerprint} /><ResultRow label="Signature" value={attestation ? shortHex(attestation.signature) : undefined} /><ResultRow label="Evidence ID" value={attestation?.eventId} /></VStack></Box>
										{attestation && <Flex gap="2" mt="3"><Button flex="1" size="xs" variant="outline" borderColor="var(--line)" onClick={() => copy("bundle", signedBundle)}>{copied === "bundle" ? "Copied" : "Copy signed bundle"}</Button><Button flex="1" size="xs" variant="ghost" color="var(--gold)" onClick={() => setTab("signer")}>Load this identity →</Button></Flex>}
									</Box>
								</VStack>
							</Flex>
						)}

						{tab === "signer" && (
							<Flex gap="4" direction={{ base: "column", lg: "row" }}>
								<Box flex="1" p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Text fontSize="12px" fontWeight="700" color="var(--text-0)">Identity source</Text>
									<Text fontSize="11px" color="var(--text-2)" mt="1">Read the connected signed device, or paste a compressed public key authored elsewhere.</Text>
									<Button mt="3" size="sm" variant="outline" borderColor="var(--line)" onClick={getIdentity} loading={busy === "identity"} disabled={!!busy || !advancedMode}>Read this device’s attestor key</Button>
									<Box mt="3"><FieldLabel hint="33-byte compressed secp256k1 hex">Public key to trust</FieldLabel><Textarea value={publicKeyInput} onChange={event => { setPublicKeyInput(event.target.value); setLoaded(false) }} rows={4} fontFamily="mono" fontSize="11px" bg="rgba(0,0,0,0.18)" spellCheck={false} /></Box>
									<Box mt="3" p="3" bg="rgba(255,255,255,0.025)" borderRadius="10px"><ResultRow label="Known fingerprint" value={identity?.publicKey === publicKeyInput.replace(/^0x/i, "").replace(/\s+/g, "") ? identity.fingerprint : undefined} /></Box>
								</Box>

								<Box flex="1" p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Text fontSize="12px" fontWeight="700" color="var(--text-0)">Load session signer</Text>
									<Text fontSize="11px" color="var(--text-2)" mt="1">The connected verifier shows a mandatory Trust signer prompt. Studio does not request persistence.</Text>
									<Box mt="3"><FieldLabel hint="shown on device">Alias</FieldLabel><Input value={alias} onChange={event => { setAlias(event.target.value); setLoaded(false) }} maxLength={31} size="sm" bg="rgba(0,0,0,0.18)" /></Box>
									<Flex gap="1" align="center" mt="3"><Text fontSize="10px" color="var(--text-2)" mr="2">RAM slot</Text>{[0, 1, 2, 3].map(value => <Button key={value} size="xs" minW="34px" variant={slot === value ? "solid" : "outline"} bg={slot === value ? "var(--gold)" : undefined} color={slot === value ? "#15110a" : "var(--text-1)"} onClick={() => { setSlot(value); setLoaded(false) }}>{value}</Button>)}</Flex>
									<Button mt="4" w="full" size="sm" bg={loaded ? "var(--teal)" : "var(--gold)"} color="#15110a" onClick={loadSigner} loading={busy === "load"} disabled={!!busy || !publicKeyInput.trim() || !alias.trim() || !advancedMode}>{loaded ? "Loaded in RAM" : "Load signer on device"}</Button>
									<Text fontSize="10px" color="var(--text-2)" mt="3">To test two devices: read/attest on the author device, copy the key or bundle, connect the verifier, then load it here.</Text>
								</Box>
							</Flex>
						)}

						{tab === "evidence" && (
							<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
								<Flex justify="space-between" align={{ base: "start", md: "center" }} direction={{ base: "column", md: "row" }} gap="3" mb="4">
									<Box><Text fontSize="12px" fontWeight="700" color="var(--text-0)">Device ClearSign evidence</Text><Text fontSize="10px" color="var(--text-2)" mt="1">Current device · newest first · local Vault database · full descriptor retained</Text></Box>
									<Flex gap="2">{(["all", "signed", "blocked"] as const).map(value => <Button key={value} size="xs" variant={historyFilter === value ? "solid" : "outline"} bg={historyFilter === value ? "var(--gold)" : undefined} color={historyFilter === value ? "#15110a" : "var(--text-1)"} onClick={() => setHistoryFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</Button>)}<Button size="xs" variant="ghost" onClick={() => refreshHistory(true)} loading={busy === "history"}>Refresh</Button></Flex>
								</Flex>
								<VStack align="stretch" gap="2">
									{filteredHistory.length === 0 && <Box py="8" textAlign="center"><Text fontSize="12px" color="var(--text-2)">No {historyFilter === "all" ? "ClearSign" : historyFilter} evidence for this device yet.</Text></Box>}
									{filteredHistory.map(entry => {
										const openEntry = expandedEvent === entry.id
										const ok = entry.outcome !== "blocked"
										return (
											<Box key={entry.id} px="3" py="3" borderRadius="10px" bg="rgba(255,255,255,0.022)" border="1px solid" borderColor={ok ? "rgba(139,227,196,0.18)" : "rgba(224,140,123,0.28)"}>
												<Flex justify="space-between" align="start" gap="3" cursor="pointer" onClick={() => setExpandedEvent(openEntry ? null : entry.id)}>
													<Box minW="0"><Flex gap="2" align="center" wrap="wrap"><Text fontSize="10px" fontWeight="800" color={ok ? "var(--teal)" : "var(--rose)"}>{entry.outcome.toUpperCase()}</Text><Text fontSize="11px" color="var(--text-0)" fontWeight="600">{entry.label || entry.kind}</Text><Text fontSize="9px" color="var(--text-2)">{entry.source}</Text></Flex><Text fontSize="10px" color="var(--text-2)" mt="1">{eventTime(entry.createdAt)} · {entry.sentToDevice ? "reached device" : "blocked before transport"} · {entry.format || entry.kind}</Text></Box>
													<Text fontSize="12px" color="var(--text-2)">{openEntry ? "−" : "+"}</Text>
												</Flex>
												{openEntry && <VStack align="stretch" gap="2" mt="3" pt="3" borderTop="1px solid var(--line)"><ResultRow label="Evidence ID" value={entry.id} /><ResultRow label="Firmware" value={entry.firmwareVersion} /><ResultRow label="Signer / key slot" value={[entry.fingerprint, entry.keyId != null ? `slot ${entry.keyId}` : ""].filter(Boolean).join(" · ") || undefined} />{entry.error && <Box px="2.5" py="2" borderRadius="8px" bg="rgba(224,140,123,0.08)"><Text fontSize="10px" color="var(--rose)">{entry.error}</Text></Box>}{entry.payload && <Box><Flex justify="space-between" align="center" mb="1"><Text fontSize="10px" color="var(--text-2)">Payload</Text><Button size="xs" variant="ghost" color="var(--gold)" onClick={() => copy(entry.id, entry.payload!)}>{copied === entry.id ? "Copied" : "Copy"}</Button></Flex><Text p="2" maxH="130px" overflowY="auto" fontSize="9px" fontFamily="mono" wordBreak="break-all" bg="rgba(0,0,0,0.18)" borderRadius="7px" color="var(--text-1)">{entry.payload}</Text></Box>}{entry.signature && <ResultRow label="Signature" value={entry.signature} />}{entry.publicKey && <ResultRow label="Public key" value={entry.publicKey} />}{entry.request && <Box><Text fontSize="10px" color="var(--text-2)" mb="1">Review metadata</Text><Text as="pre" whiteSpace="pre-wrap" p="2" fontSize="9px" fontFamily="mono" bg="rgba(0,0,0,0.18)" borderRadius="7px" color="var(--text-1)">{JSON.stringify(entry.request, null, 2)}</Text></Box>}</VStack>}
											</Box>
										)
									})}
								</VStack>
							</Box>
						)}

						{notice && <Box px="3" py="2.5" borderRadius="10px" bg="rgba(139,227,196,0.08)" border="1px solid rgba(139,227,196,0.22)"><Text fontSize="11px" color="var(--teal)">{notice}</Text></Box>}
						{error && <Box px="3" py="2.5" borderRadius="10px" bg="rgba(224,140,123,0.10)" border="1px solid rgba(224,140,123,0.28)"><Text fontSize="11px" color="var(--rose)">{error}</Text></Box>}
						{!advancedMode && <Box px="3" py="2.5" borderRadius="10px" bg="rgba(245,163,59,0.10)" border="1px solid rgba(245,163,59,0.28)"><Text fontSize="11px" color="#F5A33B">AdvancedMode was disabled. Close the Studio and re-enable it before continuing.</Text></Box>}
						<Text fontSize="9px" color="var(--text-2)" textAlign="right">Connected firmware {firmwareVersion || "unknown"} · hidden/passphrase wallets never persist Studio evidence</Text>
					</VStack>
				</Box>
			</Flex>
		</Box>
	)
}
