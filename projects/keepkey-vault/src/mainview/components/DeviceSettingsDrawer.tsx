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
	useEffect(() => { if (!open) setWipeConfirm(false) }, [open])

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
			const result = await rpcRequest("verifySeed", { wordCount: 12 }, 600000) as { success: boolean; message: string }
			setVerifyResult(result)
		} catch (e: any) {
			const msg = typeof e?.message === "string" ? e.message : "Verification failed"
			setVerifyResult({ success: false, message: msg })
		}
		setVerifying(false)
	}, [])

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
							<InfoRow label="Firmware" value={deviceState.firmwareVersion || "—"} />
							<InfoRow label="Bootloader" value={deviceState.bootloaderVersion || "—"} />
							<InfoRow label="Latest FW" value={deviceState.latestFirmware || "—"} />
							<InfoRow label="Transport" value={deviceState.activeTransport || "—"} />
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
						<VStack gap="2" align="stretch">
							<InfoRow label="Initialized" value={deviceState.initialized ? "Yes" : "No"} />
							<InfoRow label="PIN Protection" value={securityValue(features?.pinProtection)} />
							<InfoRow label="Passphrase" value={securityValue(features?.passphraseProtection)} />
							<InfoRow label="U2F Counter" value={features?.u2fCounter != null ? String(features.u2fCounter) : "—"} />
						</VStack>

						<Box mt="4">
							<Text fontSize="xs" color="kk.textSecondary" mb="2">
								Confirm your recovery phrase matches the seed stored on the device.
							</Text>
							<Flex gap="3" align="center">
								<Button
									size="sm"
									variant="outline"
									borderColor="kk.gold"
									color="kk.gold"
									_hover={{ bg: "rgba(192,168,96,0.1)" }}
									onClick={verifySeed}
									disabled={verifying}
								>
									{verifying ? "Verifying..." : "Verify Seed"}
								</Button>
								{verifyResult && (
									<Text fontSize="xs" color={verifyResult.success ? "kk.success" : "kk.error"}>
										{verifyResult.success ? "Seed verified!" : verifyResult.message}
									</Text>
								)}
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
