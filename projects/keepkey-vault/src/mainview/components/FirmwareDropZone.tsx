import { useUiTranslation, firmwareProgressText } from "../i18n/ui"
import { looksLikeMultisigPolicy, MULTISIG_POLICY_EVENT } from "../../shared/multisig-policy"
import { Fragment, useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Spinner } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { IS_MAC, IS_WINDOWS } from "../lib/platform"
import type { FirmwareAnalysis, FirmwareProgress } from "../../shared/types"
import { BTC_ONLY_FEATURE } from "./FirmwareUpgradePreview"
import { getUpgradeVersions, type FirmwareFeature, type FirmwareVersionInfo } from "../../shared/firmware-versions"
import { useTranslation } from "react-i18next"
import { bootloaderTooOldForFirmware } from "../../shared/bootloader-compat"
import { Beam, ChainNode, PreflightActions, PreflightCheck, PreflightList, PreflightStyles, TimelineItem, TimelineMark, usePreflightScroll, type PreflightRow } from "./preflight/PreflightConsole"
import { useDeviceState } from "../hooks/useDeviceState"
import { OledText, SpinningDevice } from "./v3"
import { requiresBackupConfirmation } from "../lib/update-safety"
import holdAndConnectRaw from "../assets/svg/hold-and-connect.svg?raw"
import { looksLikePsbt, looksLikeRawTxHex, looksLikeWatchOnlyImport, PSBT_SNIFF_BYTES } from "../../shared/psbt-sniff"
import { PSBT_DROP_EVENT } from "./PsbtSignDialog"
import { WATCH_ONLY_IMPORT_EVENT } from "./WatchOnlyImportDialog"
import { BITCOIN_QR_SCAN_EVENT } from "./BitcoinQrImport"
import { BTC_BROADCAST_EVENT } from "./BroadcastSignedDialog"

/**
 * FirmwareDropZone — Global drag-and-drop dispatcher.
 *
 * Renders nothing when idle. Detects file type on drop:
 *   - .bin  → firmware analysis + flash flow (signed/unsigned, version compare).
 *   - .dylib → emulator dylib install (macOS only). Replaces any previously
 *             installed emulator and flips the emulator dev flag on.
 *   - anything else whose CONTENT is a PSBT (binary, base64 or hex; wallets use
 *             .psbt, .txn, .txt or no extension) → PsbtSignDialog via PSBT_DROP_EVENT
 *             (it hands a fully signed one on to BroadcastSignedDialog).
 *   - a signed raw transaction as hex text (Electrum's complete .txn) → BroadcastSignedDialog.
 *   - an Electrum wallet file or an extended public key → WatchOnlyImportDialog.
 *
 * Warning levels for firmware:
 * - Signed firmware: green badge, standard confirmation
 * - Unsigned firmware (device already unsigned): orange warning, developer-only notice
 * - Signed → Unsigned transition: RED double warning — "THIS WILL WIPE THE DEVICE"
 */
type FlashPhase = "idle" | "analyzing" | "confirm" | "flashing" | "complete" | "error" | "emu-installing" | "emu-starting" | "emu-installed"
// Platforms where the emulator (FFI library) can be installed + run.
const IS_EMU_PLATFORM = IS_MAC || IS_WINDOWS

/** Release notes grouped per minor version (7.14.0 and 7.14.1 under one
 *  "7.14" mark); the group holding the target version is the "new" one. */
function groupByMinor(versions: FirmwareVersionInfo[], target: string | null) {
	const minorOf = (v: string | null) => (v || "").split(".").slice(0, 2).join(".")
	const groups: Array<{ minor: string; isTarget: boolean; features: FirmwareFeature[] }> = []
	for (const v of versions) {
		const minor = minorOf(v.version)
		const last = groups[groups.length - 1]
		if (last && last.minor === minor) last.features.push(...v.features)
		else groups.push({ minor, isTarget: minor === minorOf(target), features: [...v.features] })
	}
	return groups
}

