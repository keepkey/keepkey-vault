import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Button, Flex, Input, Text, Textarea, VStack } from "@chakra-ui/react"

import type {
	ClearSignEvent,
	ClearSignCoverageSummary,
	ClearSignAuditJob,
	ClearSignCentralAssetAuditHistory,
	ClearSignCentralAssetReview,
	ClearSignCentralAssetReviewResult,
	ClearSignCentralContractAudit,
	ClearSignCentralContractReview,
	ClearSignCentralStatus,
	ClearSignProtectionCaseStudy,
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
	{ value: "lamports", label: "Lamports", width: "8B" },
]

type StudioTab = "author" | "provider" | "signer" | "evidence"
type BusyAction = "identity" | "build" | "inspect" | "attest" | "load" | "history" | "asset-history" | "reviewer-identity" | "asset-review-build" | "asset-review-sign" | "asset-review" | "contract-audit" | "contract-review-build" | "contract-review-sign" | "contract-review" | "bip85" | "derive" | ""

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
	const [coverage, setCoverage] = useState<ClearSignCoverageSummary | null>(null)
	const [auditJobs, setAuditJobs] = useState<ClearSignAuditJob[]>([])
	const [centralStatus, setCentralStatus] = useState<ClearSignCentralStatus | null>(null)
	const [assetHistory, setAssetHistory] = useState<ClearSignCentralAssetAuditHistory[]>([])
	const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
	const [assetReviewJson, setAssetReviewJson] = useState("")
	const [reviewerPublicKey, setReviewerPublicKey] = useState("")
	const [reviewerFingerprint, setReviewerFingerprint] = useState("")
	const [reviewRole, setReviewRole] = useState<ClearSignCentralAssetReview['role']>("semantics-review")
	const [reviewDecision, setReviewDecision] = useState<ClearSignCentralAssetReview['decision']>("approve")
	const [reviewDigest, setReviewDigest] = useState("")
	const [contractAudit, setContractAudit] = useState<ClearSignCentralContractAudit | null>(null)
	const [contractReviewJson, setContractReviewJson] = useState("")
	const [contractReviewDigest, setContractReviewDigest] = useState("")
	const [caseStudies, setCaseStudies] = useState<ClearSignProtectionCaseStudy[]>([])
	const [historyFilter, setHistoryFilter] = useState<"all" | "signed" | "blocked">("all")
	const [expandedEvent, setExpandedEvent] = useState<string | null>(null)
	const [wordCount, setWordCount] = useState<12 | 18 | 24>(12)
	const [bip85Index, setBip85Index] = useState(0)
	const [childMnemonic, setChildMnemonic] = useState("")
	const [providerKey, setProviderKey] = useState<{ publicKeyHex: string; fingerprint: string; filePath: string } | null>(null)

	const loadConfiguredReviewer = useCallback(async () => {
		setBusy("reviewer-identity")
		setError("")
		try {
			const identity = await rpcRequest<{ role: ClearSignCentralAssetReview['role']; publicKey: string; fingerprint: string }>(
				"clearsignGetConfiguredReviewerIdentity", { role: reviewRole },
			)
			setReviewerPublicKey(identity.publicKey)
			setReviewerFingerprint(identity.fingerprint)
			setNotice(`Loaded configured ${identity.role} reviewer ${identity.fingerprint}.`)
		} catch (cause: any) {
			setReviewerPublicKey("")
			setReviewerFingerprint("")
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [reviewRole])
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
			const [events, nextCoverage, jobs, studies, central] = await Promise.all([
				rpcRequest<ClearSignEvent[]>("clearsignListEvents", { limit: 500, scope: "current-device" }),
				rpcRequest<ClearSignCoverageSummary>("clearsignGetCoverage"),
				rpcRequest<ClearSignAuditJob[]>("clearsignListAuditJobs", { limit: 20 }),
				rpcRequest<ClearSignProtectionCaseStudy[]>("clearsignGetProtectionCaseStudies"),
				rpcRequest<ClearSignCentralStatus>("clearsignGetCentralStatus"),
			])
			setHistory(events)
			setCoverage(nextCoverage)
			setAuditJobs(jobs)
			setCaseStudies(studies)
			setCentralStatus(central)
		} catch (cause: any) {
			if (showBusy) setError(cause?.message || String(cause))
		} finally {
			if (showBusy) setBusy("")
		}
	}, [advancedMode])

	const inspectAssetEvidence = useCallback(async (caip: string) => {
		setBusy("asset-history")
		setError("")
		try {
			const audits = await rpcRequest<ClearSignCentralAssetAuditHistory[]>("clearsignGetCentralAssetHistory", { caip })
			setSelectedAsset(caip)
			setAssetHistory(audits)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [])

	const submitAssetReview = useCallback(async () => {
		setBusy("asset-review")
		setError("")
		setNotice("")
		try {
			const review = JSON.parse(assetReviewJson) as ClearSignCentralAssetReview
			if (!selectedAsset || review.caip !== selectedAsset) throw new Error("Signed review asset does not match the selected candidate")
			const currentHash = assetHistory[0]?.evidenceHash
			if (!currentHash || review.evidenceHash !== currentHash) throw new Error("Signed review does not bind the current evidence hash")
			const result = await rpcRequest<ClearSignCentralAssetReviewResult>("clearsignSubmitCentralAssetReview", review)
			setNotice(`Review accepted: ${result.approvalStatus}; coverage remains ${result.coverageStatus}.`)
			setAssetReviewJson("")
			await refreshHistory()
			await inspectAssetEvidence(selectedAsset)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [assetHistory, assetReviewJson, inspectAssetEvidence, refreshHistory, selectedAsset])

	const buildAssetReviewStatement = useCallback(async () => {
		if (!selectedAsset || !assetHistory[0]) return
		setBusy("asset-review-build")
		setError("")
		try {
			const result = await rpcRequest<{ statement: Omit<ClearSignCentralAssetReview, 'signature'>; digest: string }>("clearsignBuildCentralAssetReview", {
				caip: selectedAsset, evidenceHash: assetHistory[0].evidenceHash, reviewerPublicKey, role: reviewRole, decision: reviewDecision,
			})
			setReviewDigest(result.digest)
			setAssetReviewJson(JSON.stringify({ ...result.statement, signature: "" }, null, 2))
			setNotice("Unsigned statement created. Sign the displayed SHA-256 digest with the authorized reviewer key, then paste the signature into the JSON.")
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [assetHistory, reviewDecision, reviewRole, reviewerPublicKey, selectedAsset])

	const signAssetReviewStatement = useCallback(async () => {
		setBusy("asset-review-sign")
		setError("")
		setNotice("")
		try {
			const { signature: _signature, ...statement } = JSON.parse(assetReviewJson) as ClearSignCentralAssetReview
			const signed = await rpcRequest<ClearSignCentralAssetReview>("clearsignSignCentralReview", statement)
			setAssetReviewJson(JSON.stringify(signed, null, 2))
			setNotice(`${signed.role} service signed the exact displayed asset review. Inspect it, then submit.`)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [assetReviewJson])

	const inspectContractAudit = useCallback(async (auditId: string) => {
		setBusy("contract-audit")
		setError("")
		try {
			setContractAudit(await rpcRequest<ClearSignCentralContractAudit>("clearsignGetCentralContractAudit", { auditId }))
			setContractReviewJson("")
			setContractReviewDigest("")
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [])

	const buildContractReviewStatement = useCallback(async () => {
		if (!contractAudit) return
		setBusy("contract-review-build")
		setError("")
		try {
			const result = await rpcRequest<{ statement: Omit<ClearSignCentralContractReview, 'signature'>; digest: string }>("clearsignBuildCentralContractReview", {
				auditId: contractAudit.auditId, evidenceHash: contractAudit.evidenceHash, reviewerPublicKey,
				role: reviewRole, decision: reviewDecision,
			})
			setContractReviewDigest(result.digest)
			setContractReviewJson(JSON.stringify({ ...result.statement, signature: "" }, null, 2))
			setNotice("Unsigned contract review created. Sign the displayed digest externally and paste only the recoverable signature into the JSON.")
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [contractAudit, reviewDecision, reviewerPublicKey, reviewRole])

	const signContractReviewStatement = useCallback(async () => {
		setBusy("contract-review-sign")
		setError("")
		setNotice("")
		try {
			const { signature: _signature, ...statement } = JSON.parse(contractReviewJson) as ClearSignCentralContractReview
			const signed = await rpcRequest<ClearSignCentralContractReview>("clearsignSignCentralReview", statement)
			setContractReviewJson(JSON.stringify(signed, null, 2))
			setNotice(`${signed.role} service signed the exact displayed contract review. Inspect it, then submit.`)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [contractReviewJson])

	const submitContractReview = useCallback(async () => {
		if (!contractAudit) return
		setBusy("contract-review")
		setError("")
		try {
			const review = JSON.parse(contractReviewJson) as ClearSignCentralContractReview
			if (review.auditId !== contractAudit.auditId || review.evidenceHash !== contractAudit.evidenceHash) throw new Error("Signed review does not bind the selected current contract audit")
			const result = await rpcRequest<Record<string, unknown>>("clearsignSubmitCentralContractReview", review)
			setNotice(`Contract review accepted: ${String(result.status || "pending second role")}.`)
			setContractReviewJson("")
			await refreshHistory()
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [contractAudit, contractReviewJson, refreshHistory])

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

	const showChildSeed = useCallback(async () => {
		setBusy("bip85")
		setError("")
		setNotice("")
		try {
			await rpcRequest("getBip85Mnemonic", { wordCount, index: bip85Index }, 0)
			setNotice(`Look at your KeepKey: the ${wordCount}-word child seed for index ${bip85Index} is on screen. Type it below, then let the screen clear.`)
		} catch (cause: any) {
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [bip85Index, wordCount])

	const deriveProvider = useCallback(async () => {
		setBusy("derive")
		setError("")
		setNotice("")
		try {
			const result = await rpcRequest<{ publicKeyHex: string; fingerprint: string; filePath: string }>(
				"clearsignDeriveProviderKey",
				{ childMnemonic, alias, wordCount, index: bip85Index },
			)
			setProviderKey(result)
			setChildMnemonic("")
			setNotice(`Provider key ${result.fingerprint} written to ${result.filePath}. The words are cleared from this screen.`)
		} catch (cause: any) {
			setProviderKey(null)
			setError(cause?.message || String(cause))
		} finally {
			setBusy("")
		}
	}, [alias, bip85Index, childMnemonic, wordCount])

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
					{(["author", "provider", "signer", "evidence"] as StudioTab[]).map(value => (
						<Button key={value} size="sm" variant={tab === value ? "solid" : "ghost"} bg={tab === value ? "var(--gold)" : undefined} color={tab === value ? "#15110a" : "var(--text-1)"} onClick={() => setTab(value)}>
							{value === "author" ? "Author & attest" : value === "provider" ? "Create provider key" : value === "signer" ? "Load identity" : `Evidence (${history.length})`}
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

						{tab === "provider" && (
							<Flex gap="4" direction={{ base: "column", lg: "row" }}>
								<Box flex="1" p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Text fontSize="12px" fontWeight="700" color="var(--text-0)">1 · Derive a child seed on the device</Text>
									<Text fontSize="11px" color="var(--text-2)" mt="1">BIP-85 gives no custody: the key ends up hot inside a live service. What it gives is a ceremony you can repeat and audit from device + index instead of a key file of unexplained origin.</Text>
									<Box mt="3"><FieldLabel hint="shown on device when the signer is loaded">Provider alias</FieldLabel><Input value={alias} onChange={event => { setAlias(event.target.value); setProviderKey(null) }} maxLength={31} size="sm" bg="rgba(0,0,0,0.18)" /></Box>
									<Flex gap="1" align="center" mt="3"><Text fontSize="10px" color="var(--text-2)" mr="2">Words</Text>{([12, 18, 24] as const).map(value => <Button key={value} size="xs" minW="38px" variant={wordCount === value ? "solid" : "outline"} bg={wordCount === value ? "var(--gold)" : undefined} color={wordCount === value ? "#15110a" : "var(--text-1)"} onClick={() => { setWordCount(value); setProviderKey(null) }}>{value}</Button>)}</Flex>
									<Box mt="3"><FieldLabel hint="same index always re-derives the same key">Index</FieldLabel><Input type="number" min={0} value={bip85Index} onChange={event => { setBip85Index(Math.max(0, Number(event.target.value) || 0)); setProviderKey(null) }} size="sm" w="140px" bg="rgba(0,0,0,0.18)" /></Box>
									<Button mt="4" w="full" size="sm" variant="outline" borderColor="var(--line)" onClick={showChildSeed} loading={busy === "bip85"} disabled={!!busy}>Show child seed on device</Button>
									<Text fontSize="10px" color="var(--text-2)" mt="3">The words are displayed on the KeepKey screen only — they never cross USB. Read them off the device and type them below.</Text>
								</Box>

								<Box flex="1" p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Text fontSize="12px" fontWeight="700" color="var(--text-0)">2 · Type the words back</Text>
									<Text fontSize="11px" color="var(--text-2)" mt="1">A typo fails the BIP-39 checksum rather than deriving a plausible key whose fingerprint never matches any device.</Text>
									<Box mt="3"><FieldLabel hint="12, 18 or 24 words">BIP-85 child mnemonic</FieldLabel><Textarea value={childMnemonic} onChange={event => { setChildMnemonic(event.target.value); setProviderKey(null) }} rows={4} fontSize="11px" bg="rgba(0,0,0,0.18)" spellCheck={false} autoComplete="off" /></Box>
									<Button mt="3" w="full" size="sm" bg="var(--gold)" color="#15110a" onClick={deriveProvider} loading={busy === "derive"} disabled={!!busy || !childMnemonic.trim() || !alias.trim()}>Derive provider key</Button>
									<Box mt="3" p="3" bg="rgba(255,255,255,0.025)" borderRadius="10px"><VStack align="stretch" gap="2"><ResultRow label="Fingerprint" value={providerKey?.fingerprint} /><ResultRow label="Public key" value={providerKey ? shortHex(providerKey.publicKeyHex) : undefined} /><ResultRow label="Key file" value={providerKey?.filePath} /></VStack></Box>
									{providerKey && <>
										<Text fontSize="10px" color="var(--gold)" mt="3">The key file holds a live signing key in plaintext. It can mislabel what a transaction appears to do under this alias; it can never conceal one, and never removes the raw review.</Text>
										<Flex gap="2" mt="3"><Button flex="1" size="xs" variant="outline" borderColor="var(--line)" onClick={() => copy("providerKey", providerKey.publicKeyHex)}>{copied === "providerKey" ? "Copied" : "Copy public key"}</Button><Button flex="1" size="xs" variant="ghost" color="var(--gold)" onClick={() => { setPublicKeyInput(providerKey.publicKeyHex); setIdentity({ publicKey: providerKey.publicKeyHex, fingerprint: providerKey.fingerprint }); setLoaded(false); setTab("signer") }}>Load this identity →</Button></Flex>
									</>}
								</Box>
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
							<VStack align="stretch" gap="3">
								<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Flex justify="space-between" align="start" gap="4" wrap="wrap">
										<Box><Text fontSize="12px" fontWeight="700" color="var(--text-0)">Pioneer ecosystem control plane</Text><Text fontSize="10px" color="var(--text-2)" mt="1">Pinned global inventory and privacy-safe contract audit queue. Queue state is not signing authorization.</Text></Box>
										<Box textAlign="right"><Text fontSize="22px" fontWeight="800" color={centralStatus?.complete ? "var(--teal)" : "var(--gold)"}>{centralStatus?.importedAssets ?? 0}</Text><Text fontSize="9px" color="var(--text-2)">of {centralStatus?.totalAssets ?? 0} assets indexed</Text></Box>
									</Flex>
									<Flex gap="2" mt="3" wrap="wrap">
										<Box flex="1" minW="120px" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Text fontSize="9px" color="var(--text-2)">Eligible on demand</Text><Text fontSize="14px" fontWeight="800" color="var(--teal)">{centralStatus?.byCoverage['eligible-on-demand'] ?? 0}</Text></Box>
										<Box flex="1" minW="120px" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Text fontSize="9px" color="var(--text-2)">Needs work</Text><Text fontSize="14px" fontWeight="800" color="var(--gold)">{centralStatus?.byCoverage['needs-work'] ?? 0}</Text></Box>
										<Box flex="1" minW="120px" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Text fontSize="9px" color="var(--text-2)">Certified EVM chains</Text><Text fontSize="14px" fontWeight="800" color="var(--text-0)">{centralStatus?.certificateChainIds.length ?? 0}</Text></Box>
									</Flex>
									<Text mt="3" fontSize="9px" color="var(--text-2)">Queue: pending {centralStatus?.contractQueue.pending ?? 0} · auditing {centralStatus?.contractQueue.auditing ?? 0} · awaiting approval {centralStatus?.contractQueue['awaiting-approval'] ?? 0} · approved {centralStatus?.contractQueue.approved ?? 0} · rejected {centralStatus?.contractQueue.rejected ?? 0}</Text>
									<Text mt="1" fontSize="9px" color="var(--text-2)">Asset audits: pending {centralStatus?.byAssetAudit.pending ?? 0} · auditing {centralStatus?.byAssetAudit.auditing ?? 0} · candidates {centralStatus?.byAssetAudit.candidate ?? 0} · covered {centralStatus?.byAssetAudit.covered ?? 0} · rejected {centralStatus?.byAssetAudit.rejected ?? 0}</Text>
									<Text mt="1" fontSize="9px" color="var(--text-2)">Asset approvals: pending {centralStatus?.byAssetApproval.pending ?? 0} · approved {centralStatus?.byAssetApproval.approved ?? 0} · rejected {centralStatus?.byAssetApproval.rejected ?? 0}</Text>
									<Text mt="1" fontSize="9px" color={centralStatus?.sourceDrift ? "var(--rose)" : "var(--teal)"}>Pioneer source: {centralStatus?.sourceDrift ? "changed — dynamic signing paused for review" : centralStatus?.sourceObservation ? "current" : "not observed"}{centralStatus?.sourceObservation ? ` · checked ${new Date(centralStatus.sourceObservation.observedAt).toLocaleString()}` : ""}</Text>
									<Text mt="1" fontSize="9px" color={centralStatus?.reviewPolicy?.ready ? "var(--teal)" : "var(--rose)"}>Review policy: {centralStatus?.reviewPolicy?.ready ? `${centralStatus.reviewPolicy.reviewers.length} authorized identities · distinct semantics and security roles ready` : "blocked — provision distinct semantics and security reviewer public keys"}</Text>
									<VStack align="stretch" gap="2" mt="3">{centralStatus?.assetCandidates.slice(0, 10).map(asset => <Flex key={asset.caip} justify="space-between" gap="3" p="2.5" borderRadius="8px" bg="rgba(139,227,196,0.04)" border="1px solid rgba(139,227,196,0.12)"><Box minW="0"><Text fontSize="10px" fontWeight="700" color="var(--gold)">{asset.symbol || "Unknown token"} · {asset.approval_status === "approved" ? "approved evidence" : "awaiting review"}</Text><Text fontSize="9px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{asset.caip}</Text><Text fontSize="8px" color="var(--text-2)">Evidence {asset.audit_evidence_hash?.slice(0, 12)}… · coverage remains {asset.coverage_status}</Text></Box><Box textAlign="right" flexShrink={0}><Text fontSize="9px" color="var(--text-2)">{asset.audit_attempts} audit{asset.audit_attempts === 1 ? "" : "s"}</Text>{asset.next_recheck_at ? <Text fontSize="8px" color="var(--text-2)">recheck {new Date(asset.next_recheck_at).toLocaleDateString()}</Text> : null}<Button mt="1.5" size="xs" variant="outline" onClick={() => void inspectAssetEvidence(asset.caip)} loading={busy === "asset-history" && selectedAsset === asset.caip} disabled={!!busy}>Inspect evidence</Button></Box></Flex>)}</VStack>
									{selectedAsset && <Box mt="3" p="3" borderRadius="8px" bg="rgba(0,0,0,0.2)" border="1px solid var(--line)"><Flex justify="space-between" gap="3" align="center"><Box minW="0"><Text fontSize="10px" fontWeight="700" color="var(--text-0)">Immutable audit history</Text><Text fontSize="8px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{selectedAsset}</Text></Box><Button size="xs" variant="outline" disabled={!assetHistory.length} onClick={async () => { const ok = await copyText(JSON.stringify({ caip: selectedAsset, audits: assetHistory }, null, 2)); setCopied(ok ? "asset-evidence" : ""); setNotice(ok ? "Audit evidence copied for offline review." : "Copy failed.") }}>{copied === "asset-evidence" ? "Copied" : "Copy review bundle"}</Button></Flex>{assetHistory.length === 0 ? <Text mt="2" fontSize="9px" color="var(--text-2)">No audit history returned.</Text> : assetHistory.map(audit => <Box key={audit.auditId} mt="2" p="2" borderRadius="6px" bg="rgba(255,255,255,0.025)"><Text fontSize="8px" color="var(--text-2)">{new Date(audit.submittedAt).toLocaleString()} · audit {audit.auditId}</Text><Text fontSize="8px" fontFamily="mono" color="var(--teal)" wordBreak="break-all">sha256 {audit.evidenceHash}</Text><Box as="pre" mt="2" fontSize="8px" color="var(--text-1)" whiteSpace="pre-wrap" wordBreak="break-all" maxH="220px" overflowY="auto">{JSON.stringify(audit.evidence, null, 2)}</Box></Box>)}<Box mt="3" pt="3" borderTop="1px solid var(--line)"><FieldLabel hint="compressed secp256k1">Reviewer public key</FieldLabel><Flex gap="2"><Input value={reviewerPublicKey} onChange={event => { setReviewerPublicKey(event.target.value); setReviewerFingerprint("") }} placeholder="02… or 03…" size="sm" fontFamily="mono" fontSize="9px" bg="rgba(0,0,0,0.18)" /><Button flexShrink={0} size="sm" variant="outline" borderColor="var(--teal)" color="var(--teal)" onClick={() => void loadConfiguredReviewer()} loading={busy === "reviewer-identity"} disabled={!!busy}>Use configured</Button></Flex>{reviewerFingerprint && <Text mt="1" fontSize="8px" color="var(--teal)">Configured fingerprint: {reviewerFingerprint}</Text>}<Flex gap="2" mt="2" wrap="wrap"><Button size="xs" variant={reviewRole === "semantics-review" ? "solid" : "outline"} onClick={() => { setReviewRole("semantics-review"); setReviewerPublicKey(""); setReviewerFingerprint("") }}>Semantics</Button><Button size="xs" variant={reviewRole === "security-review" ? "solid" : "outline"} onClick={() => { setReviewRole("security-review"); setReviewerPublicKey(""); setReviewerFingerprint("") }}>Security</Button><Button size="xs" variant={reviewDecision === "approve" ? "solid" : "outline"} onClick={() => setReviewDecision("approve")}>Approve</Button><Button size="xs" variant={reviewDecision === "reject" ? "solid" : "outline"} onClick={() => setReviewDecision("reject")}>Reject</Button><Button size="xs" bg="var(--teal)" color="#071510" onClick={() => void buildAssetReviewStatement()} loading={busy === "asset-review-build"} disabled={!!busy || !reviewerPublicKey.trim()}>Build statement</Button></Flex>{reviewDigest && <Box mt="2"><Text fontSize="8px" color="var(--text-2)">Digest to sign (SHA-256)</Text><Text fontSize="8px" fontFamily="mono" color="var(--teal)" wordBreak="break-all">{reviewDigest}</Text></Box>}<Box mt="2"><FieldLabel hint="signed outside Vault">Review statement JSON</FieldLabel><Textarea value={assetReviewJson} onChange={event => setAssetReviewJson(event.target.value)} placeholder='{"version":1,"caip":"…","evidenceHash":"…","reviewerPublicKey":"…","role":"semantics-review","decision":"approve","reviewedAt":0,"signature":"…"}' minH="110px" fontFamily="mono" fontSize="9px" bg="rgba(0,0,0,0.18)"/><Text mt="1.5" fontSize="8px" color="var(--text-2)">Vault checks the selected CAIP and latest evidence hash before submission. The worker independently recovers the signature and enforces the authorized reviewer role.</Text><Flex gap="2" mt="2" wrap="wrap"><Button size="xs" variant="outline" borderColor="var(--teal)" color="var(--teal)" onClick={() => void signAssetReviewStatement()} loading={busy === "asset-review-sign"} disabled={!!busy || !assetReviewJson.trim()}>Sign with configured reviewer</Button><Button size="xs" bg="var(--gold)" color="#15110a" onClick={() => void submitAssetReview()} loading={busy === "asset-review"} disabled={!!busy || !assetReviewJson.trim() || !assetHistory.length}>Submit signed review</Button></Flex></Box></Box></Box>}
									<VStack align="stretch" gap="2" mt="3">{centralStatus?.requests.slice(0, 10).map(request => <Flex key={request.id} justify="space-between" gap="3" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Box minW="0"><Text fontSize="10px" fontWeight="700" color={request.status === "rejected" ? "var(--rose)" : request.status === "awaiting-approval" ? "var(--gold)" : "var(--text-0)"}>{request.network} · {request.status}</Text><Text fontSize="9px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{request.contract} · {request.selector} · {request.calldata_length} bytes</Text>{request.last_error && <Text fontSize="8px" color="var(--rose)">{request.last_error}</Text>}</Box><Box textAlign="right" flexShrink={0}><Text fontSize="13px" fontWeight="800" color="var(--gold)">{request.sightings}×</Text><Text fontSize="8px" color="var(--text-2)">{request.attempts} audits</Text>{request.current_audit_id && <Button mt="1.5" size="xs" variant="outline" onClick={() => void inspectContractAudit(request.current_audit_id!)} loading={busy === "contract-audit" && contractAudit?.auditId === request.current_audit_id} disabled={!!busy}>Inspect audit</Button>}</Box></Flex>)}</VStack>{contractAudit && <Box mt="3" p="3" borderRadius="8px" bg="rgba(0,0,0,0.2)" border="1px solid var(--line)"><Flex justify="space-between" gap="3" align="center"><Box minW="0"><Text fontSize="10px" fontWeight="700" color="var(--text-0)">Contract audit evidence</Text><Text fontSize="8px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{contractAudit.auditId}</Text></Box><Button size="xs" variant="outline" onClick={async () => { const ok = await copyText(JSON.stringify(contractAudit, null, 2)); setCopied(ok ? "contract-evidence" : ""); setNotice(ok ? "Contract audit copied for offline review." : "Copy failed.") }}>{copied === "contract-evidence" ? "Copied" : "Copy audit"}</Button></Flex><Text mt="2" fontSize="8px" fontFamily="mono" color="var(--teal)" wordBreak="break-all">sha256 {contractAudit.evidenceHash}</Text><Box as="pre" mt="2" p="2" fontSize="8px" color="var(--text-1)" whiteSpace="pre-wrap" wordBreak="break-all" maxH="220px" overflowY="auto" bg="rgba(255,255,255,0.025)" borderRadius="6px">{JSON.stringify(contractAudit.evidence, null, 2)}</Box><Box mt="3" pt="3" borderTop="1px solid var(--line)"><FieldLabel hint="shared authorized reviewer identity">Reviewer public key</FieldLabel><Flex gap="2"><Input value={reviewerPublicKey} onChange={event => { setReviewerPublicKey(event.target.value); setReviewerFingerprint("") }} placeholder="02… or 03…" size="sm" fontFamily="mono" fontSize="9px" bg="rgba(0,0,0,0.18)" /><Button flexShrink={0} size="sm" variant="outline" borderColor="var(--teal)" color="var(--teal)" onClick={() => void loadConfiguredReviewer()} loading={busy === "reviewer-identity"} disabled={!!busy}>Use configured</Button></Flex>{reviewerFingerprint && <Text mt="1" fontSize="8px" color="var(--teal)">Configured fingerprint: {reviewerFingerprint}</Text>}<Flex gap="2" mt="2" wrap="wrap"><Button size="xs" variant={reviewRole === "semantics-review" ? "solid" : "outline"} onClick={() => { setReviewRole("semantics-review"); setReviewerPublicKey(""); setReviewerFingerprint("") }}>Semantics</Button><Button size="xs" variant={reviewRole === "security-review" ? "solid" : "outline"} onClick={() => { setReviewRole("security-review"); setReviewerPublicKey(""); setReviewerFingerprint("") }}>Security</Button><Button size="xs" variant={reviewDecision === "approve" ? "solid" : "outline"} onClick={() => setReviewDecision("approve")}>Approve</Button><Button size="xs" variant={reviewDecision === "reject" ? "solid" : "outline"} onClick={() => setReviewDecision("reject")}>Reject</Button><Button size="xs" bg="var(--teal)" color="#071510" onClick={() => void buildContractReviewStatement()} loading={busy === "contract-review-build"} disabled={!!busy || !reviewerPublicKey.trim()}>Build statement</Button></Flex>{contractReviewDigest && <Text mt="2" fontSize="8px" fontFamily="mono" color="var(--teal)" wordBreak="break-all">Digest: {contractReviewDigest}</Text>}<Textarea mt="2" value={contractReviewJson} onChange={event => setContractReviewJson(event.target.value)} placeholder='{"version":1,"auditId":"…","evidenceHash":"…","signature":"…"}' minH="110px" fontFamily="mono" fontSize="9px" bg="rgba(0,0,0,0.18)"/><Flex gap="2" mt="2" wrap="wrap"><Button size="xs" variant="outline" borderColor="var(--teal)" color="var(--teal)" onClick={() => void signContractReviewStatement()} loading={busy === "contract-review-sign"} disabled={!!busy || !contractReviewJson.trim()}>Sign with configured reviewer</Button><Button size="xs" bg="var(--gold)" color="#15110a" onClick={() => void submitContractReview()} loading={busy === "contract-review"} disabled={!!busy || !contractReviewJson.trim()}>Submit signed review</Button></Flex></Box></Box>}
								</Box>
								<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Flex justify="space-between" align="start" gap="4" wrap="wrap">
										<Box><Text fontSize="12px" fontWeight="700" color="var(--text-0)">Live protection coverage</Text><Text fontSize="10px" color="var(--text-2)" mt="1">Every observed signing request is the denominator. P4/P5 means an authenticated definition reached the device.</Text></Box>
										<Box textAlign="right"><Text fontSize="22px" fontWeight="800" color="var(--gold)">{coverage?.authenticatedPercent ?? 0}%</Text><Text fontSize="9px" color="var(--text-2)">{coverage?.authenticatedRequests ?? 0} of {coverage?.totalRequests ?? 0} requests</Text></Box>
									</Flex>
									<Flex gap="2" mt="3" wrap="wrap">{(["P0", "P1", "P2", "P3", "P4", "P5"] as const).map(level => <Box key={level} px="2.5" py="1.5" borderRadius="8px" bg="rgba(255,255,255,0.035)"><Text fontSize="9px" color="var(--text-2)">{level}</Text><Text fontSize="13px" fontWeight="700" color={level === "P4" || level === "P5" ? "var(--teal)" : "var(--text-0)"}>{coverage?.byLevel[level] ?? 0}</Text></Box>)}</Flex>
									<Flex gap="2" mt="3" wrap="wrap">
										{([['Ethereum', coverage?.byChain.Ethereum], ['Solana', coverage?.byChain.Solana], ['24 hours', coverage?.rolling.last24Hours], ['7 days', coverage?.rolling.last7Days]] as const).map(([label, slice]) => <Box key={label} flex="1" minW="110px" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Text fontSize="9px" color="var(--text-2)">{label}</Text><Text fontSize="13px" fontWeight="700" color="var(--text-0)">{slice?.authenticatedPercent ?? 0}%</Text><Text fontSize="8px" color="var(--text-2)">{slice?.authenticatedRequests ?? 0}/{slice?.totalRequests ?? 0} authenticated</Text></Box>)}
									</Flex>
									<Flex gap="2" mt="2" wrap="wrap">{(['walletconnect', 'vault-rpc', 'vault-swap', 'rest-api'] as const).map(source => <Text key={source} fontSize="8px" color="var(--text-2)">{source}: {coverage?.bySource[source].authenticatedRequests ?? 0}/{coverage?.bySource[source].totalRequests ?? 0}</Text>)}</Flex>
									<Flex justify="space-between" gap="3" mt="2" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Box><Text fontSize="9px" color="var(--text-2)">Pre-sign simulation success</Text><Text fontSize="13px" fontWeight="700" color="var(--text-0)">{coverage?.simulation.successPercent ?? 0}%</Text></Box><Box textAlign="right"><Text fontSize="9px" color="var(--text-2)">{coverage?.simulation.successfulRequests ?? 0}/{coverage?.simulation.attemptedRequests ?? 0} attempts</Text><Text fontSize="8px" color="var(--text-2)">revert {coverage?.bySimulation.revert ?? 0} · incomplete {coverage?.bySimulation.incomplete ?? 0} · unavailable {coverage?.bySimulation.unavailable ?? 0}</Text></Box></Flex>
									<Flex justify="space-between" gap="3" mt="2" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Box><Text fontSize="9px" color="var(--text-2)">Definition resolution</Text><Text fontSize="13px" fontWeight="700" color="var(--text-0)">{coverage?.definitions.selectedRequests ?? 0}/{coverage?.definitions.checkedRequests ?? 0} selected</Text></Box><Box textAlign="right"><Text fontSize="9px" color="var(--rose)">{coverage?.definitions.refusedRequests ?? 0} refused</Text><Text fontSize="8px" color="var(--text-2)">{coverage?.definitions.noArtifactRequests ?? 0} had no artifact</Text></Box></Flex>
									<Flex justify="space-between" gap="3" mt="2" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Box><Text fontSize="9px" color="var(--text-2)">Authenticated instruction coverage</Text><Text fontSize="13px" fontWeight="700" color="var(--text-0)">{coverage?.componentCoverage?.authenticatedPercent ?? 0}%</Text></Box><Box textAlign="right"><Text fontSize="9px" color="var(--text-1)">{coverage?.componentCoverage?.authenticatedAppearances ?? 0}/{coverage?.componentCoverage?.totalAppearances ?? 0} components</Text><Text fontSize="8px" color="var(--text-2)">{coverage?.componentCoverage?.fullyAuthenticatedRequests ?? 0} full · {coverage?.componentCoverage?.partiallyAuthenticatedRequests ?? 0} partial requests</Text></Box></Flex>
									<Flex justify="space-between" gap="3" mt="2" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Box><Text fontSize="9px" color="var(--text-2)">Live audit pipeline</Text><Text fontSize="13px" fontWeight="700" color="var(--text-0)">{(coverage?.auditQueue.pending ?? 0) + (coverage?.auditQueue.auditing ?? 0)} queued/active</Text></Box><Box textAlign="right"><Text fontSize="9px" color={(coverage?.auditQueue.identityChanged ?? 0) ? "var(--rose)" : "var(--text-2)"}>{coverage?.auditQueue.identityChanged ?? 0} current · {coverage?.auditQueue.historicalIdentityChanges ?? 0} historical identity regressions</Text><Text fontSize="8px" color="var(--text-2)">{coverage?.auditQueue.evidenceReady ?? 0} evidence-ready · {coverage?.auditQueue.failed ?? 0} failed</Text></Box></Flex>
								</Box>
								<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Text fontSize="12px" fontWeight="700" color="var(--text-0)">Observed contract and instruction spectrum</Text>
									<Text fontSize="10px" color="var(--text-2)" mt="1" mb="3">Individual EVM calls and Solana instructions ranked by appearances. This is demand, not a claim that each component is covered.</Text>
									{!coverage?.topComponents?.length && <Text fontSize="11px" color="var(--text-2)">No component demand recorded yet.</Text>}
									<VStack align="stretch" gap="2">{coverage?.topComponents?.slice(0, 10).map(component => <Flex key={component.componentKey} justify="space-between" gap="3" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Box minW="0"><Text fontSize="10px" fontWeight="700" color="var(--text-0)">{component.chain} · {component.auditStatus || "not queued"}</Text><Text fontSize="9px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{JSON.stringify(component.component)}</Text></Box><Box textAlign="right" flexShrink={0}><Text fontSize="14px" fontWeight="800" color="var(--gold)">{component.count}×</Text><Text fontSize="8px" color="var(--text-2)">{component.maxExposureClass}</Text></Box></Flex>)}</VStack>
								</Box>
								<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Text fontSize="12px" fontWeight="700" color="var(--text-0)">Real-world protection evidence</Text>
									<Text fontSize="10px" color="var(--text-2)" mt="1" mb="3">Completed public transactions re-fetched from chain. These examples separate authenticated device claims from simulation and cross-chain promises.</Text>
									<VStack align="stretch" gap="2">{caseStudies.map(study => <Box key={study.id} p="3" borderRadius="9px" bg="rgba(255,255,255,0.025)" border="1px solid" borderColor={study.status === "verified" ? "rgba(139,227,196,0.18)" : "rgba(224,140,123,0.28)"}>
										<Flex justify="space-between" gap="3"><Box><Text fontSize="10px" fontWeight="800" color={study.status === "verified" ? "var(--teal)" : "var(--rose)"}>{study.status.toUpperCase()} · {study.chain} · {study.protectionLevel}</Text><Text fontSize="11px" fontWeight="700" color="var(--text-0)">{study.title}</Text></Box><Text fontSize="9px" color="var(--text-2)" textAlign="right">{study.stateReference ? `block/slot ${study.stateReference}` : "RPC unavailable"}</Text></Flex>
										<Text mt="2" fontSize="9px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{study.transactionId}</Text>
										{study.facts.map((fact, index) => <Text key={`fact:${index}`} mt="1" fontSize="9px" color="var(--text-1)">Observed: {fact}</Text>)}
										{study.protections.map((item, index) => <Text key={`protect:${index}`} mt="1" fontSize="9px" color="var(--teal)">Protects: {item}</Text>)}
										{study.limits.map((item, index) => <Text key={`limit:${index}`} mt="1" fontSize="9px" color="var(--gold)">Limit: {item}</Text>)}
									</Box>)}</VStack>
								</Box>
								<Box p="4" borderRadius="14px" bg="var(--ink-0)" border="1px solid var(--line)">
									<Text fontSize="12px" fontWeight="700" color="var(--text-0)">Live audit queue</Text>
									<Text fontSize="10px" color="var(--text-2)" mt="1" mb="2">Unknown request shapes, ranked by privacy-safe potential exposure and then frequency. Only public program/selector shape is retained.</Text>
									<Text fontSize="8px" color="var(--text-2)" mb="3">Not evaluated {coverage?.byExposure['not-evaluated'] ?? 0} · unknown effects {coverage?.byExposure['unknown-effects'] ?? 0} · unlimited authority {coverage?.byExposure['unlimited-authority'] ?? 0} · bounded outflow {coverage?.byExposure['bounded-outflow'] ?? 0}</Text>
									{auditJobs.filter(job => job.status !== "covered").length === 0 && <Text fontSize="11px" color="var(--text-2)">No unknown request shapes recorded yet.</Text>}
									<VStack align="stretch" gap="2">{auditJobs.filter(job => job.status !== "covered").slice(0, 10).map(job => <Flex key={job.shapeKey} justify="space-between" gap="3" p="2.5" borderRadius="8px" bg="rgba(255,255,255,0.025)"><Box minW="0"><Text fontSize="10px" fontWeight="700" color="var(--text-0)">{job.chain} · {job.lastProtectionLevel} · {job.status}</Text><Text fontSize="9px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{JSON.stringify(job.shape)}</Text>{job.evidence && <Box mt="2" pt="2" borderTop="1px solid var(--line)"><Text fontSize="9px" color="var(--teal)">Identity evidence at {job.evidence.stateReference || "provider head"}</Text>{job.evidence.identities.map(identity => <Text key={`${identity.role}:${identity.address}`} fontSize="9px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all">{identity.role}: {identity.address}{identity.codeHash ? ` · ${shortHex(identity.codeHash, 10)}` : ""}{identity.upgradeAuthority ? ` · upgrade authority ${identity.upgradeAuthority}` : ""}</Text>)}{job.evidence.candidates?.map((candidate, index) => <Box key={`${candidate.source}:${candidate.address}:${index}`} mt="1.5" p="2" borderRadius="6px" bg="rgba(233,196,106,0.06)"><Text fontSize="9px" fontWeight="700" color="var(--gold)">Candidate only · {candidate.name}</Text><Text fontSize="9px" fontFamily="mono" color="var(--text-1)" wordBreak="break-all">{candidate.signature || candidate.selectorOrDiscriminator}</Text><Text fontSize="8px" color="var(--text-2)">{candidate.source} · {candidate.matchQuality || "unrated"} · requires fixtures and review</Text></Box>)}</Box>}{job.errorClass && <Text mt="1" fontSize="9px" color="var(--rose)">Audit: {job.errorClass}</Text>}</Box><Box textAlign="right" flexShrink={0}><Text fontSize="14px" fontWeight="800" color="var(--gold)">{job.requestCount}×</Text><Text fontSize="9px" color="var(--text-2)">{eventTime(job.lastSeenAt)}</Text><Text fontSize="9px" color="var(--text-2)">{job.attempts} audit{job.attempts === 1 ? "" : "s"}</Text></Box></Flex>)}</VStack>
								</Box>
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
							</VStack>
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
