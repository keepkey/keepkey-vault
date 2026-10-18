import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Spinner, Textarea, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { BtcWatchOnlyImport } from "../../shared/types"
import { toBase64 } from "./PsbtSignDialog"

/** Opens the dialog. detail: an optional dropped File (FirmwareDropZone sniffs Electrum files and keys). */
export const WATCH_ONLY_IMPORT_EVENT = "keepkey-watch-only-import"
const MAX_FILE_BYTES = 10 * 1024 * 1024

type Phase = "idle" | "input" | "checking" | "preview" | "saving" | "error"
type Source = { data: string } | { fileBytes: string }

const card = { bg: "rgba(255,255,255,0.03)", borderRadius: "lg", border: "1px solid", borderColor: "kk.border", p: "3" } as const
const SCRIPT_LABEL: Record<string, string> = { p2wpkh: "Native SegWit (bc1q)", "p2sh-p2wpkh": "Nested SegWit (3...)", p2pkh: "Legacy (1...)" }

/**
 * WatchOnlyImportDialog — add a Bitcoin watch-only wallet from an Electrum wallet
 * file or a bare xpub/ypub/zpub, on a machine that never saw the KeepKey.
 *
 * Bun parses and refuses (private keys, testnet, multisig, Electrum seed wallets);
 * this dialog shows the preview, asks the user to confirm an inferred path, then
 * saves and refreshes balances through the active backend (the user's own node when set).
 */
