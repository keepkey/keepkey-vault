import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, VStack, Button, Input, IconButton } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { DeviceStateInfo, AppSettings } from "../../shared/types"

interface DeviceFeatures {
	label?: string
	pinProtection?: boolean
	passphraseProtection?: boolean
	u2fCounter?: number
}

interface DeviceSettingsDrawerProps {
	open: boolean
	onClose: () => void
	deviceState: DeviceStateInfo
}

// ── Collapsible Section ─────────────────────────────────────────────

function Section({ title, color, defaultOpen = true, children }: {
	title: string
	color?: string
	defaultOpen?: boolean
	children: React.ReactNode
}) {
	const [open, setOpen] = useState(defaultOpen)
	return (
		<Box bg="kk.cardBg" border="1px solid" borderColor={color === "kk.error" ? "kk.error" : "kk.border"} borderRadius="xl" overflow="hidden">
			<Flex
				as="button"
				align="center"
				justify="space-between"
				w="100%"
				px="5"
				py="3"
				cursor="pointer"
				onClick={() => setOpen(o => !o)}
				_hover={{ bg: "rgba(255,255,255,0.02)" }}
				borderBottom={open ? "1px solid" : "none"}
				borderColor="kk.border"
			>
				<Text fontSize="md" fontWeight="600" color={color || "kk.gold"}>{title}</Text>
				<svg
					width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
					strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
					style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "var(--chakra-colors-kk-textSecondary)" }}
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</Flex>
			{open && <Box px="5" py="4">{children}</Box>}
		</Box>
	)
}

// ── Toggle Switch ───────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
	return (
		<Box
			as="button"
			role="switch"
			aria-checked={checked}
			onClick={() => !disabled && onChange(!checked)}
			w="40px"
			h="22px"
			borderRadius="full"
			bg={checked ? "kk.gold" : "kk.border"}
			position="relative"
			transition="background 0.2s"
			cursor={disabled ? "not-allowed" : "pointer"}
			opacity={disabled ? 0.5 : 1}
			flexShrink={0}
		>
			<Box
				position="absolute"
				top="2px"
				left={checked ? "20px" : "2px"}
				w="18px"
				h="18px"
				borderRadius="full"
				bg="white"
				transition="left 0.2s"
				boxShadow="0 1px 3px rgba(0,0,0,0.3)"
			/>
		</Box>
	)
}

// ── Verification Badge ──────────────────────────────────────────────

function VerificationBadge({ verified }: { verified?: boolean }) {
	if (verified === undefined) return null
	if (verified) {
		return (
			<Flex align="center" gap="1">
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
					<circle cx="12" cy="12" r="10" fill="#22C55E" />
					<path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
				<Text fontSize="9px" color="#22C55E" fontWeight="600">Official</Text>
			</Flex>
		)
	}
	return (
		<Flex align="center" gap="1">
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
				<path d="M12 2L1 21h22L12 2z" fill="#FB923C" />
				<path d="M12 9v4M12 17h.01" stroke="white" strokeWidth="2" strokeLinecap="round" />
			</svg>
			<Text fontSize="9px" color="#FB923C" fontWeight="600">Unknown</Text>
		</Flex>
	)
}

// ── Main Component ──────────────────────────────────────────────────

