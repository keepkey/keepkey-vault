import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, VStack, Button, Input, IconButton } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { DeviceStateInfo } from "../../shared/types"

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
	const panelRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (open && deviceState.state === "ready") {
			setFeaturesError(false)
			rpcRequest<DeviceFeatures>("getFeatures")
				.then(setFeatures)
				.catch(() => setFeaturesError(true))
		}
	}, [open, deviceState.state])

	useEffect(() => { setLabel(deviceState.label || "") }, [deviceState.label])

	// Reset wipe confirm when drawer closes
	useEffect(() => { if (!open) setWipeConfirm(false) }, [open])

	// Escape key closes drawer
	useEffect(() => {
		if (!open) return
		const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [open, onClose])

	// Auto-focus panel on open
	useEffect(() => {
		if (open) panelRef.current?.focus()
	}, [open])

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
					<Text fontSize="lg" fontWeight="600" color="kk.textPrimary">Device Settings</Text>
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
				<VStack gap="4" align="stretch" p="5">
					{/* Device Identity */}
					<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5">
						<Text fontSize="md" fontWeight="600" mb="3" color="kk.gold">Device Identity</Text>
						<VStack gap="2" align="stretch">
							<InfoRow label="Label" value={features?.label || deviceState.label || "—"} />
							<InfoRow label="Device ID" value={deviceState.deviceId ? deviceState.deviceId.slice(0, 16) + "..." : "—"} />
							<InfoRow label="Firmware" value={deviceState.firmwareVersion || "—"} />
							<InfoRow label="Bootloader" value={deviceState.bootloaderVersion || "—"} />
							<InfoRow label="Latest FW" value={deviceState.latestFirmware || "—"} />
							<InfoRow label="Transport" value={deviceState.activeTransport || "—"} />
						</VStack>
					</Box>

					{/* Security Status */}
					<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5">
						<Text fontSize="md" fontWeight="600" mb="3" color="kk.gold">Security</Text>
						{featuresError && (
							<Text fontSize="xs" color="kk.error" mb="2">Could not load device features</Text>
						)}
						<VStack gap="2" align="stretch">
							<InfoRow label="Initialized" value={deviceState.initialized ? "Yes" : "No"} />
							<InfoRow label="PIN Protection" value={securityValue(features?.pinProtection)} />
							<InfoRow label="Passphrase" value={securityValue(features?.passphraseProtection)} />
							<InfoRow label="U2F Counter" value={features?.u2fCounter != null ? String(features.u2fCounter) : "—"} />
						</VStack>
					</Box>

					{/* Verify Seed */}
					<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5">
						<Text fontSize="md" fontWeight="600" mb="2" color="kk.gold">Verify Recovery Seed</Text>
						<Text fontSize="xs" color="kk.textSecondary" mb="3">
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

					{/* Actions */}
					<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5">
						<Text fontSize="md" fontWeight="600" mb="3" color="kk.gold">Actions</Text>

						<Text fontSize="xs" color="kk.textSecondary" mb="2">Device Label</Text>
						<Flex gap="2" mb="1">
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
						{labelSaved && <Text fontSize="xs" color="kk.success" mb="2">Label saved</Text>}

						<Flex gap="3" align="center" mt="2">
							<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={pingDevice} disabled={pinging}>
								{pinging ? "..." : "Ping Device"}
							</Button>
							{pingResult && <Text fontSize="xs" color="kk.success">{pingResult}</Text>}
						</Flex>
					</Box>

					{/* Danger Zone */}
					<Box bg="kk.cardBg" border="1px solid" borderColor="kk.error" borderRadius="xl" p="5">
						<Text fontSize="md" fontWeight="600" mb="2" color="kk.error">Danger Zone</Text>
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
					</Box>
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
