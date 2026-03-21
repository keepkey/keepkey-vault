import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, VStack, Button, Input, IconButton } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { LanguageSelector } from "../i18n/LanguageSelector"
import { CurrencySelector } from "./CurrencySelector"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { DeviceStateInfo, AppSettings } from "../../shared/types"

interface DevicePolicy {
	policyName?: string
	policy_name?: string
	enabled: boolean
}

interface DeviceFeatures {
	label?: string
	pinProtection?: boolean
	passphraseProtection?: boolean
	u2fCounter?: number
	policiesList?: DevicePolicy[]
	policies?: DevicePolicy[]
}

interface DeviceSettingsDrawerProps {
	open: boolean
	onClose: () => void
	deviceState: DeviceStateInfo
	onCheckForUpdate?: () => Promise<any>
	onDownloadUpdate?: () => Promise<void>
	onApplyUpdate?: () => Promise<void>
	updatePhase?: string
	updateVersion?: string
	appVersion?: { version: string; channel: string } | null
	onOpenAuditLog?: () => void
	onOpenPairedApps?: () => void
	onRestApiChanged?: (enabled: boolean) => void
	onWordCountChange?: (count: 12 | 18 | 24) => void
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
				<Text fontSize="lg" fontWeight="600" color={color || "kk.gold"}>{title}</Text>
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

function VerificationBadge({ verified, t }: { verified?: boolean; t: (key: string) => string }) {
	if (verified === undefined) return null
	if (verified) {
		return (
			<Flex align="center" gap="1">
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
					<circle cx="12" cy="12" r="10" fill="#22C55E" />
					<path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
				<Text fontSize="11px" color="#22C55E" fontWeight="600">{t("official")}</Text>
			</Flex>
		)
	}
	return (
		<Flex align="center" gap="1">
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
				<path d="M12 2L1 21h22L12 2z" fill="#FB923C" />
				<path d="M12 9v4M12 17h.01" stroke="white" strokeWidth="2" strokeLinecap="round" />
			</svg>
			<Text fontSize="11px" color="#FB923C" fontWeight="600">{t("unknown")}</Text>
		</Flex>
	)
}

// ── Main Component ──────────────────────────────────────────────────

export function DeviceSettingsDrawer({ open, onClose, deviceState, onCheckForUpdate, onDownloadUpdate, onApplyUpdate, updatePhase, updateVersion, appVersion, onOpenAuditLog, onOpenPairedApps, onRestApiChanged, onWordCountChange }: DeviceSettingsDrawerProps) {
	const { t } = useTranslation("settings")
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
	const [togglingPolicy, setTogglingPolicy] = useState("")
	const [appSettings, setAppSettings] = useState<AppSettings>({ restApiEnabled: false, pioneerApiBase: '', pioneerServers: [], activePioneerServer: '', fiatCurrency: 'USD', numberLocale: 'en-US', swapsEnabled: false, bip85Enabled: false, zcashPrivacyEnabled: false, preReleaseUpdates: false })
	const [togglingRestApi, setTogglingRestApi] = useState(false)
	const [togglingSwaps, setTogglingSwaps] = useState(false)
	const [togglingBip85, setTogglingBip85] = useState(false)
	const [togglingZcashPrivacy, setTogglingZcashPrivacy] = useState(false)
	const [togglingPreRelease, setTogglingPreRelease] = useState(false)
	const [checkingUpdate, setCheckingUpdate] = useState(false)
	const [updateMessage, setUpdateMessage] = useState("")
	const [newServerUrl, setNewServerUrl] = useState("")
	const [newServerLabel, setNewServerLabel] = useState("")
	const [addingServer, setAddingServer] = useState(false)
	const [serverMsg, setServerMsg] = useState<{ text: string; ok: boolean } | null>(null)
	const [switchingServer, setSwitchingServer] = useState("")
	const [resetConfirm, setResetConfirm] = useState(false)
	const [resetting, setResetting] = useState(false)
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
			.then(s => setAppSettings(s))
			.catch(() => {})
	}, [open, deviceState.state])

	useEffect(() => { setLabel(deviceState.label || "") }, [deviceState.label])
	useEffect(() => { if (!open) { setWipeConfirm(false); setRemovePinConfirm(false); setResetConfirm(false) } }, [open])

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
			setPingResult(typeof result === "string" ? result : t("pong"))
			setTimeout(() => setPingResult(""), 3000)
		} catch {
			setPingResult(t("pingFailed"))
			setTimeout(() => setPingResult(""), 3000)
		}
		setPinging(false)
	}, [])

	const verifySeed = useCallback(async () => {
		setVerifying(true)
		setVerifyResult(null)
		onWordCountChange?.(verifyWordCount)
		try {
			const result = await rpcRequest("verifySeed", { wordCount: verifyWordCount }, 0) as { success: boolean; message: string }
			setVerifyResult(result)
		} catch (e: any) {
			const msg = typeof e?.message === "string" ? e.message : t("verificationFailed")
			setVerifyResult({ success: false, message: msg })
		}
		setVerifying(false)
	}, [verifyWordCount])

	const wipeDevice = useCallback(async () => {
		setWiping(true)
		try {
			await rpcRequest("wipeDevice", undefined, 0)
		} catch (e: any) { console.error("wipeDevice:", e) }
		setWiping(false)
		setWipeConfirm(false)
		onClose()
	}, [onClose])

	const factoryReset = useCallback(async () => {
		setResetting(true)
		try {
			await rpcRequest("factoryReset", undefined, 30000)
			// App will quit after reset — nothing more to do
		} catch (e: any) {
			console.error("factoryReset:", e)
			setResetting(false)
			setResetConfirm(false)
		}
	}, [])

	const toggleRestApi = useCallback(async (enabled: boolean) => {
		setTogglingRestApi(true)
		try {
			const result = await rpcRequest<AppSettings>("setRestApiEnabled", { enabled }, 10000)
			setAppSettings(result)
			onRestApiChanged?.(result.restApiEnabled)
		} catch (e: any) { console.error("setRestApiEnabled:", e) }
		setTogglingRestApi(false)
	}, [onRestApiChanged])

	const toggleSwaps = useCallback(async (enabled: boolean) => {
		setTogglingSwaps(true)
		try {
			const result = await rpcRequest<AppSettings>("setSwapsEnabled", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setSwapsEnabled:", e) }
		setTogglingSwaps(false)
	}, [])

	const toggleBip85 = useCallback(async (enabled: boolean) => {
		setTogglingBip85(true)
		try {
			const result = await rpcRequest<AppSettings>("setBip85Enabled", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setBip85Enabled:", e) }
		setTogglingBip85(false)
	}, [])

	const toggleZcashPrivacy = useCallback(async (enabled: boolean) => {
		setTogglingZcashPrivacy(true)
		try {
			const result = await rpcRequest<AppSettings>("setZcashPrivacyEnabled", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setZcashPrivacyEnabled:", e) }
		setTogglingZcashPrivacy(false)
	}, [])

	const togglePreRelease = useCallback(async (enabled: boolean) => {
		setTogglingPreRelease(true)
		try {
			const result = await rpcRequest<AppSettings>("setPreReleaseUpdates", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setPreReleaseUpdates:", e) }
		setTogglingPreRelease(false)
	}, [])

	const openSwagger = useCallback(async () => {
		try {
			await rpcRequest("openUrl", { url: "http://localhost:1646/docs" }, 5000)
		} catch (e: any) { console.error("openUrl:", e) }
	}, [])

	const updateMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const handleCheckForUpdate = useCallback(async () => {
		if (!onCheckForUpdate) return
		setCheckingUpdate(true)
		setUpdateMessage("")
		if (updateMsgTimerRef.current) clearTimeout(updateMsgTimerRef.current)
		try {
			const info = await onCheckForUpdate()
			if (info?.updateAvailable) {
				setUpdateMessage(t("versionAvailable", { version: info.version }))
			} else {
				setUpdateMessage(t("onLatestVersion"))
				updateMsgTimerRef.current = setTimeout(() => setUpdateMessage(""), 4000)
			}
		} catch (e: any) {
			setUpdateMessage(e.message || t("checkFailed"))
			updateMsgTimerRef.current = setTimeout(() => setUpdateMessage(""), 4000)
		}
		setCheckingUpdate(false)
	}, [onCheckForUpdate])

	// Cleanup timer on unmount
	useEffect(() => {
		return () => { if (updateMsgTimerRef.current) clearTimeout(updateMsgTimerRef.current) }
	}, [])

	const handleChangePin = useCallback(async () => {
		setChangingPin(true)
		try {
			await rpcRequest("changePin", undefined, 0)
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
			// When enabling, state transitions to 'needs_passphrase' and the dashboard
			// (including this drawer) unmounts — skip getFeatures to avoid racing with
			// promptPin()'s getPublicKeys() on the transport lock (causes hang).
			// When disabling, state stays 'ready' so refresh features for the toggle.
			if (!enable) {
				const updated = await rpcRequest<DeviceFeatures>("getFeatures")
				setFeatures(updated)
			}
		} catch (e: any) {
			console.error("togglePassphrase:", e)
			// Refresh features from device on failure — if PIN timed out or the
			// operation was cancelled, the device is still the authority on whether
			// passphrase protection is enabled.
			rpcRequest<DeviceFeatures>("getFeatures").then(setFeatures).catch(() => {})
		}
		setTogglingPassphrase(false)
	}, [])

	// Get whether a named policy is enabled from device features
	const isPolicyEnabled = useCallback((name: string): boolean => {
		if (!features) return false
		const policies = features.policiesList || features.policies || []
		const p = policies.find((x: DevicePolicy) => (x.policyName || x.policy_name) === name)
		return p?.enabled ?? false
	}, [features])

	const handleTogglePolicy = useCallback(async (policyName: string, enable: boolean) => {
		setTogglingPolicy(policyName)
		try {
			await rpcRequest("applyPolicy", { policyName, enabled: enable }, 60000)
			// Refresh features to reflect the new state
			const updated = await rpcRequest<DeviceFeatures>("getFeatures")
			setFeatures(updated)
		} catch (e: any) { console.error("applyPolicy:", e) }
		setTogglingPolicy("")
	}, [])

	const addServer = useCallback(async () => {
		setAddingServer(true)
		setServerMsg({ text: "Checking server health...", ok: true })
		try {
			const result = await rpcRequest<AppSettings>("addPioneerServer", { url: newServerUrl, label: newServerLabel }, 15000)
			setAppSettings(result)
			setNewServerUrl("")
			setNewServerLabel("")
			setServerMsg({ text: "Server added", ok: true })
			setTimeout(() => setServerMsg(null), 3000)
		} catch (e: any) {
			setServerMsg({ text: e.message || "Failed", ok: false })
			setTimeout(() => setServerMsg(null), 5000)
		}
		setAddingServer(false)
	}, [newServerUrl, newServerLabel])

	const removeServer = useCallback(async (url: string) => {
		try {
			const result = await rpcRequest<AppSettings>("removePioneerServer", { url }, 10000)
			setAppSettings(result)
		} catch (e: any) {
			setServerMsg({ text: e.message || "Failed to remove", ok: false })
			setTimeout(() => setServerMsg(null), 3000)
		}
	}, [])

	const switchServer = useCallback(async (url: string) => {
		setSwitchingServer(url)
		setServerMsg({ text: "Verifying server...", ok: true })
		try {
			const result = await rpcRequest<AppSettings>("setActivePioneerServer", { url }, 15000)
			setAppSettings(result)
			setServerMsg(null)
		} catch (e: any) {
			setServerMsg({ text: e.message || "Failed to switch", ok: false })
			setTimeout(() => setServerMsg(null), 5000)
		}
		setSwitchingServer("")
	}, [])

	const securityValue = (val: boolean | undefined): string => {
		if (featuresError || features === null) return "—"
		return val ? t("enabled", { ns: "common" }) : t("disabled", { ns: "common" })
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
				w="440px"
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
				aria-label={t("title")}
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
					<Text fontSize="lg" fontWeight="600" color="kk.textPrimary">{t("title")}</Text>
					<IconButton
						aria-label={t("closeSettings")}
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

					{/* ── Language & Currency ─────────────────────────── */}
					<Section title={t("language")} defaultOpen={false}>
						<LanguageSelector />
						<Box mt="2">
							<CurrencySelector />
						</Box>
					</Section>

					{/* ── Device Identity ─────────────────────────────── */}
					<Section title={t("device")}>
						<VStack gap="2" align="stretch">
							<InfoRow label={t("label")} value={features?.label || deviceState.label || "—"} />
							<InfoRow label={t("deviceId")} value={deviceState.deviceId ? deviceState.deviceId.slice(0, 16) + "..." : "—"} />
							{/* Firmware with verification badge */}
							<Flex justify="space-between" align="center">
								<Text fontSize="sm" color="kk.textSecondary">{t("firmware")}</Text>
								<Flex align="center" gap="2">
									<Text fontSize="sm" color="kk.textPrimary" fontFamily="mono">{deviceState.firmwareVersion || "—"}</Text>
									<VerificationBadge verified={deviceState.firmwareVerified} t={t} />
								</Flex>
							</Flex>
							{/* Bootloader with verification badge */}
							<Flex justify="space-between" align="center">
								<Text fontSize="sm" color="kk.textSecondary">{t("bootloader")}</Text>
								<Flex align="center" gap="2">
									<Text fontSize="sm" color="kk.textPrimary" fontFamily="mono">{deviceState.bootloaderVersion || "—"}</Text>
									<VerificationBadge verified={deviceState.bootloaderVerified} t={t} />
								</Flex>
							</Flex>
							<InfoRow label={t("latestFw")} value={deviceState.latestFirmware || "—"} />
							<InfoRow label={t("transport")} value={deviceState.activeTransport || "—"} />
							{/* Collapsible hash display for advanced users */}
							{(deviceState.firmwareHash || deviceState.bootloaderHash) && (
								<Box mt="1" pt="2" borderTop="1px solid" borderColor="kk.border">
									{deviceState.firmwareHash && (
										<Box mb="1">
											<Text fontSize="10px" color="kk.textSecondary">{t("fwHash")}</Text>
											<Text fontSize="9px" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">{deviceState.firmwareHash}</Text>
										</Box>
									)}
									{deviceState.bootloaderHash && (
										<Box>
											<Text fontSize="10px" color="kk.textSecondary">{t("blHash")}</Text>
											<Text fontSize="9px" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">{deviceState.bootloaderHash}</Text>
										</Box>
									)}
								</Box>
							)}
						</VStack>

						<Box mt="4">
							<Text fontSize="sm" color="kk.textPrimary" fontWeight="600" mb="2">{t("changeLabel")}</Text>
							<Flex gap="2">
								<Input
									value={label}
									onChange={(e) => setLabel(e.target.value)}
									placeholder={t("myKeepKey")}
									bg="kk.bg"
									border="1px solid"
									borderColor="kk.border"
									color="kk.textPrimary"
									size="sm"
									flex="1"
								/>
								<Button size="sm" bg="kk.gold" color="black" px="4" py="2" _hover={{ bg: "kk.goldHover" }} onClick={saveLabel} disabled={saving || !label.trim()}>
									{saving ? "..." : t("save", { ns: "common" })}
								</Button>
							</Flex>
							{labelSaved && <Text fontSize="sm" color="kk.success" mt="1">{t("labelSaved")}</Text>}
						</Box>

						<Flex gap="3" align="center" mt="3">
							<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" px="4" py="2" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={pingDevice} disabled={pinging}>
								{pinging ? "..." : t("pingDevice")}
							</Button>
							{pingResult && <Text fontSize="sm" color="kk.success">{pingResult}</Text>}
						</Flex>
					</Section>

					{/* ── Security ────────────────────────────────────── */}
					<Section title={t("security")}>
						{featuresError && (
							<Text fontSize="sm" color="kk.error" mb="2">{t("couldNotLoadFeatures")}</Text>
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
									<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("pinProtection")}</Text>
									<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
										{features?.pinProtection ? t("enabled", { ns: "common" }) : t("notSet", { ns: "common" })}
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
										{changingPin ? "..." : t("change", { ns: "common" })}
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
											{t("remove", { ns: "common" })}
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
												{removingPin ? "..." : t("confirm", { ns: "common" })}
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
												{t("cancel", { ns: "common" })}
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
									{changingPin ? "..." : t("addPin")}
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
									<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("bip39Passphrase")}</Text>
									<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
										{togglingPassphrase
											? t("confirmOnDevice")
											: features?.passphraseProtection
												? t("requiredOnEachConnection")
												: t("addsExtraWord")
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
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("verifySeed")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{verifyResult
												? verifyResult.success ? t("seedVerified") : verifyResult.message
												: t("confirmRecoveryPhrase")
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
									{verifying ? "..." : t("verify", { ns: "common" })}
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
										{t("wordCount", { count: wc })}
									</Box>
								))}
							</Flex>
						</Box>
					</Section>

					{/* ── Signing Policy ─────────────────────────────── */}
					<Section title={t("signingPolicy")} defaultOpen={false}>
						<VStack gap="4" align="stretch">
							{/* Advanced Mode (blind signing) */}
							<Flex
								align="center"
								justify="space-between"
								py="3"
								borderBottom="1px solid"
								borderColor="rgba(255,255,255,0.06)"
							>
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(245,163,59,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F5A33B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M12 9v4M12 17h.01" />
											<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
										</svg>
									</Flex>
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("advancedMode")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("advancedModeDescription")}
										</Text>
									</Box>
								</Flex>
								<Toggle
									checked={isPolicyEnabled("AdvancedMode")}
									onChange={(v) => handleTogglePolicy("AdvancedMode", v)}
									disabled={togglingPolicy === "AdvancedMode" || !features}
								/>
							</Flex>

							{/* Experimental features */}
							<Flex
								align="center"
								justify="space-between"
								py="3"
							>
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(130,100,250,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8264FA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4" />
										</svg>
									</Flex>
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("experimentalFeatures")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("experimentalFeaturesDescription")}
										</Text>
									</Box>
								</Flex>
								<Toggle
									checked={isPolicyEnabled("Experimental")}
									onChange={(v) => handleTogglePolicy("Experimental", v)}
									disabled={togglingPolicy === "Experimental" || !features}
								/>
							</Flex>
						</VStack>
					</Section>

					{/* ── Application Settings ────────────────────────── */}
					<Section title={t("application")} defaultOpen={false}>
						<VStack gap="4" align="stretch">
							{/* REST API server toggle */}
							<Flex justify="space-between" align="center">
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(192,168,96,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M4 11a9 9 0 0 1 9 9" />
											<path d="M4 4a16 16 0 0 1 16 16" />
											<circle cx="5" cy="19" r="1" />
										</svg>
									</Flex>
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("apiBridge")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("apiBridgeDescription")}
										</Text>
									</Box>
								</Flex>
								<Toggle
									checked={appSettings.restApiEnabled}
									onChange={toggleRestApi}
									disabled={togglingRestApi}
								/>
							</Flex>

							{/* API Bridge status */}
							<Box bg="rgba(192,168,96,0.08)" borderRadius="lg" px="3" py="3">
								<Flex align="center" justify="space-between">
									<Flex align="center" gap="2">
										<Box
											w="8px"
											h="8px"
											borderRadius="full"
											bg={appSettings.restApiEnabled ? "#22C55E" : "#EF4444"}
											boxShadow={appSettings.restApiEnabled ? "0 0 6px rgba(34,197,94,0.5)" : "0 0 6px rgba(239,68,68,0.4)"}
										/>
										<Text fontSize="sm" fontWeight="500" color={appSettings.restApiEnabled ? "#22C55E" : "#EF4444"}>
											{appSettings.restApiEnabled ? t("running") : t("stopped")}
										</Text>
									</Flex>
									{appSettings.restApiEnabled && (
										<Text fontSize="sm" color="kk.textSecondary" fontFamily="mono">
											:1646
										</Text>
									)}
								</Flex>
								{appSettings.restApiEnabled && (
									<Flex gap="3" mt="2">
										<Box
											as="button"
											fontSize="xs"
											color="kk.gold"
											cursor="pointer"
											_hover={{ textDecoration: "underline" }}
											onClick={openSwagger}
										>
											{t("apiDocs")}
										</Box>
										{onOpenAuditLog && (
											<Box
												as="button"
												fontSize="xs"
												color="kk.gold"
												cursor="pointer"
												_hover={{ textDecoration: "underline" }}
												onClick={onOpenAuditLog}
											>
												{t("auditLog")}
											</Box>
										)}
										{onOpenPairedApps && (
											<Box
												as="button"
												fontSize="xs"
												color="kk.gold"
												cursor="pointer"
												_hover={{ textDecoration: "underline" }}
												onClick={onOpenPairedApps}
											>
												{t("pairedApps")}
											</Box>
										)}
									</Flex>
								)}
							</Box>

							{/* ── App Version + Update Check ────── */}
							<Box pt="3" borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
								<Flex justify="space-between" align="center">
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("appVersion")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5" fontFamily="mono">
											{appVersion ? `v${appVersion.version}` : "—"}
											{appVersion?.channel && appVersion.channel !== "stable" ? ` (${appVersion.channel})` : ""}
										</Text>
									</Box>
									<Box
										as="button"
										px="3"
										py="1.5"
										borderRadius="full"
										bg="rgba(192,168,96,0.12)"
										color="kk.gold"
										fontSize="xs"
										fontWeight="500"
										cursor={checkingUpdate ? "not-allowed" : "pointer"}
										opacity={checkingUpdate ? 0.5 : 1}
										_hover={{ bg: "rgba(192,168,96,0.22)" }}
										transition="all 0.15s"
										onClick={handleCheckForUpdate}
									>
										{checkingUpdate ? t("checking") : t("checkForUpdates")}
									</Box>
								</Flex>
								{updateMessage && (
									<Text fontSize="sm" color={updatePhase === "error" ? "kk.error" : updatePhase === "available" || updatePhase === "ready" ? "kk.gold" : "kk.textSecondary"} mt="1">
										{updateMessage}
									</Text>
								)}
								{/* Download button (available state) */}
								{updatePhase === "available" && onDownloadUpdate && (
									<Box
										as="button" mt="2" px="3" py="1.5" borderRadius="full"
										bg="kk.gold" color="black" fontSize="xs" fontWeight="600"
										cursor="pointer" _hover={{ opacity: 0.9 }}
										onClick={onDownloadUpdate}
									>
										{t("downloadUpdate", { defaultValue: "Download Update" })}
									</Box>
								)}
								{/* Install button (ready state — Linux native updater) */}
								{updatePhase === "ready" && onApplyUpdate && (
									<Box
										as="button" mt="2" px="3" py="1.5" borderRadius="full"
										bg="#22C55E" color="white" fontSize="xs" fontWeight="600"
										cursor="pointer" _hover={{ bg: "#16A34A" }}
										onClick={onApplyUpdate}
									>
										{t("restartToUpdate", { defaultValue: "Restart & Install" })}
									</Box>
								)}
								{/* Error fallback */}
								{updatePhase === "error" && onDownloadUpdate && (
									<Box
										as="button" mt="2" px="3" py="1.5" borderRadius="full"
										bg="rgba(255,255,255,0.06)" color="kk.gold" fontSize="xs" fontWeight="500"
										cursor="pointer" _hover={{ bg: "rgba(255,255,255,0.1)" }}
										onClick={onDownloadUpdate}
									>
										{t("downloadManually", { defaultValue: "Download from GitHub" })}
									</Box>
								)}
							</Box>

							{/* Pre-release updates toggle */}
							<Flex justify="space-between" align="center" mt="3" pt="3" borderTopWidth="1px" borderColor="kk.border">
								<Flex align="center" gap="3">
									<Box w="8" h="8" borderRadius="lg" bg="rgba(139,92,246,0.15)" display="flex" alignItems="center" justifyContent="center">
										<Text fontSize="sm">🧪</Text>
									</Box>
									<VStack gap="0" align="start">
										<Text fontSize="sm" color="kk.textPrimary" fontWeight="500">{t("preReleaseUpdates", { defaultValue: "Pre-release Updates" })}</Text>
										<Text fontSize="2xs" color="kk.textMuted">{t("preReleaseUpdatesDesc", { defaultValue: "Get early access to new features before stable release" })}</Text>
									</VStack>
								</Flex>
								<Box
									as="button"
									w="44px" h="24px"
									borderRadius="full"
									bg={appSettings.preReleaseUpdates ? "rgba(139,92,246,0.5)" : "rgba(255,255,255,0.1)"}
									position="relative"
									transition="all 0.2s"
									cursor={togglingPreRelease ? "not-allowed" : "pointer"}
									opacity={togglingPreRelease ? 0.5 : 1}
									onClick={() => !togglingPreRelease && togglePreRelease(!appSettings.preReleaseUpdates)}
								>
									<Box
										w="18px" h="18px"
										borderRadius="full"
										bg={appSettings.preReleaseUpdates ? "#8B5CF6" : "rgba(255,255,255,0.3)"}
										position="absolute"
										top="3px"
										left={appSettings.preReleaseUpdates ? "23px" : "3px"}
										transition="all 0.2s"
									/>
								</Box>
							</Flex>

						</VStack>
					</Section>

					{/* ── Feature Flags ──────────────────────────────── */}
					<Section title={t("featureFlags")} defaultOpen={false}>
						<VStack gap="4" align="stretch">
							{/* Swaps toggle */}
							<Flex justify="space-between" align="center">
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(35,220,200,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#23DCC8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M16 3l5 5-5 5" />
											<path d="M21 8H9" />
											<path d="M8 21l-5-5 5-5" />
											<path d="M3 16h12" />
										</svg>
									</Flex>
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("swapsFeature")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("swapsFeatureDescription")}
										</Text>
									</Box>
								</Flex>
								<Toggle
									checked={appSettings.swapsEnabled}
									onChange={toggleSwaps}
									disabled={togglingSwaps}
								/>
							</Flex>

							{/* BIP-85 Derived Seeds toggle */}
							<Flex justify="space-between" align="center">
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(192,168,96,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
											<path d="M7 11V7a5 5 0 0 1 10 0v4" />
										</svg>
									</Flex>
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("bip85Feature")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("bip85FeatureDescription")}
										</Text>
									</Box>
								</Flex>
								<Toggle
									checked={appSettings.bip85Enabled}
									onChange={toggleBip85}
									disabled={togglingBip85}
								/>
							</Flex>

							{/* Zcash Shielded Privacy toggle */}
							<Flex justify="space-between" align="center">
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(245,163,59,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F5A33B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
										</svg>
									</Flex>
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("zcashPrivacyFeature")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("zcashPrivacyFeatureDescription")}
										</Text>
									</Box>
								</Flex>
								<Toggle
									checked={appSettings.zcashPrivacyEnabled}
									onChange={toggleZcashPrivacy}
									disabled={togglingZcashPrivacy}
								/>
							</Flex>
						</VStack>
					</Section>

					{/* ── API Services ────────────────────────────────── */}
					<Section title="API Services" defaultOpen={false}>
						<VStack gap="4" align="stretch">
							<Box>
								<Text fontSize="md" color="kk.textPrimary" fontWeight="500">Pioneer API Servers</Text>
								<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
									Manage which Pioneer API server the vault connects to.
								</Text>
							</Box>

							{/* Server list */}
							<VStack gap="2" align="stretch">
								{(appSettings.pioneerServers || []).map(server => {
									const isActive = server.url === appSettings.activePioneerServer
									return (
										<Flex
											key={server.url}
											align="center"
											gap="2"
											px="3"
											py="2"
											bg={isActive ? "rgba(198,170,107,0.08)" : "kk.bg"}
											border="1px solid"
											borderColor={isActive ? "kk.gold" : "kk.border"}
											borderRadius="lg"
											cursor={isActive ? "default" : "pointer"}
											_hover={isActive ? {} : { borderColor: "kk.gold", bg: "rgba(198,170,107,0.04)" }}
											onClick={() => !isActive && switchServer(server.url)}
										>
											{/* Radio indicator */}
											<Box
												w="14px" h="14px" borderRadius="full"
												border="2px solid"
												borderColor={isActive ? "kk.gold" : "kk.border"}
												display="flex" alignItems="center" justifyContent="center"
												flexShrink={0}
											>
												{isActive && <Box w="7px" h="7px" borderRadius="full" bg="kk.gold" />}
											</Box>

											<Box flex="1" minW="0">
												<Flex align="center" gap="2">
													<Text fontSize="sm" fontWeight="500" color="kk.textPrimary" truncate>{server.label}</Text>
													{server.isDefault && (
														<Text fontSize="11px" color="kk.gold" fontWeight="600" px="1.5" py="0.5" bg="rgba(198,170,107,0.12)" borderRadius="md">DEFAULT</Text>
													)}
												</Flex>
												<Text fontSize="12px" color="kk.textSecondary" fontFamily="mono" truncate>{server.url}</Text>
											</Box>

											{switchingServer === server.url && (
												<Text fontSize="sm" color="kk.textSecondary">...</Text>
											)}

											{/* Remove button (not for default) */}
											{!server.isDefault && (
												<Box
													as="button"
													onClick={(e: React.MouseEvent) => { e.stopPropagation(); removeServer(server.url) }}
													color="kk.textSecondary"
													_hover={{ color: "kk.error" }}
													p="1"
													flexShrink={0}
												>
													<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<line x1="18" y1="6" x2="6" y2="18" />
														<line x1="6" y1="6" x2="18" y2="18" />
													</svg>
												</Box>
											)}
										</Flex>
									)
								})}
							</VStack>

							{/* Add new server */}
							<Box borderTop="1px solid" borderColor="kk.border" pt="3">
								<Text fontSize="sm" color="kk.textSecondary" mb="2">Add Server</Text>
								<VStack gap="2" align="stretch">
									<Input
										value={newServerLabel}
										onChange={(e) => setNewServerLabel(e.target.value)}
										placeholder="My Server"
										bg="kk.bg"
										border="1px solid"
										borderColor="kk.border"
										color="kk.textPrimary"
										size="sm"
										fontSize="xs"
									/>
									<Flex gap="2">
										<Input
											value={newServerUrl}
											onChange={(e) => setNewServerUrl(e.target.value)}
											placeholder="https://my-server.example.com"
											bg="kk.bg"
											border="1px solid"
											borderColor="kk.border"
											color="kk.textPrimary"
											size="sm"
											flex="1"
											fontFamily="mono"
											fontSize="xs"
										/>
										<Button
											size="sm"
											px="4"
											py="2"
											bg="kk.gold"
											color="black"
											_hover={{ bg: "kk.goldHover" }}
											onClick={addServer}
											disabled={addingServer || !newServerUrl.trim() || !newServerLabel.trim()}
										>
											{addingServer ? "..." : "Add"}
										</Button>
									</Flex>
								</VStack>
							</Box>

							{serverMsg && (
								<Text fontSize="sm" color={serverMsg.ok ? "kk.success" : "kk.error"}>
									{serverMsg.text}
								</Text>
							)}
						</VStack>
					</Section>

					{/* ── Danger Zone ─────────────────────────────────── */}
					<Section title={t("dangerZone")} color="kk.error" defaultOpen={false}>
						<Text fontSize="sm" color="kk.textSecondary" mb="3">
							{t("wipeWarning")}
						</Text>
						{!wipeConfirm ? (
							<Button size="sm" variant="outline" borderColor="kk.error" color="kk.error" px="4" py="2" _hover={{ bg: "rgba(255,23,68,0.1)" }} onClick={() => setWipeConfirm(true)}>
								{t("wipeDevice")}
							</Button>
						) : (
							<Flex gap="3">
								<Button size="sm" bg="kk.error" color="white" px="4" py="2" _hover={{ opacity: 0.8 }} onClick={wipeDevice} disabled={wiping}>
									{wiping ? t("wiping") : t("confirmWipe")}
								</Button>
								<Button size="sm" variant="ghost" color="kk.textSecondary" px="4" py="2" onClick={() => setWipeConfirm(false)}>
									{t("cancel", { ns: "common" })}
								</Button>
							</Flex>
						)}

						<Box borderTop="1px solid" borderColor="whiteAlpha.100" mt="4" pt="4">
							<Text fontSize="sm" color="kk.textSecondary" mb="3">
								{t("factoryResetWarning")}
							</Text>
							{!resetConfirm ? (
								<Button size="sm" variant="outline" borderColor="kk.error" color="kk.error" px="4" py="2" _hover={{ bg: "rgba(255,23,68,0.1)" }} onClick={() => setResetConfirm(true)}>
									{t("factoryResetApp")}
								</Button>
							) : (
								<VStack gap="3" align="stretch">
									<Text fontSize="xs" color="kk.textSecondary" bg="whiteAlpha.50" borderRadius="md" px="3" py="2">
										{t("factoryResetQuitting")}
									</Text>
									<Flex gap="3">
										<Button size="sm" bg="kk.error" color="white" px="4" py="2" _hover={{ opacity: 0.8 }} onClick={factoryReset} disabled={resetting}>
											{resetting ? t("resetting") : t("confirmFactoryReset")}
										</Button>
										<Button size="sm" variant="ghost" color="kk.textSecondary" px="4" py="2" onClick={() => setResetConfirm(false)} disabled={resetting}>
											{t("cancel", { ns: "common" })}
										</Button>
									</Flex>
								</VStack>
							)}
						</Box>
					</Section>

				</VStack>
			</Box>
		</>
	)
}

function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<Flex justify="space-between" align="center">
			<Text fontSize="sm" color="kk.textSecondary">{label}</Text>
			<Text fontSize="sm" color="kk.textPrimary" fontFamily="mono">{value}</Text>
		</Flex>
	)
}