export function WatchOnlyImportDialog({ onImported }: { onImported: (deviceId: string, label: string) => void }) {
	const [phase, setPhase] = useState<Phase>("idle")
	const [source, setSource] = useState<Source | null>(null)
	const [fileName, setFileName] = useState("")
	const [pasted, setPasted] = useState("")
	const [preview, setPreview] = useState<BtcWatchOnlyImport | null>(null)
	const [label, setLabel] = useState("")
	const [fingerprint, setFingerprint] = useState("")
	const [pathOk, setPathOk] = useState(false)
	const [taproot, setTaproot] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const fileRef = useRef<HTMLInputElement | null>(null)
	const phaseRef = useRef(phase)
	phaseRef.current = phase

	const check = useCallback(async (src: Source, name: string) => {
		setPhase("checking")
		setSource(src)
		setFileName(name)
		setError(null)
		setPreview(null)
		setPathOk(false)
		setTaproot(false)
		try {
			setPreview(await rpcRequest<BtcWatchOnlyImport>("btcWatchOnlyImport", src, 30000))
			setPhase("preview")
		} catch (e: any) {
			setError(e?.message || "Could not read this wallet")
			setPhase("error")
		}
	}, [])

	const readFile = useCallback(async (file: File) => {
		if (file.size > MAX_FILE_BYTES) {
			setFileName(file.name)
			setError("File is larger than 10 MB, refusing")
			setPhase("error")
			return
		}
		await check({ fileBytes: toBase64(new Uint8Array(await file.arrayBuffer())) }, file.name)
	}, [check])

	useEffect(() => {
		const onOpen = (e: Event) => {
			if (phaseRef.current === "checking" || phaseRef.current === "saving") return
			const file = (e as CustomEvent<File | undefined>).detail
			setPasted("")
			setLabel("")
			setFingerprint("")
			setError(null)
			setPreview(null)
			if (file) void readFile(file)
			else setPhase("input")
		}
		window.addEventListener(WATCH_ONLY_IMPORT_EVENT, onOpen)
		return () => window.removeEventListener(WATCH_ONLY_IMPORT_EVENT, onOpen)
	}, [readFile])

	const handleImport = useCallback(async () => {
		if (!source || !preview) return
		setPhase("saving")
		setError(null)
		try {
			// The account number is the key's own; only the purpose is a choice (Taproot is refused by bun).
			const path = taproot ? preview.path.replace(/^m\/44'/, "m/86'") : preview.path
			const saved = await rpcRequest<BtcWatchOnlyImport>("btcWatchOnlyImport", {
				...source, label, fingerprint: fingerprint.trim() || undefined, path: preview.pathAssumed ? path : undefined, save: true,
			}, 30000)
			// Balances right away, through the backend that will serve this wallet (own node when set).
			await rpcRequest("watchOnlySetView", { active: true, deviceId: saved.id }).catch(() => {})
			await rpcRequest("refreshWatchOnlyBalances", { deviceId: saved.id }, 200000)
				.catch((e: any) => console.warn("[WatchOnlyImport] first refresh failed:", e?.message))
			setPhase("idle")
			onImported(saved.id, saved.label)
		} catch (e: any) {
			setError(e?.message || "Import failed")
			setPhase("error")
		}
	}, [source, preview, label, fingerprint, taproot, onImported])

	const close = useCallback(() => { setPhase("idle"); setPreview(null); setSource(null) }, [])

	if (phase === "idle") return null

	const goldButton = { size: "sm", bg: "kk.gold", color: "black", fontWeight: "600", px: "4", py: "2", _hover: { bg: "kk.goldHover" } } as const
	const plainButton = { size: "sm", variant: "outline", color: "kk.textSecondary", borderColor: "kk.border", px: "4", py: "2" } as const
	const canImport = !!preview && (!preview.pathAssumed || pathOk || taproot)

	return (
		<>
			<Box position="fixed" inset="0" bg="rgba(0,0,0,0.85)" zIndex={Z.dialog} onClick={phase === "checking" || phase === "saving" ? undefined : close} />
			<Box
				position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)"
				w="520px" maxW="92vw" maxH="88vh" overflowY="auto"
				bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="xl"
				zIndex={Z.dialog + 1} role="dialog" aria-modal="true" aria-label="Import watch-only wallet"
			>
				<Box p="6">
					<Text fontSize="lg" fontWeight="700" color="kk.textPrimary">Import watch-only wallet</Text>
					<Text fontSize="xs" color="kk.textSecondary" mb="4">Bitcoin mainnet{fileName ? ` · ${fileName}` : ""}</Text>

					{phase === "input" && (
						<>
							<Text fontSize="sm" color="kk.textSecondary" mb="2">
								Paste an xpub, ypub or zpub, or choose an Electrum wallet file (you can also drop it on this window). Never a private key or seed.
							</Text>
							<Textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={4} fontFamily="mono" fontSize="xs" mb="3" placeholder="zpub6r..." />
							<input ref={fileRef} type="file" accept=".json,application/json,text/plain,*" style={{ display: "none" }}
								onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void readFile(f) }} />
							<Flex gap="2" justify="flex-end">
								<Button {...plainButton} onClick={close}>Cancel</Button>
								<Button {...plainButton} onClick={() => fileRef.current?.click()}>Choose file</Button>
								<Button {...goldButton} disabled={!pasted.trim()} onClick={() => void check({ data: pasted }, "")}>Check</Button>
							</Flex>
						</>
					)}

					{(phase === "checking" || phase === "saving") && (
						<Flex align="center" gap="2" py="6" justify="center">
							<Spinner size="sm" color="kk.gold" />
							<Text fontSize="sm" color="kk.textSecondary">{phase === "checking" ? "Reading the wallet..." : "Saving and fetching balances..."}</Text>
						</Flex>
					)}

					{phase === "preview" && preview && (
						<Flex direction="column" gap="3">
							<Box {...card} borderColor="rgba(233,196,106,0.4)" bg="rgba(233,196,106,0.06)">
								<Text fontSize="xs" color="var(--gold)">
									Not verified on a KeepKey. Until a KeepKey that holds this key is connected, Desktop cannot prove these addresses are yours.
									Balances are looked up by the balance server (or your own Bitcoin node, when set), which learns this key.
								</Text>
							</Box>
							<Box {...card}>
								<Text fontSize="xs" color="kk.textSecondary">{SCRIPT_LABEL[preview.scriptType]} · {preview.source === "electrum" ? "Electrum wallet file" : "extended public key"}</Text>
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all" mt="1">{preview.key}</Text>
								<Text fontSize="xs" color="kk.textSecondary" mt="2">Derivation path: <Text as="span" fontFamily="mono" color="kk.textPrimary">{preview.path}</Text>{preview.pathAssumed ? " (assumed)" : ""}</Text>
								<Text fontSize="xs" color="kk.textSecondary">Master fingerprint: <Text as="span" fontFamily="mono" color="kk.textPrimary">{preview.fingerprint ?? "unknown"}</Text></Text>
							</Box>

							{preview.pathAssumed && (
								<Box {...card}>
									<Text fontSize="xs" color="kk.textSecondary" mb="2">A bare key does not say where it came from. Confirm it:</Text>
									<Box as="label" display="flex" alignItems="flex-start" gap={2} cursor="pointer">
										<input type="radio" name="wo-path" checked={pathOk && !taproot}
											onChange={() => { setPathOk(true); setTaproot(false) }} style={{ marginTop: 2, accentColor: "#E9C46A", flexShrink: 0 }} />
										<Text fontSize="xs" color="kk.textPrimary">This is the {SCRIPT_LABEL[preview.scriptType]} account <Text as="span" fontFamily="mono">{preview.path}</Text></Text>
									</Box>
									{preview.scriptType === "p2pkh" && (
										<Box as="label" display="flex" alignItems="flex-start" gap={2} cursor="pointer" mt="1">
											<input type="radio" name="wo-path" checked={taproot}
												onChange={() => { setTaproot(true); setPathOk(false) }} style={{ marginTop: 2, accentColor: "#E9C46A", flexShrink: 0 }} />
											<Text fontSize="xs" color="kk.textPrimary">It is a Taproot (BIP86) key</Text>
										</Box>
									)}
								</Box>
							)}

							<Box>
								<Text fontSize="xs" color="kk.textSecondary" mb="1">Name (shown as "Imported · name")</Text>
								<Input size="sm" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder={`Bitcoin ${preview.path}`} />
							</Box>
							{!preview.fingerprint && (
								<Box>
									<Text fontSize="xs" color="kk.textSecondary" mb="1">Master fingerprint (optional, 8 hex). Without it, PSBTs use Electrum's relative key paths.</Text>
									<Input size="sm" fontFamily="mono" value={fingerprint} maxLength={8} onChange={(e) => setFingerprint(e.target.value)} placeholder="unknown" />
								</Box>
							)}

							<Flex gap="2" justify="flex-end">
								<Button {...plainButton} onClick={close}>Cancel</Button>
								<Button {...goldButton} disabled={!canImport} onClick={handleImport}>Import</Button>
							</Flex>
						</Flex>
					)}

					{phase === "error" && (
						<Flex direction="column" gap="3">
							<Text fontSize="sm" color="var(--rose)">{error || "Unknown error"}</Text>
							<Flex gap="2" justify="flex-end">
								{preview && <Button {...plainButton} onClick={() => setPhase("preview")}>Back</Button>}
								<Button {...plainButton} onClick={() => { setPreview(null); setPhase("input") }}>Try another</Button>
								<Button {...goldButton} onClick={close}>Close</Button>
							</Flex>
						</Flex>
					)}
				</Box>
			</Box>
		</>
	)
}