export function DeviceSettingsDrawer({ open, onClose, deviceState }: DeviceSettingsDrawerProps) {
	const [features, setFeatures] = useState<DeviceFeatures | null>(null)
	const [featuresError, setFeaturesError] = useState(false)
	const [label, setLabel] = useState(deviceState.label || "")
	const [saving, setSaving] = useState(false)
	const [labelSaved, setLabelSaved] = useState(false)
	const [pinging, setPinging] = useState(false)
	const [pingResult, setPingResult] = useState("")
	const [wiping, setWiping] = useState(false)
	const [wipeConfirm, setWipeConfirm] = useState(false)
	const [verifying, setVerifying] = useState(false)
	const [verifyResult, setVerifyResult] = useState<{ success: boolean; message: string } | null>(null)
	const [verifyWordCount, setVerifyWordCount] = useState<12 | 18 | 24>(12)
	const [changingPin, setChangingPin] = useState(false)
	const [removingPin, setRemovingPin] = useState(false)
	const [removePinConfirm, setRemovePinConfirm] = useState(false)
	const [togglingPassphrase, setTogglingPassphrase] = useState(false)
	const [appSettings, setAppSettings] = useState<AppSettings>({ restApiEnabled: false })
	const [togglingRest, setTogglingRest] = useState(false)
	const panelRef = useRef<HTMLDivElement>(null)

	// Fetch device features + app settings when drawer opens
	useEffect(() => {
		if (!open) return
		if (deviceState.state === "ready") {
			setFeaturesError(false)
			rpcRequest<DeviceFeatures>("getFeatures")
				.then(setFeatures)
				.catch(() => setFeaturesError(true))
		}
		rpcRequest<AppSettings>("getAppSettings")
			.then(setAppSettings)
			.catch(() => {})
	}, [open, deviceState.state])

	useEffect(() => { setLabel(deviceState.label || "") }, [deviceState.label])
	useEffect(() => { if (!open) { setWipeConfirm(false); setRemovePinConfirm(false) } }, [open])

	// Escape key closes drawer
	useEffect(() => {
		if (!open) return
		const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [open, onClose])

	useEffect(() => { if (open) panelRef.current?.focus() }, [open])

	// ── Handlers ────────────────────────────────────────────────────

	const saveLabel = useCallback(async () => {
		if (!label.trim()) return
		setSaving(true)
		try {
			await rpcRequest("applySettings", { label: label.trim() }, 60000)
			setLabelSaved(true)
			setTimeout(() => setLabelSaved(false), 2000)
		} catch (e: any) { console.error("applySettings:", e) }
		setSaving(false)
	}, [label])

	const pingDevice = useCallback(async () => {
		setPinging(true)
		try {
			const result = await rpcRequest("ping", { msg: "Hello KeepKey!" }, 10000)
			setPingResult(typeof result === "string" ? result : "Pong!")
			setTimeout(() => setPingResult(""), 3000)
		} catch {
			setPingResult("Ping failed")
			setTimeout(() => setPingResult(""), 3000)
		}
		setPinging(false)
	}, [])

	const verifySeed = useCallback(async () => {
		setVerifying(true)
		setVerifyResult(null)
		try {
			const result = await rpcRequest("verifySeed", { wordCount: verifyWordCount }, 600000) as { success: boolean; message: string }
			setVerifyResult(result)
		} catch (e: any) {
			const msg = typeof e?.message === "string" ? e.message : "Verification failed"
			setVerifyResult({ success: false, message: msg })
		}
		setVerifying(false)
	}, [verifyWordCount])

	const wipeDevice = useCallback(async () => {
		setWiping(true)
		try {
			await rpcRequest("wipeDevice", undefined, 60000)
		} catch (e: any) { console.error("wipeDevice:", e) }
		setWiping(false)
		setWipeConfirm(false)
		onClose()
	}, [onClose])

	const toggleRestApi = useCallback(async (enabled: boolean) => {
		setTogglingRest(true)
		try {
			const result = await rpcRequest<AppSettings>("setRestApiEnabled", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setRestApiEnabled:", e) }
		setTogglingRest(false)
	}, [])

	const handleChangePin = useCallback(async () => {
		setChangingPin(true)
		try {
			await rpcRequest("changePin", undefined, 600000)
		} catch (e: any) { console.error("changePin:", e) }
		setChangingPin(false)
		// Refresh features
		rpcRequest<DeviceFeatures>("getFeatures").then(setFeatures).catch(() => {})
	}, [])

	const handleRemovePin = useCallback(async () => {
		setRemovingPin(true)
		try {
			await rpcRequest("removePin", undefined, 60000)
		} catch (e: any) { console.error("removePin:", e) }
		setRemovingPin(false)
		setRemovePinConfirm(false)
		// Refresh features
		rpcRequest<DeviceFeatures>("getFeatures").then(setFeatures).catch(() => {})
	}, [])

	const handleTogglePassphrase = useCallback(async (enable: boolean) => {
		setTogglingPassphrase(true)
		try {
			await rpcRequest("applySettings", { usePassphrase: enable }, 60000)
			// Refresh features to reflect the new state
			const updated = await rpcRequest<DeviceFeatures>("getFeatures")
			setFeatures(updated)
		} catch (e: any) { console.error("togglePassphrase:", e) }
		setTogglingPassphrase(false)
	}, [])

	const securityValue = (val: boolean | undefined): string => {
		if (featuresError || features === null) return "—"
		return val ? "Enabled" : "Disabled"
	}

	return (
		<>
			{/* Backdrop */}
			{open && (
				<Box
					position="fixed"
					inset="0"
					bg="blackAlpha.600"
					zIndex={Z.drawerBackdrop}
					onClick={onClose}
				/>
			)}

			{/* Drawer panel */}
			<Box
				ref={panelRef}
				tabIndex={-1}
				position="fixed"
				top="0"
				right="0"
				h="100vh"
				w="400px"
				maxW="90vw"
				bg="kk.bg"
				borderLeft="1px solid"
				borderColor="kk.border"
				zIndex={Z.drawerPanel}
				transform={open ? "translateX(0)" : "translateX(100%)"}
				transition="transform 0.25s ease"
				overflowY="auto"
				outline="none"
				role="dialog"
				aria-label="Device Settings"
				aria-modal="true"
			>
				{/* Header */}
				<Flex
					align="center"
					justify="space-between"
					px="5"
					py="4"
					borderBottom="1px solid"
					borderColor="kk.border"
					position="sticky"
					top="0"
					bg="kk.bg"
					zIndex={1}
				>
					<Text fontSize="lg" fontWeight="600" color="kk.textPrimary">Settings</Text>
					<IconButton
						aria-label="Close settings"
						onClick={onClose}
						size="sm"
						variant="ghost"
						color="kk.textSecondary"
						_hover={{ color: "kk.textPrimary" }}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</IconButton>
				</Flex>

				{/* Content */}
				<VStack gap="3" align="stretch" p="4">

					{/* ── Device Identity ─────────────────────────────── */}
					<Section title="Device">
						<VStack gap="2" align="stretch">
							<InfoRow label="Label" value={features?.label || deviceState.label || "—"} />
							<InfoRow label="Device ID" value={deviceState.deviceId ? deviceState.deviceId.slice(0, 16) + "..." : "—"} />
							{/* Firmware with verification badge */}
							<Flex justify="space-between" align="center">
								<Text fontSize="xs" color="kk.textSecondary">Firmware</Text>
								<Flex align="center" gap="2">
									<Text fontSize="xs" color="kk.textPrimary" fontFamily="mono">{deviceState.firmwareVersion || "—"}</Text>
									<VerificationBadge verified={deviceState.firmwareVerified} />
								</Flex>
							</Flex>
							{/* Bootloader with verification badge */}
							<Flex justify="space-between" align="center">
								<Text fontSize="xs" color="kk.textSecondary">Bootloader</Text>
								<Flex align="center" gap="2">
									<Text fontSize="xs" color="kk.textPrimary" fontFamily="mono">{deviceState.bootloaderVersion || "—"}</Text>
									<VerificationBadge verified={deviceState.bootloaderVerified} />
								</Flex>
							</Flex>
							<InfoRow label="Latest FW" value={deviceState.latestFirmware || "—"} />
							<InfoRow label="Transport" value={deviceState.activeTransport || "—"} />
							{/* Collapsible hash display for advanced users */}
							{(deviceState.firmwareHash || deviceState.bootloaderHash) && (
								<Box mt="1" pt="2" borderTop="1px solid" borderColor="kk.border">
									{deviceState.firmwareHash && (
										<Box mb="1">
											<Text fontSize="9px" color="kk.textSecondary">FW Hash</Text>
											<Text fontSize="9px" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">{deviceState.firmwareHash}</Text>
										</Box>
									)}
									{deviceState.bootloaderHash && (
										<Box>
											<Text fontSize="9px" color="kk.textSecondary">BL Hash</Text>
											<Text fontSize="9px" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">{deviceState.bootloaderHash}</Text>
										</Box>
									)}
								</Box>
							)}
						</VStack>

						<Box mt="4">
							<Text fontSize="xs" color="kk.textSecondary" mb="2">Change Label</Text>
							<Flex gap="2">
								<Input
									value={label}
									onChange={(e) => setLabel(e.target.value)}
									placeholder="My KeepKey"
									bg="kk.bg"
									border="1px solid"
									borderColor="kk.border"
									color="kk.textPrimary"
									size="sm"
									flex="1"
								/>
								<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} onClick={saveLabel} disabled={saving || !label.trim()}>
									{saving ? "..." : "Save"}
								</Button>
							</Flex>
							{labelSaved && <Text fontSize="xs" color="kk.success" mt="1">Label saved</Text>}
						</Box>

						<Flex gap="3" align="center" mt="3">
							<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={pingDevice} disabled={pinging}>
								{pinging ? "..." : "Ping Device"}
							</Button>
							{pingResult && <Text fontSize="xs" color="kk.success">{pingResult}</Text>}
						</Flex>
					</Section>

					{/* ── Security ────────────────────────────────────── */}
					<Section title="Security">
						{featuresError && (
							<Text fontSize="xs" color="kk.error" mb="2">Could not load device features</Text>
						)}

						{/* ── PIN row ────────────────────────────── */}
						<Flex
							align="center"
							justify="space-between"
							py="3"
							borderBottom="1px solid"
							borderColor="rgba(255,255,255,0.06)"
						>
							<Flex align="center" gap="3">
								<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(192,168,96,0.1)">
									<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
										<path d="M7 11V7a5 5 0 0 1 10 0v4" />
									</svg>
								</Flex>
								<Box>
									<Text fontSize="sm" color="kk.textPrimary" fontWeight="500">PIN Protection</Text>
									<Text fontSize="xs" color="kk.textSecondary" mt="0.5">
										{features?.pinProtection ? "Enabled" : "Not set"}
									</Text>
								</Box>
							</Flex>
							{features?.pinProtection ? (
								<Flex gap="2">
									<Box
										as="button"
										px="3"
										py="1.5"
										borderRadius="full"
										bg="rgba(192,168,96,0.12)"
										color="kk.gold"
										fontSize="xs"
										fontWeight="500"
										cursor={changingPin ? "not-allowed" : "pointer"}
										opacity={changingPin ? 0.5 : 1}
										_hover={{ bg: "rgba(192,168,96,0.22)" }}
										transition="all 0.15s"
										onClick={handleChangePin}
									>
										{changingPin ? "..." : "Change"}
									</Box>
									{!removePinConfirm ? (
										<Box
											as="button"
											px="3"
											py="1.5"
											borderRadius="full"
											bg="rgba(255,23,68,0.08)"
											color="#FF6B6B"
											fontSize="xs"
											fontWeight="500"
											cursor="pointer"
											_hover={{ bg: "rgba(255,23,68,0.18)" }}
											transition="all 0.15s"
											onClick={() => setRemovePinConfirm(true)}
										>
											Remove
										</Box>
									) : (
										<Flex gap="2" align="center">
											<Box
												as="button"
												px="3"
												py="1.5"
												borderRadius="full"
												bg="#FF4444"
												color="white"
												fontSize="xs"
												fontWeight="600"
												cursor={removingPin ? "not-allowed" : "pointer"}
												opacity={removingPin ? 0.6 : 1}
												_hover={{ bg: "#FF2222" }}
												transition="all 0.15s"
												onClick={handleRemovePin}
											>
												{removingPin ? "..." : "Confirm"}
											</Box>
											<Box
												as="button"
												px="2"
												py="1.5"
												color="kk.textSecondary"
												fontSize="xs"
												cursor="pointer"
												_hover={{ color: "kk.textPrimary" }}
												onClick={() => setRemovePinConfirm(false)}
											>
												Cancel
											</Box>
										</Flex>
									)}
								</Flex>
							) : (
								<Box
									as="button"
									px="3"
									py="1.5"
									borderRadius="full"
									bg="rgba(192,168,96,0.12)"
									color="kk.gold"
									fontSize="xs"
									fontWeight="500"
									cursor={changingPin ? "not-allowed" : "pointer"}
									opacity={changingPin ? 0.5 : 1}
									_hover={{ bg: "rgba(192,168,96,0.22)" }}
									transition="all 0.15s"
									onClick={handleChangePin}
								>
									{changingPin ? "..." : "Add PIN"}
								</Box>
							)}
						</Flex>

						{/* ── Passphrase row ─────────────────────── */}
						<Flex
							align="center"
							justify="space-between"
							py="3"
							borderBottom="1px solid"
							borderColor="rgba(255,255,255,0.06)"
						>
							<Flex align="center" gap="3">
								<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(192,168,96,0.1)">
									<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M12 2a5 5 0 0 1 5 5v3H7V7a5 5 0 0 1 5-5z" />
										<rect x="3" y="10" width="18" height="12" rx="2" />
										<path d="M12 14v4" />
									</svg>
								</Flex>
								<Box>
									<Text fontSize="sm" color="kk.textPrimary" fontWeight="500">BIP-39 Passphrase</Text>
									<Text fontSize="xs" color="kk.textSecondary" mt="0.5">
										{togglingPassphrase
											? "Confirm on device..."
											: features?.passphraseProtection
												? "Required on each connection"
												: "Adds an extra word to your seed"
										}
									</Text>
								</Box>
							</Flex>
							<Toggle
								checked={!!features?.passphraseProtection}
								onChange={handleTogglePassphrase}
								disabled={togglingPassphrase || !features}
							/>
						</Flex>

						{/* ── Verify Seed row ────────────────────── */}
						<Box py="3">
							<Flex align="center" justify="space-between">
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(192,168,96,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
											<path d="M9 12l2 2 4-4" />
										</svg>
									</Flex>
									<Box>
										<Text fontSize="sm" color="kk.textPrimary" fontWeight="500">Verify Seed</Text>
										<Text fontSize="xs" color="kk.textSecondary" mt="0.5">
											{verifyResult
												? verifyResult.success ? "Seed verified!" : verifyResult.message
												: "Confirm your recovery phrase"
											}
										</Text>
									</Box>
								</Flex>
								<Box
									as="button"
									px="3"
									py="1.5"
									borderRadius="full"
									bg="rgba(192,168,96,0.12)"
									color="kk.gold"
									fontSize="xs"
									fontWeight="500"
									cursor={verifying ? "not-allowed" : "pointer"}
									opacity={verifying ? 0.5 : 1}
									_hover={{ bg: "rgba(192,168,96,0.22)" }}
									transition="all 0.15s"
									onClick={verifySeed}
								>
									{verifying ? "..." : "Verify"}
								</Box>
							</Flex>
							{/* Word count selector */}
							<Flex mt="2" ml="44px" gap="2">
								{([12, 18, 24] as const).map((wc) => (
									<Box
										key={wc}
										as="button"
										px="3"
										py="1"
										borderRadius="full"
										fontSize="xs"
										fontWeight="500"
										cursor="pointer"
										bg={verifyWordCount === wc ? "kk.gold" : "rgba(255,255,255,0.06)"}
										color={verifyWordCount === wc ? "black" : "kk.textSecondary"}
										_hover={{ bg: verifyWordCount === wc ? "kk.goldHover" : "rgba(255,255,255,0.1)" }}
										transition="all 0.15s"
										onClick={() => setVerifyWordCount(wc)}
									>
										{wc} words
									</Box>
								))}
							</Flex>
						</Box>
					</Section>

					{/* ── Application Settings ────────────────────────── */}
					<Section title="Application" defaultOpen={false}>
						<VStack gap="4" align="stretch">
							<Flex justify="space-between" align="center">
								<Box>
									<Text fontSize="sm" color="kk.textPrimary" fontWeight="500">REST API Server</Text>
									<Text fontSize="xs" color="kk.textSecondary" mt="0.5">
										Enable the signing API on port 1646 for dApp integrations.
									</Text>
								</Box>
								<Toggle
									checked={appSettings.restApiEnabled}
									onChange={toggleRestApi}
									disabled={togglingRest}
								/>
							</Flex>
							{appSettings.restApiEnabled && (
								<Box bg="rgba(192,168,96,0.08)" borderRadius="lg" px="3" py="2">
									<Text fontSize="xs" color="kk.gold" fontFamily="mono">
										http://localhost:1646
									</Text>
									<Text fontSize="xs" color="kk.textSecondary" mt="1">
										API is running. dApps can connect via kkapi:// protocol.
									</Text>
								</Box>
							)}
						</VStack>
					</Section>

					{/* ── Danger Zone ─────────────────────────────────── */}
					<Section title="Danger Zone" color="kk.error" defaultOpen={false}>
						<Text fontSize="xs" color="kk.textSecondary" mb="3">
							Wiping erases all data on the device. Make sure you have your recovery phrase backed up.
						</Text>
						{!wipeConfirm ? (
							<Button size="sm" variant="outline" borderColor="kk.error" color="kk.error" _hover={{ bg: "rgba(255,23,68,0.1)" }} onClick={() => setWipeConfirm(true)}>
								Wipe Device
							</Button>
						) : (
							<Flex gap="3">
								<Button size="sm" bg="kk.error" color="white" _hover={{ opacity: 0.8 }} onClick={wipeDevice} disabled={wiping}>
									{wiping ? "Wiping..." : "Confirm Wipe"}
								</Button>
								<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={() => setWipeConfirm(false)}>
									Cancel
								</Button>
							</Flex>
						)}
					</Section>

				</VStack>
			</Box>
		</>
	)
}

function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<Flex justify="space-between" align="center">
			<Text fontSize="xs" color="kk.textSecondary">{label}</Text>
			<Text fontSize="xs" color="kk.textPrimary" fontFamily="mono">{value}</Text>
		</Flex>
	)
}