export function FirmwareDropZone() {
  const uiText = useUiTranslation()
  const { t: tSetup } = useTranslation("setup")

	const [isDragging, setIsDragging] = useState(false)
	const [phase, setPhase] = useState<FlashPhase>("idle")
	const [analysis, setAnalysis] = useState<FirmwareAnalysis | null>(null)
	const [fileName, setFileName] = useState("")
	const [fileDataB64, setFileDataB64] = useState("")
	const [progress, setProgress] = useState<FirmwareProgress | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [warningAcknowledged, setWarningAcknowledged] = useState(false)
	const [wipeAcknowledged, setWipeAcknowledged] = useState(false)
	const [backupConfirmed, setBackupConfirmed] = useState(false)
	const dragCounter = useRef(0)
	const phaseRef = useRef(phase)
	phaseRef.current = phase

	// Live device state — a KeepKey can ONLY be flashed while in bootloader
	// (updater) mode. Firmware-erase against a wallet-mode device stalls the HID
	// read and the flash appears to freeze mid-"do not unplug". Gate on the live
	// bootloader flag (not the analysis snapshot) so the flash button unlocks the
	// moment the user finishes entering bootloader mode.
	const deviceState = useDeviceState()
	const leftScroll = usePreflightScroll<HTMLDivElement>()
	const rightScroll = usePreflightScroll<HTMLDivElement>()
	const inBootloader = deviceState.bootloaderMode === true
	// An interrupted upload wipes the seed. Flashing happens in bootloader mode,
	// which can't report whether a wallet exists, so this fails closed (only a
	// device with no firmware on flash skips it).
	const needsBackupConfirm = requiresBackupConfirmation(deviceState, null)
	// Firmware 7.x on a 1.x bootloader. Judged from the LIVE bootloader version
	// (the analysis is a snapshot taken at drop time) so the check turns ok as
	// soon as an update lands; flashCustomFirmware refuses it again server-side.
	const liveBootloaderVersion = deviceState.bootloaderVersion || analysis?.deviceBootloaderVersion || null
	const bootloaderTooOld = !!analysis && bootloaderTooOldForFirmware({
		imageKind: analysis.imageKind,
		firmwareVersion: analysis.detectedVersion,
		bootloaderVersion: liveBootloaderVersion,
	})

	// The OFFICIAL bootloader update (same RPC as onboarding's bootloader step:
	// manifest blupdater, hash-checked) run from this dialog when the dropped
	// firmware needs a newer bootloader. The .bin stays loaded meanwhile.
	const [blUpdate, setBlUpdate] = useState<"idle" | "running" | "done" | "error">("idle")
	const [blProgress, setBlProgress] = useState<FirmwareProgress | null>(null)
	const [blError, setBlError] = useState<string | null>(null)
	const blUpdateRef = useRef(blUpdate)
	blUpdateRef.current = blUpdate
	// Did the upload stage actually run? A flow that "completes" without it
	// changed nothing on the device and must not read as success.
	const blUploadSeen = useRef(false)
	const blStartVersion = useRef<string | null>(null)
	const failBootloaderUpdate = useCallback((reason?: string | null) => {
		console.warn("[FlashDialog] bootloader update did not finish", reason || "")
		setBlError(reason || null)
		setBlUpdate("error")
	}, [])
	// Progress events drive the state as well as the RPC result: the RPC reply
	// can be lost across a webview reload while the device keeps going.
	useEffect(() => onRpcMessage("firmware-progress", (payload: FirmwareProgress) => {
		if (blUpdateRef.current !== "running" && blUpdateRef.current !== "done") return
		console.log(`[FlashDialog] bootloader update stage=${payload.stage ?? "?"} ${payload.percent}%${payload.error ? ` error=${payload.error}` : ""}`)
		setBlProgress(payload)
		if (payload.stage === "uploadBootloader" || payload.stage === "bootloaderUploaded") blUploadSeen.current = true
		if (payload.stage === "failed") failBootloaderUpdate(payload.error)
		else if (payload.percent >= 100 && blUpdateRef.current === "running") {
			if (blUploadSeen.current) setBlUpdate("done")
			else failBootloaderUpdate(null)
		}
	}), [failBootloaderUpdate])
	const handleBootloaderUpdate = useCallback(async () => {
		if (blUpdateRef.current === "running") return
		blUploadSeen.current = false
		blStartVersion.current = deviceState.bootloaderVersion || null
		console.log(`[FlashDialog] bootloader update start from v${blStartVersion.current ?? "?"}`)
		setBlUpdate("running"); setBlError(null)
		setBlProgress({ percent: 0, stage: "startingBootloader", message: "Starting bootloader update..." })
		try {
			await rpcRequest("startBootloaderUpdate", undefined, 0)
			// The ref may have moved on while awaiting (progress events).
			if ((blUpdateRef.current as string) === "running") {
				if (blUploadSeen.current) setBlUpdate("done")
				else failBootloaderUpdate(null)
			}
		} catch (err: any) {
			failBootloaderUpdate(err?.message || null)
		}
	}, [deviceState.bootloaderVersion, failBootloaderUpdate])
	// The updater is staged by the upload and installs the new bootloader on
	// the next normal boot, so coming back once on the SAME version is a normal
	// step (it asks to be reconnected). Only if it is still the same version a
	// while after that is the update treated as not finished.
	useEffect(() => {
		if (blUpdate !== "done" || !inBootloader) return
		if (deviceState.bootloaderVersion && deviceState.bootloaderVersion !== blStartVersion.current) return
		const timer = setTimeout(() => failBootloaderUpdate(null), 180_000)
		return () => clearTimeout(timer)
	}, [blUpdate, inBootloader, deviceState.bootloaderVersion, failBootloaderUpdate])
	// Whenever the update ends — new bootloader seen (even if the RPC reply was
	// lost), or not finished — re-read the same file in bootloader mode so every
	// row reflects the device as it is now, and drop acknowledgements given for
	// the old risk picture.
	const blFixed = !!analysis && !!deviceState.bootloaderVersion && !bootloaderTooOldForFirmware({ imageKind: analysis.imageKind, firmwareVersion: analysis.detectedVersion, bootloaderVersion: deviceState.bootloaderVersion })
	useEffect(() => {
		const settled = blUpdate === "error" || ((blUpdate === "running" || blUpdate === "done") && blFixed)
		if (!settled || !inBootloader || !fileDataB64) return
		let cancelled = false
		rpcRequest<FirmwareAnalysis>("analyzeFirmware", { data: fileDataB64 })
			.then(result => {
				if (cancelled) return
				console.log(`[FlashDialog] re-analyzed after bootloader update: device BL v${result.deviceBootloaderVersion ?? "?"}`)
				setAnalysis(result)
				setWarningAcknowledged(false)
				setWipeAcknowledged(false)
				if (blUpdateRef.current !== "error") { setBlUpdate("idle"); setBlProgress(null) }
			})
			.catch(() => { /* keep the dialog; the user can drop the file again */ })
		return () => { cancelled = true }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [blUpdate, blFixed, inBootloader, fileDataB64])

	// Listen for firmware progress — only react when THIS component initiated the flash (C1 fix)
	useEffect(() => {
		return onRpcMessage("firmware-progress", (payload: FirmwareProgress) => {
			if (phaseRef.current !== "flashing") return
			setProgress(payload)
			if (payload.percent >= 100) {
				setPhase("complete")
			}
		})
	}, [])

	// Global drag listeners
	useEffect(() => {
		const handleDragEnter = (e: DragEvent) => {
			e.preventDefault()
			e.stopPropagation()
			dragCounter.current++
			if (e.dataTransfer?.types.includes("Files")) {
				setIsDragging(true)
			}
		}
		const handleDragLeave = (e: DragEvent) => {
			e.preventDefault()
			e.stopPropagation()
			dragCounter.current--
			if (dragCounter.current <= 0) {
				dragCounter.current = 0
				setIsDragging(false)
			}
		}
		const handleDragOver = (e: DragEvent) => {
			e.preventDefault()
			e.stopPropagation()
		}
		const handleDrop = async (e: DragEvent) => {
			e.preventDefault()
			e.stopPropagation()
			dragCounter.current = 0
			setIsDragging(false)

			const files = e.dataTransfer?.files
			if (!files?.length) return

			const file = files[0]
			const lower = file.name.toLowerCase()
			if (/\.(png|jpe?g|webp|bmp)$/.test(lower)) {
				window.dispatchEvent(new CustomEvent(BITCOIN_QR_SCAN_EVENT, { detail: Array.from(files) }))
				return
			}
			if (lower.endsWith(".bin")) {
				await processFile(file)
				return
			}
			if (lower.endsWith(".dylib") || lower.endsWith(".dll")) {
				if (!IS_EMU_PLATFORM) {
					setError("Emulator is only available on macOS and Windows")
					setPhase("error")
					return
				}
				// Reject the wrong-OS library early (clearer than a dlopen failure).
				if (lower.endsWith(".dylib") && !IS_MAC) {
					setError("That's a macOS emulator (.dylib). On Windows, drop a libkkemu.dll")
					setPhase("error")
					return
				}
				if (lower.endsWith(".dll") && !IS_WINDOWS) {
					setError("That's a Windows emulator (.dll). On macOS, drop a libkkemu.dylib")
					setPhase("error")
					return
				}
				await processDylib(file)
				return
			}
			const head = new Uint8Array(await file.slice(0, PSBT_SNIFF_BYTES).arrayBuffer())
			if (looksLikePsbt(head)) {
				window.dispatchEvent(new CustomEvent(PSBT_DROP_EVENT, { detail: file }))
				return
			}
			if (looksLikeRawTxHex(head)) {
				window.dispatchEvent(new CustomEvent(BTC_BROADCAST_EVENT, { detail: file }))
				return
			}
			if(file.size<=1024*1024 && looksLikeMultisigPolicy(await file.text())) {
				window.dispatchEvent(new CustomEvent(MULTISIG_POLICY_EVENT,{detail:file}));return
			}
			if (looksLikeWatchOnlyImport(head)) {
				window.dispatchEvent(new CustomEvent(WATCH_ONLY_IMPORT_EVENT, { detail: file }))
				return
			}
			setError(IS_EMU_PLATFORM
				? `Only .bin firmware, ${IS_WINDOWS ? ".dll" : ".dylib"} emulator or Bitcoin PSBT files are supported`
				: "Only .bin firmware or Bitcoin PSBT files are supported")
			setPhase("error")
		}

		document.addEventListener("dragenter", handleDragEnter)
		document.addEventListener("dragleave", handleDragLeave)
		document.addEventListener("dragover", handleDragOver)
		document.addEventListener("drop", handleDrop)
		return () => {
			document.removeEventListener("dragenter", handleDragEnter)
			document.removeEventListener("dragleave", handleDragLeave)
			document.removeEventListener("dragover", handleDragOver)
			document.removeEventListener("drop", handleDrop)
		}
	}, [])

	const processDylib = useCallback(async (file: File) => {
		setPhase("emu-installing")
		setFileName(file.name)
		setError(null)
		try {
			const arrayBuf = await file.arrayBuffer()
			const bytes = new Uint8Array(arrayBuf)
			const CHUNK = 8192
			let binary = ''
			for (let i = 0; i < bytes.length; i += CHUNK) {
				binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
			}
			const b64 = btoa(binary)
			const installed = await rpcRequest<{ buildId: string }>("emulatorInstallDylib", { data: b64 }, 30000)
			// Backend auto-flips emulator_enabled when a dylib is installed; tell
			// the rest of the app to re-pull settings so DeviceGrid stops
			// short-circuiting emulator RPCs.
			window.dispatchEvent(new Event("keepkey-settings-changed"))

			// First-time install (no existing wallets) — auto-pair + boot a fresh
			// emulator so the device hits needs_init and the OOB wizard takes over.
			// Replacement install (wallets already on disk) — leave them as-is, just
			// confirm the swap. The user can Start any existing card from DeviceGrid.
			setPhase("emu-starting")
			try { await rpcRequest("emulatorPair", undefined, 10000) } catch { /* may already be paired */ }
			await rpcRequest("emulatorActivateBuild", { id: installed.buildId }, 30000)
			setPhase("idle")
		} catch (err: any) {
			setError(err?.message || "Failed to install emulator")
			setPhase("error")
		}
	}, [])

	const processFile = useCallback(async (file: File) => {
		setPhase("analyzing")
		setFileName(file.name)
		setError(null)
		setWarningAcknowledged(false)
		setWipeAcknowledged(false)

		try {
			const arrayBuf = await file.arrayBuffer()
			const bytes = new Uint8Array(arrayBuf)
			const CHUNK = 8192
			let binary = ''
			for (let i = 0; i < bytes.length; i += CHUNK) {
				binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
			}
			const b64 = btoa(binary)
			setFileDataB64(b64)

			const result = await rpcRequest<FirmwareAnalysis>("analyzeFirmware", { data: b64 })
			setAnalysis(result)
			setPhase("confirm")
		} catch (err: any) {
			setError(err?.message || "Failed to analyze firmware")
			setPhase("error")
		}
	}, [])

	const handleFlash = useCallback(async () => {
		if (!fileDataB64) return
		// Never start a flash unless the device is actually in bootloader mode —
		// otherwise firmwareErase hangs the HID read and looks like a freeze.
		if (!inBootloader) return
		if (bootloaderTooOld) return
		if (needsBackupConfirm && !analysis?.willWipeDevice && !backupConfirmed) return
		setPhase("flashing")
		setProgress({ percent: 0, message: "Starting firmware flash..." })
		try {
			// No timeout — user must confirm on device, can take as long as needed
			await rpcRequest("flashCustomFirmware", { data: fileDataB64 }, 0)
			// Progress events drive phase to "complete" via the firmware-progress listener
		} catch (err: any) {
			setError(err?.message || "Firmware flash failed")
			setPhase("error")
		}
	}, [fileDataB64, inBootloader, bootloaderTooOld, needsBackupConfirm, analysis, backupConfirmed])

	const handleDismiss = useCallback(() => {
		setPhase("idle")
		setAnalysis(null)
		setFileName("")
		setFileDataB64("")
		setError(null)
		setProgress(null)
		setWarningAcknowledged(false)
		setWipeAcknowledged(false)
		setBackupConfirmed(false)
		setBlUpdate("idle"); setBlProgress(null); setBlError(null)
	}, [])

	// Don't render anything when idle and not dragging
	if (phase === "idle" && !isDragging) return null

	// ── Drag overlay ──────────────────────────────────────────
	if (isDragging && phase === "idle") {
		return (
			<Box
				position="fixed"
				inset="0"
				bg="rgba(0,0,0,0.85)"
				zIndex={Z.overlay + 100}
				display="flex"
				alignItems="center"
				justifyContent="center"
			>
				<Flex
					direction="column"
					align="center"
					gap="4"
					p="12"
					borderRadius="2xl"
					border="3px dashed"
					borderColor="kk.gold"
					bg="rgba(233,196,106,0.08)"
					maxW="500px"
				>
					<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<polyline points="7 10 12 15 17 10" />
						<line x1="12" y1="15" x2="12" y2="3" />
					</svg>
					<Text fontSize="xl" fontWeight="700" color="kk.gold">{uiText("Drop File")}</Text>
					<Text fontSize="sm" color="kk.textSecondary" textAlign="center">
						{IS_EMU_PLATFORM
							? <>{uiText("Drop a Bitcoin PSBT to review and sign it, a")}{" "}<Text as="span" fontFamily="mono">{uiText(".bin")}</Text>{" "}{uiText("firmware to flash your KeepKey, or a")}{" "}<Text as="span" fontFamily="mono">{IS_WINDOWS ? uiText(".dll") : uiText(".dylib")}</Text>{" "}{uiText("to install an emulator.")}</>
							: <>{uiText("Drop a Bitcoin PSBT to review and sign it, or a")}{" "}<Text as="span" fontFamily="mono">{uiText(".bin")}</Text>{" "}{uiText("firmware file to flash your KeepKey. Signed and unsigned firmware supported.")}</>}
					</Text>
				</Flex>
			</Box>
		)
	}

	// ── Modal overlay for all other phases ─────────────────────
	return (
		<>
			<Box
				position="fixed"
				inset="0"
				bg="rgba(0,0,0,0.85)"
				zIndex={Z.overlay + 100}
				onClick={phase === "flashing" ? undefined : handleDismiss}
			/>
			<Box
				position="fixed"
				top="50%"
				left="50%"
				transform="translate(-50%, -50%)"
				w={phase === "confirm" ? "min(980px, 94vw)" : "480px"}
				maxW="94vw"
				maxH={phase === "confirm" ? "92vh" : "85vh"}
				overflowY="auto"
				display={phase === "confirm" ? "flex" : undefined}
				flexDirection="column"
				css={phase === "confirm" ? { "& > .kk-pf": { maxHeight: "92vh", minHeight: 0 } } : undefined}
				bg={phase === "confirm" ? "transparent" : "kk.bg"}
				border={phase === "confirm" ? "0" : "1px solid"}
				borderColor="kk.border"
				borderRadius={phase === "confirm" ? "18px" : "xl"}
				zIndex={Z.overlay + 101}
				role="dialog"
				aria-modal="true"
				aria-label={uiText("Firmware Flash")}
			>
				{/* ── Analyzing ─────────────────────────────── */}
				{phase === "analyzing" && (
					<Box p="8" textAlign="center">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="2">{uiText("Analyzing Firmware...")}</Text>
						<Text fontSize="sm" color="kk.textSecondary">{fileName}</Text>
					</Box>
				)}

				{/* ── Emulator dylib install (macOS-only dev feature) ─ */}
				{phase === "emu-installing" && (
					<Box p="8" textAlign="center">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="2">{uiText("Installing Emulator...")}</Text>
						<Text fontSize="sm" color="kk.textSecondary">{fileName}</Text>
					</Box>
				)}
				{phase === "emu-starting" && (
					<Box p="8" textAlign="center">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="2">{uiText("Starting Emulator...")}</Text>
						<Text fontSize="sm" color="kk.textSecondary">{uiText("Pairing with Keychain and booting your first emulator wallet.")}</Text>
					</Box>
				)}
				{phase === "emu-installed" && (
					<Box p="8" textAlign="center">
						<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 16px" }}>
							<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
							<polyline points="22 4 12 14.01 9 11.01" />
						</svg>
						<Text fontSize="lg" fontWeight="700" color="var(--teal)" mb="2">{uiText("Emulator Updated")}</Text>
						<Text fontSize="sm" color="kk.textSecondary" mb="4">{uiText("New libkkemu installed. Your existing emulator wallets are unchanged — start any of them from the device grid.")}</Text>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							px="4" py="2"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleDismiss}
						>{uiText("Done")}</Button>
					</Box>
				)}

				{/* ── Confirmation: preflight console ──────────
				    One surface, two columns. Left: what changes, what the device
				    will show, every risk as one preflight row (acknowledgements
				    live in their row), and the action. Right: release notes as a
				    timeline and the file/device facts. */}
				{phase === "confirm" && analysis && (() => {
					const isFirmware = analysis.imageKind === "firmware"
					const isUpdater = analysis.imageKind === "bootloader-updater"
					const notFlashable = !isFirmware && !isUpdater
					const fromVersion = isUpdater ? analysis.deviceBootloaderVersion : analysis.currentFirmwareVersion
					const toVersion = analysis.detectedVersion || "?.?.?"
					const rows: PreflightRow[] = []
					if (!inBootloader) rows.push({
						key: "bootloader-mode", status: "block", tag: uiText("blocks"),
						title: uiText("Put your KeepKey in bootloader mode"),
						detail: <>
							{uiText("Firmware can only be flashed from bootloader mode. Your device isn't in bootloader mode yet — follow these steps:")}
							<Box maxW="72px" my="2" opacity={0.85} dangerouslySetInnerHTML={{ __html: holdAndConnectRaw }} css={{ '& svg': { width: '100%', height: '100%' } }} />
							<ol className="kk-pf-steps">
								<li>{uiText("Unplug your KeepKey")}</li>
								<li>{uiText("Hold down the button on the device")}</li>
								<li>{uiText("While holding, plug in the USB cable")}</li>
								<li>{uiText("Release when the bootloader screen appears")}</li>
							</ol>
							<Flex align="center" gap="2" mt="2">
								<Spinner size="xs" color="var(--teal)" />
								<Text as="span" fontSize="12px" color="var(--teal)">{uiText("Waiting for your device to enter bootloader mode…")}</Text>
							</Flex>
						</>,
					})
					if (bootloaderTooOld) rows.push({
						key: "bootloader-old", status: "block", tag: uiText("blocks"),
						title: uiText("Bootloader {{version}} is too old", { version: liveBootloaderVersion || "" }),
						// After the upload the updater is only staged: it installs the new
						// bootloader on the next normal boot. Say so with onboarding's copy,
						// or a reconnect while holding the button just shows 1.x again.
						detail: blUpdate === "done" ? <>
							<Text as="span" display="block" fontWeight="600" color="var(--text-0)">{tSetup("bootloader.followDeviceTitle")}</Text>
							<Text as="span" display="block" mt="1">{tSetup("bootloader.followDeviceBody")}</Text>
							<Text as="span" display="block" mt="1" fontWeight="600" color="var(--gold)">{tSetup("bootloader.reconnectNoButton")}</Text>
						</> : blUpdate === "running" ? <>
							<Text as="span" display="block" fontWeight="600" color="var(--text-0)">{tSetup("bootloader.updatingBootloader")}</Text>
							<Box h="4px" my="2" bg="rgba(255,255,255,0.08)" borderRadius="full" overflow="hidden">
								<Box h="100%" w={`${blProgress?.percent ?? 0}%`} bg="var(--gold)" transition="width 0.3s" />
							</Box>
							<Text as="span" display="block">{firmwareProgressText(blProgress) || uiText("Please wait...")}</Text>
							{blUpdate === "running" && <Text as="span" display="block" color="var(--rose)" mt="1">{tSetup("bootloader.doNotUnplugBrick")}</Text>}
						</> : <>
							{uiText("Update it first. Firmware 7 needs bootloader 2.0 or newer.")}
							{blUpdate === "error" && <Text as="span" display="block" color="var(--rose)" mt="1">{uiText("Bootloader update didn't finish — your bootloader is unchanged.")}{blError ? ` ${blError}` : ""}</Text>}
						</>,
					})
					else if (isFirmware && liveBootloaderVersion && analysis.detectedVersion && /^7\./.test(analysis.detectedVersion)) rows.push({
						key: "bootloader-ok", status: "ok", title: uiText("Bootloader {{version}} is ready", { version: liveBootloaderVersion }),
					})
					if (notFlashable) rows.push({
						key: "not-flashable", status: "block", tag: uiText("blocks"),
						title: analysis.imageKind === "raw-bootloader" ? uiText("Raw bootloader image") : uiText("Unrecognized image"),
						detail: analysis.imageKind === "raw-bootloader"
							? uiText("The firmware updater would write this into the firmware area, not the bootloader. Bootloaders are installed with their bootloader updater (blupdater.bin).")
							: uiText("This is not a KeepKey firmware image or bootloader updater, so it cannot be flashed."),
					})
					if (analysis.willWipeDevice) rows.push({
						key: "wipe", status: "danger",
						title: analysis.wipeReason === "downgrade" ? uiText("This downgrade will wipe the device")
							: analysis.wipeReason === "bitcoin-only-lock" ? uiText("This will lock your Bitcoin-only wallet")
							: analysis.wipeReason === "unknown-installed" ? uiText("This may wipe the device")
							: analysis.wipeReason === "no-firmware" ? uiText("Any wallet on this KeepKey will be erased")
							: uiText("THIS WILL WIPE THE DEVICE"),
						detail: <>
							{analysis.wipeReason === "bitcoin-only-lock" ? (
								<p>{uiText("This KeepKey runs")}{" "}<b style={{ display: "inline" }}>{uiText("Bitcoin-only")}</b>{" "}{uiText("firmware")}{analysis.currentFirmwareVersion ? <> (v{analysis.currentFirmwareVersion})</> : null}. {analysis.isBitcoinOnly
									? <>{uiText("An older Bitcoin-only version")}</>
									: <>{uiText("Multi-coin firmware")}</>}{" "}{uiText("will")}{" "}<b style={{ display: "inline" }}>{uiText("refuse to open this wallet")}</b>{uiText(". It stays on the device, but you cannot use it until you reinstall the Bitcoin-only firmware")}{analysis.currentFirmwareVersion ? <> v{analysis.currentFirmwareVersion}{" "}{uiText("or newer")}</> : null}{uiText(", or wipe the device and restore it from your recovery phrase.")}</p>
							) : analysis.wipeReason === "unknown-installed" ? (
								<p>{uiText("KeepKey Desktop cannot tell which firmware is installed on this KeepKey, so it cannot rule out that this image")}{" "}<b style={{ display: "inline" }}>{uiText("erases all keys and settings")}</b>{" "}{uiText("or locks the wallet (for example, an older version, or switching between Bitcoin-only and multi-coin firmware). To let it check, start the KeepKey normally once (plug it in without holding the button) so KeepKey Desktop can read it, then return to bootloader mode and open this file again.")}</p>
							) : analysis.wipeReason === "no-firmware" ? (
								<p>{uiText("This KeepKey has no firmware installed (for example, after an interrupted update). If it held a wallet, flashing firmware")}{" "}<b style={{ display: "inline" }}>{uiText("erases all keys and settings")}</b>{uiText(", and you will restore it from your recovery phrase.")}</p>
							) : analysis.wipeReason === "downgrade" ? (
								<p>{uiText("You are installing")}{" "}<b style={{ display: "inline" }}>v{analysis.detectedVersion}</b>{" "}{uiText("over")}{" "}<b style={{ display: "inline" }}>v{analysis.currentFirmwareVersion}</b>{uiText(". Older firmware cannot read the newer wallet storage, so when it starts, your KeepKey")}{" "}<b style={{ display: "inline" }}>{uiText("erases all keys and settings")}</b>{uiText(". To use this wallet again you will restore it from your recovery phrase.")}</p>
							) : (
								<p>{uiText("You are crossing the")}{" "}<b style={{ display: "inline" }}>{uiText("signed/unsigned firmware boundary")}</b>.
									{analysis.isSigned
										? <>{" "}{uiText("Flashing")}{" "}<b style={{ display: "inline" }}>{uiText("signed (official) firmware")}</b>{" "}{uiText("onto a device running")}{" "}<b style={{ display: "inline" }}>{uiText("unsigned (developer) firmware")}</b>.</>
										: <>{" "}{uiText("Flashing")}{" "}<b style={{ display: "inline" }}>{uiText("unsigned firmware")}</b>{" "}{uiText("onto a device running")}{" "}<b style={{ display: "inline" }}>{uiText("signed (official) firmware")}</b>.</>}
									{" "}{uiText("This transition requires a full device wipe —")}{" "}<b style={{ display: "inline" }}>{uiText("all keys and settings will be permanently erased")}</b>.
								</p>
							)}
							<p>{uiText("Make sure you have your recovery seed backed up before proceeding.")}</p>
							<PreflightCheck checked={wipeAcknowledged} onChange={setWipeAcknowledged}>
								{analysis.wipeReason === "bitcoin-only-lock"
									? uiText("I understand my wallet will be locked and I have my seed backed up")
									: analysis.wipeReason === "unknown-installed" || analysis.wipeReason === "no-firmware"
										? uiText("I understand this may wipe my device and I have my seed backed up")
										: uiText("I understand this will wipe my device and I have my seed backed up")}
							</PreflightCheck>
						</>,
					})
					if (isUpdater) rows.push({
						key: "updater", status: analysis.embeddedBootloader?.official ? "warn" : "danger",
						title: analysis.embeddedBootloader?.official ? uiText("Bootloader update") : uiText("Unofficial bootloader"),
						detail: <>
							<p>{uiText("This is not firmware. It runs once and replaces the device's bootloader")}{analysis.embeddedBootloader?.version ? ` with v${analysis.embeddedBootloader.version}` : ""}{uiText(", then asks you to reconnect so you can install firmware.")}{analysis.embeddedBootloader?.official
								? uiText(" The bootloader is an official KeepKey release.")
								: uiText(" This bootloader is not an official KeepKey release: afterwards the device trusts only its signing keys, so official firmware will show as unofficial. Vault cannot restore the official bootloader. Use only on a test device.")}</p>
							<PreflightCheck checked={warningAcknowledged} onChange={setWarningAcknowledged}>
								{uiText("I understand this permanently replaces the bootloader")}
							</PreflightCheck>
						</>,
					})
					if (isFirmware && !analysis.isSigned && !analysis.willWipeDevice) rows.push({
						key: "unsigned", status: "warn", title: uiText("Developer Firmware"),
						detail: <>
							<p>{uiText("This is unsigned firmware intended for developers only. It may result in device state loss or unexpected behavior.")}</p>
							<PreflightCheck checked={warningAcknowledged} onChange={setWarningAcknowledged}>
								{uiText("I understand this is developer firmware")}
							</PreflightCheck>
						</>,
					})
					if (analysis.isDowngrade && analysis.wipeReason !== "downgrade") rows.push({
						key: "downgrade", status: "warn", title: uiText("Downgrade — older than current version"),
					})
					// The bootloader update interrupts the device too, so it needs the
					// same recovery-phrase confirmation the onboarding step asks for.
					if (needsBackupConfirm && (!analysis.willWipeDevice || bootloaderTooOld)) rows.push({
						key: "backup", status: "warn", title: uiText("Have your recovery phrase at hand"),
						detail: <PreflightCheck checked={backupConfirmed} onChange={setBackupConfirmed}>
							{uiText("I have my recovery phrase written down. If the flash is interrupted, the wallet on this KeepKey is erased and can only be restored from it.")}
						</PreflightCheck>,
					})
					if (isFirmware && analysis.isSigned) rows.push({ key: "signed", status: "ok", title: uiText("Signed by KeepKey") })
					if (analysis.isSameVersion) rows.push({ key: "same", status: "ok", title: uiText("Same version as currently installed") })
					if (analysis.isBitcoinOnly) rows.push({ key: "btc-only", status: "ok", title: uiText("Bitcoin-only") })
					if (analysis.hasKpkyHeader) rows.push({ key: "kpky", status: "ok", title: uiText("KPKY header detected") })

					// A too-old bootloader turns the main action into the official
					// bootloader update instead of a dead button.
					const blAction = bootloaderTooOld
					const blDisabled = !inBootloader || blUpdate === "running" || blUpdate === "done" || (needsBackupConfirm && !backupConfirmed)
					const goDisabled = !inBootloader
						|| bootloaderTooOld
						|| notFlashable
						|| (isUpdater && !warningAcknowledged)
						|| (analysis.willWipeDevice && !wipeAcknowledged)
						|| (!analysis.isSigned && !analysis.willWipeDevice && !warningAcknowledged)
						|| (needsBackupConfirm && !analysis.willWipeDevice && !backupConfirmed)
					const goLabel = !inBootloader
						? uiText("Enter bootloader mode first")
						: bootloaderTooOld
							? (blUpdate === "done" ? tSetup("bootloader.followDeviceTitle")
								: blUpdate === "running" ? tSetup("bootloader.updatingBootloader")
								: blUpdate === "error" ? tSetup("bootloader.tryAgain")
								: tSetup("bootloader.updateBootloaderTo", { version: deviceState.latestBootloader || "?" }))
							: analysis.imageKind === "bootloader-updater"
								? `Install Bootloader ${analysis.detectedVersion || ""}`.trim()
								: analysis.imageKind !== "firmware"
									? uiText("Cannot flash")
									: analysis.willWipeDevice
										? (analysis.wipeReason === "bitcoin-only-lock" || analysis.wipeReason === "unknown-installed" ? "Flash Anyway" : "Wipe & Flash")
										: `Flash ${analysis.detectedVersion || "Firmware"}`

					const versions = isFirmware && analysis.detectedVersion
						? (analysis.isBitcoinOnly ? [] : getUpgradeVersions(analysis.currentFirmwareVersion, analysis.detectedVersion))
						: []
					const oled = isUpdater
						? { line1: "BOOTLOADER UPDATE", line2: `v${toVersion}` }
						: isFirmware
							? (analysis.isSigned ? { line1: "KEEPKEY", line2: `v${toVersion}` } : { line1: "UNOFFICIAL FIRMWARE", line2: toVersion })
							: null

					return (
						<div className="kk-pf" role="group" aria-label={uiText("Firmware Flash")}>
							<PreflightStyles />
							<div className="kk-pf-left kk-pf-split">
								<div className="kk-pf-body kk-pf-scroll" ref={leftScroll}>
								<div className="kk-pf-kicker">
									{isUpdater ? uiText("Update Bootloader") : isFirmware ? uiText("Flash Firmware") : uiText("Not Flashable")}
								</div>
								<div className="kk-pf-vers" aria-label={uiText("From {{from}} to {{to}}", { from: fromVersion || "—", to: toVersion })}>
									{fromVersion && <span className="kk-pf-from">{fromVersion}</span>}
									<Beam />
									<span className="kk-pf-to">{toVersion}</span>
								</div>
								<div className="kk-pf-file">
									{fileName}{" · "}{(analysis.fileSize / 1024).toFixed(1)} KB{" · "}<span className="kk-pf-dim">{analysis.payloadHash.slice(0, 8)}…</span>
								</div>
								{oled && (
									<div className="kk-pf-device">
										<SpinningDevice motion="still" scale={0.66} screen={<OledText kicker={oled.line1} headline={oled.line2} />} />
										<div className="kk-pf-cap">{isFirmware && !analysis.isSigned ? uiText("What your KeepKey will show at every start") : uiText("What your KeepKey will show")}</div>
									</div>
								)}
								<PreflightList rows={rows} />
								</div>
								<div className="kk-pf-foot">
								<PreflightActions
									cancelLabel={uiText("Cancel")}
									onCancel={handleDismiss}
									goLabel={goLabel}
									onGo={blAction ? handleBootloaderUpdate : handleFlash}
									goDisabled={blAction ? blDisabled : goDisabled}
									danger={!blAction && analysis.willWipeDevice && !goDisabled}
								/>
								</div>
							</div>
							<div className="kk-pf-right kk-pf-scroll" ref={rightScroll}>
								{(versions.length > 0 || (isFirmware && analysis.isBitcoinOnly)) && (
									<div className="kk-pf-tl">
										{analysis.isBitcoinOnly ? (
											<>
												<TimelineMark big={toVersion} small={uiText("new")} />
												<TimelineItem node={<ChainNode chainId={BTC_ONLY_FEATURE.chains?.[0]} color={BTC_ONLY_FEATURE.color} />} title={BTC_ONLY_FEATURE.title}>
													{BTC_ONLY_FEATURE.description}
												</TimelineItem>
											</>
										) : groupByMinor(versions, analysis.detectedVersion).map(g => (
											<Fragment key={g.minor}>
												<TimelineMark big={g.minor} small={g.isTarget ? uiText("new") : uiText("included")} />
												{g.features.map(f => (
													<TimelineItem key={f.title}
														node={<ChainNode chainId={f.chains?.[0]} color={f.color} glyph={f.icon === "security" ? "security" : f.icon === "performance" ? "performance" : "feature"} />}
														title={f.short?.title ?? f.title}
														soonLabel={f.comingSoon ? uiText("soon") : undefined}>
														{f.short?.description ?? f.description}
													</TimelineItem>
												))}
											</Fragment>
										))}
									</div>
								)}
								<dl className="kk-pf-facts" style={{ marginTop: "auto" }}>
									{analysis.isBootloaderMode ? (
										<>
											<div><dt>{uiText("Device status")}</dt><dd>BOOTLOADER{analysis.deviceBootloaderVersion ? ` v${analysis.deviceBootloaderVersion}` : ""}</dd></div>
											{analysis.currentFirmwareVersion && (
												<div><dt>{uiText("Installed firmware")}</dt><dd>
													v{analysis.currentFirmwareVersion}
													{analysis.currentFirmwareVerified === true && <> {uiText("(official)")}</>}
													{analysis.currentFirmwareVerified === false && <> {uiText("(unofficial)")}</>}
												</dd></div>
											)}
										</>
									) : (
										<div><dt>{uiText("Device firmware")}</dt><dd>
											v{analysis.currentFirmwareVersion || uiText("Unknown")}
											{analysis.currentFirmwareVerified === true && <> {uiText("(verified)")}</>}
											{analysis.currentFirmwareVerified === false && <> {uiText("(unverified)")}</>}
										</dd></div>
									)}
									<div><dt>{isFirmware ? uiText("Flashing to") : uiText("Bootloader in image")}</dt><dd>v{toVersion}</dd></div>
									{analysis.embeddedBootloader && (
										<div><dt>{uiText("Bootloader hash")}</dt><dd>
											{analysis.embeddedBootloader.hash.slice(0, 16)}… {analysis.embeddedBootloader.official ? uiText("official release") : uiText("NOT an official release")}
										</dd></div>
									)}
									<div><dt>{uiText("Size")}</dt><dd>{(analysis.fileSize / 1024).toFixed(1)} KB</dd></div>
									<div><dt>{uiText("Payload hash")}</dt><dd>{analysis.payloadHash.slice(0, 16)}…</dd></div>
								</dl>
							</div>
						</div>
					)
				})()}

				{/* ── Flashing progress ─────────────────────── */}
				{phase === "flashing" && (
					<Box p="8">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="4" textAlign="center">{uiText("Flashing Firmware...")}</Text>
						<Box
							w="100%"
							h="8px"
							bg="rgba(255,255,255,0.06)"
							borderRadius="full"
							overflow="hidden"
							mb="3"
						>
							<Box
								h="100%"
								w={`${progress?.percent || 0}%`}
								bg="kk.gold"
								borderRadius="full"
								transition="width 0.3s"
							/>
						</Box>
						<Text fontSize="sm" color="kk.textSecondary" textAlign="center">
							{firmwareProgressText(progress) || uiText("Please wait...")}
						</Text>
						<Text fontSize="xs" color="kk.textSecondary" textAlign="center" mt="2">{uiText("Do not unplug your KeepKey")}</Text>
					</Box>
				)}

				{/* ── Complete ──────────────────────────────── */}
				{phase === "complete" && (
					<Box p="8" textAlign="center" border="1px solid" borderColor="var(--teal)" borderRadius="xl">
						<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 16px" }}>
							<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
							<polyline points="22 4 12 14.01 9 11.01" />
						</svg>
						<Text fontSize="lg" fontWeight="700" color="var(--teal)" mb="2">{uiText("Firmware Flash Complete")}</Text>
						<Text fontSize="sm" color="kk.gold" fontWeight="600" mb="2">{uiText("Unplug your KeepKey and plug it back in to finish.")}</Text>
						<Text fontSize="sm" color="kk.textSecondary" mb="2">{uiText("The device does not reboot on its own — it stays in this state until you physically reconnect the USB cable.")}</Text>
						<Text fontSize="xs" color="kk.textSecondary" mb="4">{uiText("Do not hold the button while reconnecting — just plug it in normally, or it will re-enter bootloader mode.")}</Text>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							px="4" py="2"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleDismiss}
						>{uiText("Done")}</Button>
					</Box>
				)}

				{/* ── Error ─────────────────────────────────── */}
				{phase === "error" && (
					<Box p="8" textAlign="center">
						<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 16px" }}>
							<circle cx="12" cy="12" r="10" />
							<line x1="15" y1="9" x2="9" y2="15" />
							<line x1="9" y1="9" x2="15" y2="15" />
						</svg>
						<Text fontSize="lg" fontWeight="700" color="var(--rose)" mb="2">{uiText("Firmware Flash Failed")}</Text>
						<Text fontSize="sm" color="kk.textSecondary" mb="4">
							{error || uiText("Unknown error")}
						</Text>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							px="4" py="2"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleDismiss}
						>{uiText("Dismiss")}</Button>
					</Box>
				)}
			</Box>
		</>
	)
}
