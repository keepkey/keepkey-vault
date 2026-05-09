import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { FirmwareAnalysis, FirmwareProgress } from "../../shared/types"
import { FirmwareUpgradePreview } from "./FirmwareUpgradePreview"

/**
 * FirmwareDropZone — Global drag-and-drop dispatcher.
 *
 * Renders nothing when idle. Detects file type on drop:
 *   - .bin  → firmware analysis + flash flow (signed/unsigned, version compare).
 *   - .dylib → emulator dylib install (macOS only). Replaces any previously
 *             installed emulator and flips the emulator dev flag on.
 *
 * Warning levels for firmware:
 * - Signed firmware: green badge, standard confirmation
 * - Unsigned firmware (device already unsigned): orange warning, developer-only notice
 * - Signed → Unsigned transition: RED double warning — "THIS WILL WIPE THE DEVICE"
 */
type FlashPhase = "idle" | "analyzing" | "confirm" | "flashing" | "complete" | "error" | "emu-installing" | "emu-starting" | "emu-installed"
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')

export function FirmwareDropZone() {
	const [isDragging, setIsDragging] = useState(false)
	const [phase, setPhase] = useState<FlashPhase>("idle")
	const [analysis, setAnalysis] = useState<FirmwareAnalysis | null>(null)
	const [fileName, setFileName] = useState("")
	const [fileDataB64, setFileDataB64] = useState("")
	const [progress, setProgress] = useState<FirmwareProgress | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [warningAcknowledged, setWarningAcknowledged] = useState(false)
	const [wipeAcknowledged, setWipeAcknowledged] = useState(false)
	const dragCounter = useRef(0)
	const phaseRef = useRef(phase)
	phaseRef.current = phase

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
			if (lower.endsWith(".bin")) {
				await processFile(file)
				return
			}
			if (lower.endsWith(".dylib")) {
				if (!IS_MAC) {
					setError("Emulator is only available on macOS")
					setPhase("error")
					return
				}
				await processDylib(file)
				return
			}
			setError(IS_MAC
				? "Only .bin firmware or .dylib emulator files are supported"
				: "Only .bin firmware files are supported")
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
			await rpcRequest("emulatorInstallDylib", { data: b64 }, 30000)
			// Backend auto-flips emulator_enabled when a dylib is installed; tell
			// the rest of the app to re-pull settings so DeviceGrid stops
			// short-circuiting emulator RPCs.
			window.dispatchEvent(new Event("keepkey-settings-changed"))

			// First-time install (no existing wallets) — auto-pair + boot a fresh
			// emulator so the device hits needs_init and the OOB wizard takes over.
			// Replacement install (wallets already on disk) — leave them as-is, just
			// confirm the swap. The user can Start any existing card from DeviceGrid.
			const wallets = await rpcRequest<Array<{ name: string }>>("emulatorListWallets").catch(() => [])
			if (wallets.length === 0) {
				setPhase("emu-starting")
				try { await rpcRequest("emulatorPair", undefined, 10000) } catch { /* may already be paired */ }
				await rpcRequest("emulatorInit", { flashName: "default" }, 30000)
				// Engine.connectEmulator() flips device state to needs_init; App.tsx
				// transitions phase to 'setup' which mounts OobSetupWizard. Drop our
				// own dialog so the wizard isn't covered.
				setPhase("idle")
				return
			}
			setPhase("emu-installed")
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
	}, [fileDataB64])

	const handleDismiss = useCallback(() => {
		setPhase("idle")
		setAnalysis(null)
		setFileName("")
		setFileDataB64("")
		setError(null)
		setProgress(null)
		setWarningAcknowledged(false)
		setWipeAcknowledged(false)
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
					<Text fontSize="xl" fontWeight="700" color="kk.gold">
						Drop File
					</Text>
					<Text fontSize="sm" color="kk.textSecondary" textAlign="center">
						{IS_MAC
							? <>Drop a <Text as="span" fontFamily="mono">.bin</Text> firmware to flash your KeepKey,
							   or a <Text as="span" fontFamily="mono">.dylib</Text> to install an emulator.</>
							: <>Drop a <Text as="span" fontFamily="mono">.bin</Text> firmware file to flash your KeepKey.
							   Signed and unsigned firmware supported.</>}
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
				w="480px"
				maxW="90vw"
				maxH="85vh"
				overflowY="auto"
				bg="kk.bg"
				border="1px solid"
				borderColor="kk.border"
				borderRadius="xl"
				zIndex={Z.overlay + 101}
				role="dialog"
				aria-modal="true"
				aria-label="Firmware Flash"
			>
				{/* ── Analyzing ─────────────────────────────── */}
				{phase === "analyzing" && (
					<Box p="8" textAlign="center">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="2">
							Analyzing Firmware...
						</Text>
						<Text fontSize="sm" color="kk.textSecondary">{fileName}</Text>
					</Box>
				)}

				{/* ── Emulator dylib install (macOS-only dev feature) ─ */}
				{phase === "emu-installing" && (
					<Box p="8" textAlign="center">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="2">
							Installing Emulator...
						</Text>
						<Text fontSize="sm" color="kk.textSecondary">{fileName}</Text>
					</Box>
				)}
				{phase === "emu-starting" && (
					<Box p="8" textAlign="center">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="2">
							Starting Emulator...
						</Text>
						<Text fontSize="sm" color="kk.textSecondary">
							Pairing with Keychain and booting your first emulator wallet.
						</Text>
					</Box>
				)}
				{phase === "emu-installed" && (
					<Box p="8" textAlign="center">
						<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#48BB78" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 16px" }}>
							<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
							<polyline points="22 4 12 14.01 9 11.01" />
						</svg>
						<Text fontSize="lg" fontWeight="700" color="#48BB78" mb="2">
							Emulator Updated
						</Text>
						<Text fontSize="sm" color="kk.textSecondary" mb="4">
							New libkkemu installed. Your existing emulator wallets are unchanged —
							start any of them from the device grid.
						</Text>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							px="4" py="2"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleDismiss}
						>
							Done
						</Button>
					</Box>
				)}

				{/* ── Confirmation ──────────────────────────── */}
				{phase === "confirm" && analysis && (
					<Box>
						{/* Header */}
						<Box px="6" pt="5" pb="4" borderBottom="1px solid" borderColor="kk.border">
							<Flex align="center" gap="2" mb="1">
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={analysis.isSigned ? "#48BB78" : "#ED8936"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
									<path d="M16 7V5a4 4 0 0 0-8 0v2" />
								</svg>
								<Text fontSize="md" fontWeight="700" color="kk.textPrimary">
									Flash Firmware
								</Text>
							</Flex>
							<Text fontSize="xs" color="kk.textSecondary" fontFamily="mono">
								{fileName}
							</Text>
						</Box>

						{/* Analysis details */}
						<Box px="6" py="4">
							<Flex direction="column" gap="3">
								{/* Signed/Unsigned badge */}
								<Flex align="center" gap="2">
									<Box
										px="2" py="0.5"
										borderRadius="md"
										fontSize="xs"
										fontWeight="700"
										letterSpacing="0.05em"
										bg={analysis.isSigned ? "rgba(72,187,120,0.15)" : "rgba(237,137,54,0.15)"}
										color={analysis.isSigned ? "#48BB78" : "#ED8936"}
									>
										{analysis.isSigned ? "SIGNED" : "UNSIGNED"}
									</Box>
									{analysis.hasKpkyHeader && (
										<Text fontSize="xs" color="kk.textSecondary">KPKY header detected</Text>
									)}
								</Flex>

								{/* Version info */}
								<Box
									bg="rgba(255,255,255,0.03)"
									borderRadius="lg"
									border="1px solid"
									borderColor="kk.border"
									p="3"
								>
									{/* Device status — bootloader mode vs. firmware */}
									{analysis.isBootloaderMode ? (
										<>
											<Flex justify="space-between" mb="2">
												<Text fontSize="xs" color="kk.textSecondary">Device status</Text>
												<Flex align="center" gap="1.5">
													<Box px="1.5" py="0.5" borderRadius="sm" bg="rgba(99,179,237,0.15)" fontSize="xs" fontWeight="700" color="#63B3ED">
														BOOTLOADER
													</Box>
													{analysis.deviceBootloaderVersion && (
														<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" fontFamily="mono">
															v{analysis.deviceBootloaderVersion}
														</Text>
													)}
												</Flex>
											</Flex>
										</>
									) : (
										<Flex justify="space-between" mb="2">
											<Text fontSize="xs" color="kk.textSecondary">Device firmware</Text>
											<Flex align="center" gap="1.5">
												<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" fontFamily="mono">
													v{analysis.currentFirmwareVersion || "Unknown"}
												</Text>
												{analysis.currentFirmwareVerified === true && (
													<Box as="span" color="#48BB78" fontSize="xs">(verified)</Box>
												)}
												{analysis.currentFirmwareVerified === false && (
													<Box as="span" color="#ED8936" fontSize="xs">(unverified)</Box>
												)}
											</Flex>
										</Flex>
									)}
									<Flex justify="space-between" align="center">
										<Text fontSize="xs" color="kk.textSecondary">Flashing to</Text>
										<Text fontSize="sm" fontWeight="600" color="kk.gold" fontFamily="mono">
											v{analysis.detectedVersion || "?.?.?"}
										</Text>
									</Flex>
									{analysis.isSameVersion && (
										<Text fontSize="xs" color="kk.textSecondary" mt="1">
											Same version as currently installed
										</Text>
									)}
									{analysis.isDowngrade && (
										<Text fontSize="xs" color="#ED8936" mt="1">
											Downgrade — older than current version
										</Text>
									)}
								</Box>

								{/* File info */}
								<Flex justify="space-between" px="1">
									<Text fontSize="xs" color="kk.textSecondary">Size</Text>
									<Text fontSize="xs" color="kk.textSecondary" fontFamily="mono">
										{(analysis.fileSize / 1024).toFixed(1)} KB
									</Text>
								</Flex>
								<Flex justify="space-between" px="1">
									<Text fontSize="xs" color="kk.textSecondary">Payload hash</Text>
									<Text fontSize="xs" color="kk.textSecondary" fontFamily="mono" maxW="200px" overflow="hidden" textOverflow="ellipsis">
										{analysis.payloadHash.slice(0, 16)}...
									</Text>
								</Flex>
							</Flex>
						</Box>

						{/* ── Release notes for this firmware version ── */}
						{analysis.detectedVersion && (
							<Box mx="6" mb="3">
								<FirmwareUpgradePreview
									currentVersion={analysis.currentFirmwareVersion}
									targetVersion={analysis.detectedVersion}
								/>
							</Box>
						)}

						{/* ── DOUBLE WARNING: Signed → Unsigned (WILL WIPE) ── */}
						{analysis.willWipeDevice && (
							<Box
								mx="6" mb="3" p="4"
								bg="rgba(229,62,62,0.1)"
								border="2px solid"
								borderColor="#E53E3E"
								borderRadius="lg"
							>
								<Flex align="center" gap="2" mb="2">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E53E3E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
										<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
										<line x1="12" y1="9" x2="12" y2="13" />
										<line x1="12" y1="17" x2="12.01" y2="17" />
									</svg>
									<Text fontSize="sm" fontWeight="800" color="#E53E3E" textTransform="uppercase" letterSpacing="0.05em">
										THIS WILL WIPE THE DEVICE
									</Text>
								</Flex>
								<Text fontSize="sm" color="#FC8181" lineHeight="1.6" mb="3">
									You are crossing the <Text as="span" fontWeight="700">signed/unsigned firmware boundary</Text>.
									{analysis.isSigned
										? <> Flashing <Text as="span" fontWeight="700">signed (official) firmware</Text> onto a device running <Text as="span" fontWeight="700">unsigned (developer) firmware</Text>.</>
										: <> Flashing <Text as="span" fontWeight="700">unsigned firmware</Text> onto a device running <Text as="span" fontWeight="700">signed (official) firmware</Text>.</>
									}
									{' '}This transition requires a full device wipe — <Text as="span" fontWeight="700">all keys and
									settings will be permanently erased</Text>.
								</Text>
								<Text fontSize="sm" color="#FC8181" lineHeight="1.6" mb="3">
									Make sure you have your recovery seed backed up before proceeding.
								</Text>
								<Flex
									as="label"
									align="center"
									gap="2"
									cursor="pointer"
									userSelect="none"
									onClick={() => setWipeAcknowledged(!wipeAcknowledged)}
								>
									<Box
										w="18px" h="18px"
										borderRadius="sm"
										border="2px solid"
										borderColor={wipeAcknowledged ? "#E53E3E" : "#FC8181"}
										bg={wipeAcknowledged ? "#E53E3E" : "transparent"}
										display="flex"
										alignItems="center"
										justifyContent="center"
										flexShrink={0}
									>
										{wipeAcknowledged && (
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
												<polyline points="20 6 9 17 4 12" />
											</svg>
										)}
									</Box>
									<Text fontSize="xs" fontWeight="600" color="#FC8181">
										I understand this will wipe my device and I have my seed backed up
									</Text>
								</Flex>
							</Box>
						)}

						{/* ── SINGLE WARNING: Unsigned firmware (developer only) ── */}
						{!analysis.isSigned && !analysis.willWipeDevice && (
							<Box
								mx="6" mb="3" p="4"
								bg="rgba(237,137,54,0.1)"
								border="1px solid"
								borderColor="#ED8936"
								borderRadius="lg"
							>
								<Flex align="center" gap="2" mb="2">
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ED8936" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
										<line x1="12" y1="9" x2="12" y2="13" />
										<line x1="12" y1="17" x2="12.01" y2="17" />
									</svg>
									<Text fontSize="sm" fontWeight="700" color="#ED8936">
										Developer Firmware
									</Text>
								</Flex>
								<Text fontSize="sm" color="#F6AD55" lineHeight="1.6" mb="3">
									This is unsigned firmware intended for developers only.
									It may result in device state loss or unexpected behavior.
								</Text>
								<Flex
									as="label"
									align="center"
									gap="2"
									cursor="pointer"
									userSelect="none"
									onClick={() => setWarningAcknowledged(!warningAcknowledged)}
								>
									<Box
										w="18px" h="18px"
										borderRadius="sm"
										border="2px solid"
										borderColor={warningAcknowledged ? "#ED8936" : "#F6AD55"}
										bg={warningAcknowledged ? "#ED8936" : "transparent"}
										display="flex"
										alignItems="center"
										justifyContent="center"
										flexShrink={0}
									>
										{warningAcknowledged && (
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
												<polyline points="20 6 9 17 4 12" />
											</svg>
										)}
									</Box>
									<Text fontSize="xs" fontWeight="600" color="#F6AD55">
										I understand this is developer firmware
									</Text>
								</Flex>
							</Box>
						)}

						{/* Actions */}
						<Flex
							px="6" py="4" gap="3"
							justify="flex-end"
							borderTop="1px solid"
							borderColor="kk.border"
							bg="rgba(255,255,255,0.02)"
						>
							<Button
								size="sm"
								variant="ghost"
								color="kk.textSecondary"
								px="4" py="2"
								_hover={{ color: "kk.textPrimary" }}
								onClick={handleDismiss}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								bg={analysis.willWipeDevice ? "#E53E3E" : analysis.isSigned ? "kk.gold" : "#ED8936"}
								color={analysis.willWipeDevice ? "white" : "black"}
								fontWeight="700"
								px="4" py="2"
								_hover={{
									bg: analysis.willWipeDevice ? "#C53030" : analysis.isSigned ? "kk.goldHover" : "#DD6B20",
								}}
								onClick={handleFlash}
								disabled={
									(analysis.willWipeDevice && !wipeAcknowledged)
									|| (!analysis.isSigned && !analysis.willWipeDevice && !warningAcknowledged)
								}
							>
								{analysis.willWipeDevice
									? "Wipe & Flash"
									: `Flash ${analysis.detectedVersion || "Firmware"}`}
							</Button>
						</Flex>
					</Box>
				)}

				{/* ── Flashing progress ─────────────────────── */}
				{phase === "flashing" && (
					<Box p="8">
						<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="4" textAlign="center">
							Flashing Firmware...
						</Text>
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
							{progress?.message || "Please wait..."}
						</Text>
						<Text fontSize="xs" color="kk.textSecondary" textAlign="center" mt="2">
							Do not unplug your KeepKey
						</Text>
					</Box>
				)}

				{/* ── Complete ──────────────────────────────── */}
				{phase === "complete" && (
					<Box p="8" textAlign="center" border="1px solid" borderColor="#48BB78" borderRadius="xl">
						<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#48BB78" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 16px" }}>
							<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
							<polyline points="22 4 12 14.01 9 11.01" />
						</svg>
						<Text fontSize="lg" fontWeight="700" color="#48BB78" mb="2">
							Firmware Flash Complete
						</Text>
						<Text fontSize="sm" color="kk.textSecondary" mb="4">
							Your KeepKey is rebooting with the new firmware.
							It will reconnect automatically.
						</Text>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							px="4" py="2"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleDismiss}
						>
							Done
						</Button>
					</Box>
				)}

				{/* ── Error ─────────────────────────────────── */}
				{phase === "error" && (
					<Box p="8" textAlign="center">
						<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E53E3E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 16px" }}>
							<circle cx="12" cy="12" r="10" />
							<line x1="15" y1="9" x2="9" y2="15" />
							<line x1="9" y1="9" x2="15" y2="15" />
						</svg>
						<Text fontSize="lg" fontWeight="700" color="#E53E3E" mb="2">
							Firmware Flash Failed
						</Text>
						<Text fontSize="sm" color="kk.textSecondary" mb="4">
							{error || "Unknown error"}
						</Text>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							px="4" py="2"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleDismiss}
						>
							Dismiss
						</Button>
					</Box>
				)}
			</Box>
		</>
	)
}
