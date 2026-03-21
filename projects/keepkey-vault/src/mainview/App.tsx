import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { PinEntry } from "./components/device/PinEntry"
import { PassphraseEntry } from "./components/device/PassphraseEntry"
import { RecoveryWordEntry } from "./components/device/RecoveryWordEntry"
import { PairingApproval } from "./components/device/PairingApproval"
import { SigningApproval } from "./components/device/SigningApproval"
import { ApiAuditLog } from "./components/ApiAuditLog"
import { PairedAppsPanel } from "./components/PairedAppsPanel"
import { WalletConnectPanel } from "./components/WalletConnectPanel"
import { FirmwareDropZone } from "./components/FirmwareDropZone"
import { SplashScreen } from "./components/SplashScreen"
import { WatchOnlyPrompt } from "./components/WatchOnlyPrompt"
import { DeviceClaimedDialog } from "./components/DeviceClaimedDialog"
import { OobSetupWizard } from "./components/OobSetupWizard"
import { TopNav, SplashNav } from "./components/TopNav"
import { WindowResizeHandles } from "./components/WindowResizeHandles"
import type { NavTab } from "./components/TopNav"
import { Dashboard } from "./components/Dashboard"
import { AppStore } from "./components/AppStore"
import { DeviceSettingsDrawer } from "./components/DeviceSettingsDrawer"
import { UpdateBanner } from "./components/UpdateBanner"
import { useDeviceState } from "./hooks/useDeviceState"
import { useUpdateState } from "./hooks/useUpdateState"
import { rpcRequest, onRpcMessage } from "./lib/rpc"
import { Z } from "./lib/z-index"
import { ActivityTracker } from "./components/ActivityTracker"
import type { PinRequestType, PairingRequestInfo, SigningRequestInfo, ApiLogEntry, AppSettings } from "../shared/types"

type AppPhase = "splash" | "claimed" | "setup" | "ready"

function App() {
	const { t } = useTranslation()
	const deviceState = useDeviceState()
	const update = useUpdateState()
	const [wizardComplete, setWizardComplete] = useState(false)
	const [setupInProgress, setSetupInProgress] = useState(false)
	// Ref-based OOB lock: once the device enters an OOB state, keep the wizard
	// mounted through disconnects. The state-based setupInProgress can lose races
	// with React render batching on fast USB detach/reattach cycles (Windows).
	const oobEnteredRef = useRef(false)
	const oobClaimStuckSince = useRef<number | null>(null)
	const [portfolioLoaded, setPortfolioLoaded] = useState(false)
	const [settingsOpen, setSettingsOpen] = useState(false)
	const [activeTab, setActiveTab] = useState<NavTab>("vault")
	const [updateDismissed, setUpdateDismissed] = useState(false)
	const [appVersion, setAppVersion] = useState<{ version: string; channel: string } | null>(null)
	const [restApiEnabled, setRestApiEnabled] = useState(false)
	const [swapsEnabled, setSwapsEnabled] = useState(false)
	const [pendingAppUrl, setPendingAppUrl] = useState<string | null>(null)
	const [pendingWcOpen, setPendingWcOpen] = useState(false)
	const [enablingApi, setEnablingApi] = useState(false)

	// ── WalletConnect sidebar ────────────────────────────────────
	const [wcPanelOpen, setWcPanelOpen] = useState(false)
	const [wcUri, setWcUri] = useState<string | null>(null)

	// ── Watch-only mode ──────────────────────────────────────────
	const [watchOnlyAvailable, setWatchOnlyAvailable] = useState(false)
	const [watchOnlyMode, setWatchOnlyMode] = useState(false)
	const [watchOnlyLabel, setWatchOnlyLabel] = useState("")
	const [watchOnlyLastSynced, setWatchOnlyLastSynced] = useState(0)


	// Fetch app version + REST API state on mount
	useEffect(() => {
		rpcRequest<{ version: string; channel: string }>("getAppVersion")
			.then(setAppVersion)
			.catch(() => {})
		rpcRequest<AppSettings>("getAppSettings")
			.then((s) => { setRestApiEnabled(s.restApiEnabled); setSwapsEnabled(s.swapsEnabled) })
			.catch(() => {})
	}, [])

	// Reset dismiss when update phase transitions to available or ready
	useEffect(() => {
		if (update.phase === "available" || update.phase === "ready") {
			setUpdateDismissed(false)
		}
	}, [update.phase])

	// ── PIN overlay ─────────────────────────────────────────────────
	const [pinRequestType, setPinRequestType] = useState<PinRequestType | null>(null)
	const [pinDismissed, setPinDismissed] = useState(false)
	const [pinFailed, setPinFailed] = useState(false)
	const pinDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		return onRpcMessage("pin-request", (payload) => {
			if (pinDismissTimer.current) { clearTimeout(pinDismissTimer.current); pinDismissTimer.current = null }
			setPinDismissed(false) // new request from device resets dismiss
			setPinRequestType(payload.type as PinRequestType)
		})
	}, [])

	// Listen for pin-error from backend (wrong PIN detected)
	useEffect(() => {
		return onRpcMessage("pin-error", () => {
			setPinFailed(true)
		})
	}, [])

	const handlePinSubmit = useCallback(async (pin: string) => {
		setPinFailed(false)
		try { await rpcRequest("sendPin", { pin }) } catch (e) { console.error("sendPin:", e) }
		setPinRequestType(null)
		// Temporarily suppress auto-show to prevent flicker while device verifies.
		// Reset after 5s so the overlay re-appears if PIN was wrong or device still locked.
		setPinDismissed(true)
		if (pinDismissTimer.current) clearTimeout(pinDismissTimer.current)
		pinDismissTimer.current = setTimeout(() => setPinDismissed(false), 5000)
	}, [])

	const handlePinCancel = useCallback(() => {
		setPinRequestType(null)
		setPinDismissed(true)
		// Allow re-show after 10s even on cancel — device still expects PIN
		if (pinDismissTimer.current) clearTimeout(pinDismissTimer.current)
		pinDismissTimer.current = setTimeout(() => setPinDismissed(false), 10000)
	}, [])

	const handlePinWipe = useCallback(async () => {
		try {
			await rpcRequest("wipeDevice", undefined, 0)
		} catch (e) { console.error("wipeDevice from PIN:", e) }
		setPinRequestType(null)
		setPinDismissed(true)
	}, [])

	// ── Passphrase overlay ──────────────────────────────────────────
	const [passphraseRequested, setPassphraseRequested] = useState(false)

	useEffect(() => {
		return onRpcMessage("passphrase-request", () => {
			setPinRequestType(null) // PIN was already handled — dismiss its overlay
			setPinDismissed(true)   // prevent auto-show effect from re-arming PIN
			setPassphraseRequested(true)
		})
	}, [])

	const handlePassphraseSubmit = useCallback(async (passphrase: string) => {
		try { await rpcRequest("sendPassphrase", { passphrase }) } catch (e) { console.error("sendPassphrase:", e) }
		setPinRequestType(null)
		// Don't dismiss overlay here — sendPassphrase returns instantly (omitLock/noWait)
		// but the device still needs physical confirmation. The overlay stays visible
		// showing "Confirm on your KeepKey" until state transitions to 'ready'.
	}, [])

	const handlePassphraseCancel = useCallback(() => { setPinRequestType(null); setPassphraseRequested(false) }, [])

	// Auto-show passphrase overlay when device needs passphrase.
	// Do NOT auto-dismiss here — the dialog must stay visible showing
	// "Confirm on device" after the user submits until state reaches 'ready'.
	// Dismissal is handled by the 'ready'/'disconnected' cleanup effect below.
	useEffect(() => {
		if (deviceState.state === "needs_passphrase" && !passphraseRequested) {
			setPassphraseRequested(true)
		}
	}, [deviceState.state, passphraseRequested])

	// ── Pairing approval overlay ────────────────────────────────────
	const [pairRequest, setPairRequest] = useState<PairingRequestInfo | null>(null)

	useEffect(() => {
		const unsub1 = onRpcMessage("pair-request", (payload) => {
			setPairRequest(payload as PairingRequestInfo)
		})
		// Dismiss overlay on timeout or external resolution
		const unsub2 = onRpcMessage("pair-dismissed", () => {
			setPairRequest(null)
		})
		return () => { unsub1(); unsub2() }
	}, [])

	const handleApprovePairing = useCallback(async () => {
		try { await rpcRequest("approvePairing") } catch (e) { console.error("approvePairing:", e) }
		setPairRequest(null)
	}, [])

	const handleRejectPairing = useCallback(async () => {
		try { await rpcRequest("rejectPairing") } catch (e) { console.error("rejectPairing:", e) }
		setPairRequest(null)
	}, [])

	// ── Signing approval overlay ────────────────────────────────────
	const [signingRequest, setSigningRequest] = useState<SigningRequestInfo | null>(null)
	const [signingPhase, setSigningPhase] = useState<'approve' | 'device-confirm'>('approve')

	useEffect(() => {
		const unsub1 = onRpcMessage("signing-request", (payload) => {
			setSigningPhase('approve')
			setSigningRequest(payload as SigningRequestInfo)
		})
		const unsub2 = onRpcMessage("signing-dismissed", () => {
			setSigningRequest(null)
			setSigningPhase('approve')
		})
		return () => { unsub1(); unsub2() }
	}, [])

	const handleApproveSign = useCallback(async () => {
		if (!signingRequest) return
		// Transition overlay to "confirm on device" — don't dismiss yet
		setSigningPhase('device-confirm')
		try {
			await rpcRequest("approveSigningRequest", { id: signingRequest.id })
		} catch (e) {
			console.error("approveSign:", e)
			// RPC failed (device disconnected, timeout, etc.) — revert to actionable
			// approve/reject state so the user isn't stuck on a dead "confirm on device" overlay.
			setSigningPhase('approve')
		}
		// On success, overlay stays open until 'signing-dismissed' RPC arrives from bun side
	}, [signingRequest])

	const handleRejectSign = useCallback(async () => {
		if (!signingRequest) return
		try { await rpcRequest("rejectSigningRequest", { id: signingRequest.id }) } catch (e) { console.error("rejectSign:", e) }
		setSigningRequest(null)
		setSigningPhase('approve')
	}, [signingRequest])

	// ── Paired Apps panel ───────────────────────────────────────────
	const [pairedAppsOpen, setPairedAppsOpen] = useState(false)

	// ── API Audit Log ───────────────────────────────────────────────
	const [auditLogOpen, setAuditLogOpen] = useState(false)
	const [auditLogEntries, setAuditLogEntries] = useState<ApiLogEntry[]>([])
	// Load persisted API logs from SQLite on mount
	useEffect(() => {
		rpcRequest<ApiLogEntry[]>("getApiLogs", { limit: 200 })
			.then((logs) => {
				if (logs?.length) setAuditLogEntries(logs)
			})
			.catch(() => {})
	}, [])

	useEffect(() => {
		return onRpcMessage("api-log", (payload) => {
			const entry = payload as ApiLogEntry
			setAuditLogEntries((prev) => {
				const next = [entry, ...prev]
				return next.length > 200 ? next.slice(0, 200) : next
			})
			// Only auto-open for external dApp requests that need user attention
		// (never for internal vault operations like sending a tx)
		})
	}, [])

	// ── WalletConnect deep link listener ────────────────────────────
	useEffect(() => {
		return onRpcMessage("walletconnect-uri", (uri) => {
			setWcUri(uri as string)
			// Gate through the same API Bridge dialog
			setPendingWcOpen(true)
			setPendingAppUrl("walletconnect")
		})
	}, [])

	// ── Character request overlay (cipher recovery) ─────────────────
	const [charRequest, setCharRequest] = useState<{ wordPos: number; characterPos: number } | null>(null)
	const [recoveryError, setRecoveryError] = useState<{ message: string; errorType: string } | null>(null)
	const [recoveryWordCount, setRecoveryWordCount] = useState(12)

	useEffect(() => {
		return onRpcMessage("character-request", (payload) => {
			setRecoveryError(null)
			setCharRequest({ wordPos: payload.wordPos, characterPos: payload.characterPos })
		})
	}, [])

	useEffect(() => {
		return onRpcMessage("recovery-error", (payload) => {
			setRecoveryError({ message: payload.message || "Recovery failed", errorType: payload.errorType || "unknown" })
		})
	}, [])

	const handleCharacter = useCallback(async (c: string) => {
		try { await rpcRequest("sendCharacter", { character: c }) } catch (e) { console.error(e) }
	}, [])
	const handleCharDelete = useCallback(async () => {
		try { await rpcRequest("sendCharacterDelete") } catch (e) { console.error(e) }
	}, [])
	const handleCharDone = useCallback(async () => {
		try { await rpcRequest("sendCharacterDone") } catch (e) { console.error(e) }
		setCharRequest(null)
	}, [])
	const handleRecoveryDismiss = useCallback(() => {
		setCharRequest(null)
		setRecoveryError(null)
	}, [])
	const handleRecoveryRetry = useCallback(() => {
		// Dismiss error overlay — let the wizard/settings UI handle re-initiation
		setCharRequest(null)
		setRecoveryError(null)
	}, [])

	// Auto-show PIN for locked device (only once — respect user dismiss)
	// Skip auto-show during any firmware operation phase — backend promptPin handles it with a delay
	useEffect(() => {
		if (deviceState.state === "needs_pin" && !pinRequestType && !pinDismissed && (!deviceState.updatePhase || deviceState.updatePhase === "idle")) {
			setPinRequestType("current")
		}
	}, [deviceState.state, deviceState.updatePhase, pinRequestType, pinDismissed])

	// Clear overlays on ready or disconnect
	useEffect(() => {
		if (deviceState.state === "ready" || deviceState.state === "disconnected") {
			setPinRequestType(null)
			setCharRequest(null)
			setPassphraseRequested(false)
			setPinDismissed(false) // reset dismiss on state transitions
			setPinFailed(false)
		}
		// Device re-locked during passphrase flow (auto-lock timer) — dismiss
		// passphrase overlay so PIN overlay can take priority.
		if (deviceState.state === "needs_pin" && passphraseRequested) {
			setPassphraseRequested(false)
		}
	}, [deviceState.state, passphraseRequested])

	const handlePortfolioLoaded = useCallback(() => setPortfolioLoaded(true), [])

	// Reset portfolioLoaded only on disconnect (not transient state changes)
	useEffect(() => {
		if (deviceState.state === "disconnected") setPortfolioLoaded(false)
	}, [deviceState.state])

	// Watch-only: check cache when disconnected, auto-exit when device connects
	useEffect(() => {
		if (deviceState.state === "disconnected") {
			rpcRequest<{ available: boolean; deviceLabel?: string; lastSynced?: number }>("checkWatchOnlyCache")
				.then((res) => {
					if (res.available) {
						setWatchOnlyAvailable(true)
						setWatchOnlyLabel(res.deviceLabel || "")
						setWatchOnlyLastSynced(res.lastSynced || 0)
					}
				})
				.catch(() => {})
		} else {
			// Device found — exit watch-only seamlessly
			setWatchOnlyAvailable(false)
			setWatchOnlyMode(false)
		}
	}, [deviceState.state])


	// ── Launch an external app (gate on REST API) ──────────────────
	const launchApp = useCallback(async (url: string) => {
		try {
			await rpcRequest("openUrl", { url }, 5000)
		} catch (e) {
			console.error("Failed to open app:", e)
		}
		setAuditLogOpen(true)
	}, [])

	// ── Tab change handler ──────────────────────────────────────────
	const handleTabChange = useCallback(async (tab: NavTab) => {
		if (tab === "shapeshift") {
			if (!restApiEnabled) {
				setPendingAppUrl("https://app.shapeshift.com")
				return
			}
			await launchApp("https://app.shapeshift.com")
			return
		}
		setActiveTab(tab)
	}, [restApiEnabled, launchApp])

	// ── Open app from AppStore ───────────────────────────────────────
	const handleOpenApp = useCallback(async (url: string) => {
		if (!restApiEnabled) {
			setPendingAppUrl(url)
			return
		}
		await launchApp(url)
	}, [restApiEnabled, launchApp])

	// ── Enable API dialog handlers ──────────────────────────────────
	const handleEnableApiAndLaunch = useCallback(async () => {
		if (!pendingAppUrl && !pendingWcOpen) return
		setEnablingApi(true)
		try {
			// Enable REST API if not already on
			if (!restApiEnabled) {
				const result = await rpcRequest<AppSettings>("setRestApiEnabled", { enabled: true }, 10000)
				setRestApiEnabled(result.restApiEnabled)
				if (!result.restApiEnabled) {
					setEnablingApi(false)
					setPendingAppUrl(null)
					setPendingWcOpen(false)
					return
				}
			}

			if (pendingWcOpen) {
				// Poll health endpoint — don't open panel until API is actually responding
				let ready = false
				for (let i = 0; i < 20; i++) {
					try {
						const resp = await fetch("http://localhost:1646/api/health")
						if (resp.ok) { ready = true; break }
					} catch { /* not yet */ }
					await new Promise(r => setTimeout(r, 300))
				}
				if (ready) {
					setWcPanelOpen(true)
				} else {
					console.error("REST API did not become ready in time")
				}
			} else if (pendingAppUrl) {
				await launchApp(pendingAppUrl)
			}
		} catch (e) {
			console.error("Failed to enable REST API:", e)
		}
		setEnablingApi(false)
		setPendingAppUrl(null)
		setPendingWcOpen(false)
	}, [pendingAppUrl, pendingWcOpen, restApiEnabled, launchApp])

	const handleCancelAppLaunch = useCallback(() => {
		setPendingAppUrl(null)
		setPendingWcOpen(false)
	}, [])

	const handleOpenKeepKey = useCallback(() => {
		setActiveTab("vault")
	}, [])

	// ── WalletConnect panel handlers ─────────────────────────────
	const handleOpenWalletConnect = useCallback(() => {
		// Always gate WalletConnect through the API Bridge dialog —
		// the WC dapp iframe needs port 1646 to be up and responding
		setPendingWcOpen(true)
		setPendingAppUrl("walletconnect") // sentinel to trigger the dialog
	}, [])

	const handleCloseWalletConnect = useCallback(() => {
		setWcPanelOpen(false)
		setWcUri(null)
	}, [])

	// ── Phase detection ─────────────────────────────────────────────
	const isClaimed = deviceState.state === "connected_unpaired" && !!deviceState.error

	// Track OOB entry — once the wizard is shown, lock it through disconnects
	if (!wizardComplete && ["bootloader", "needs_firmware", "needs_init"].includes(deviceState.state)) {
		oobEnteredRef.current = true
	}
	if (wizardComplete) {
		oobEnteredRef.current = false
	}

	// Release OOB lock if device is persistently claimed/errored for >30s
	// (another app holding the device, not a transient reboot)
	if (oobEnteredRef.current && isClaimed) {
		if (!oobClaimStuckSince.current) oobClaimStuckSince.current = Date.now()
		else if (Date.now() - oobClaimStuckSince.current > 30000) oobEnteredRef.current = false
	} else {
		oobClaimStuckSince.current = null
	}

	const oobLock = !wizardComplete && (setupInProgress || oobEnteredRef.current)

	const phase: AppPhase =
		// oobLock takes priority — during OOB, transient claim errors are expected
		// (device reboots, brief LIBUSB_ERROR_ACCESS). Don't unmount the wizard.
		oobLock ? "setup"
		: isClaimed ? "claimed"
		: ["disconnected", "connected_unpaired", "error"].includes(deviceState.state) ? "splash"
		: !wizardComplete && ["bootloader", "needs_firmware", "needs_init"].includes(deviceState.state) ? "setup"
		: deviceState.state === "ready" ? "ready"
		: ["needs_pin", "needs_passphrase"].includes(deviceState.state) ? "splash"
		: "splash"

	// ── Overlays (render above everything) ──────────────────────────
	// PIN is highest priority (z-index 2010) — must show above signing
	// approval so users can unlock a PIN-locked device during API signing.
	const signingOverlay = signingRequest ? (
		<SigningApproval request={signingRequest} phase={signingPhase} onApprove={handleApproveSign} onReject={handleRejectSign} />
	) : null

	const pairingOverlay = pairRequest ? (
		<PairingApproval request={pairRequest} onApprove={handleApprovePairing} onReject={handleRejectPairing} />
	) : null

	const passphraseOverlay = passphraseRequested ? (
		<PassphraseEntry onSubmit={handlePassphraseSubmit} onCancel={handlePassphraseCancel} />
	) : null

	const pinOverlay = pinRequestType && !passphraseRequested ? (
		<PinEntry type={pinRequestType} failed={pinFailed} onSubmit={handlePinSubmit} onCancel={handlePinCancel} onWipe={handlePinWipe} />
	) : null

	const charOverlay = (charRequest || recoveryError) ? (
		<RecoveryWordEntry
			wordPos={charRequest?.wordPos ?? 0}
			characterPos={charRequest?.characterPos ?? 0}
			totalWords={recoveryWordCount}
			onCharacter={handleCharacter}
			onDelete={handleCharDelete}
			onDone={handleCharDone}
			onCancel={handleRecoveryDismiss}
			onRetry={handleRecoveryRetry}
			error={recoveryError?.message}
			errorType={recoveryError?.errorType}
		/>
	) : null

	const handleViewPortfolio = useCallback(() => setWatchOnlyMode(true), [])
	const handleConnectWallet = useCallback(() => {
		setWatchOnlyAvailable(false)
		setWatchOnlyMode(false)
	}, [])

	// ── Firmware drop zone (always active) ──────────────────────────
	const firmwareDropZone = <FirmwareDropZone />

	// ── Render phases ───────────────────────────────────────────────

	// SplashNav provides a drag-enabled nav bar with traffic lights for
	// splash / setup / claimed phases (where TopNav isn't rendered).
	const splashNav = <SplashNav />

	const resizeHandles = <WindowResizeHandles />

	// Always-visible update banner (all phases)
	const updateBanner = !updateDismissed && update.phase !== "idle" && update.phase !== "checking" ? (
		<UpdateBanner
			phase={update.phase}
			progress={update.progress}
			message={update.message}
			error={update.error}
			onDownload={update.downloadUpdate}
			onApply={update.applyUpdate}
			onDismiss={() => setUpdateDismissed(true)}
		/>
	) : null

	// Watch-only mode: render dashboard with cached data (read-only)
	if (watchOnlyMode) {
		return (
			<>{resizeHandles}{updateBanner}{firmwareDropZone}
				<Flex direction="column" h="100vh" bg="kk.bg" color="kk.textPrimary">
					<TopNav
						label={watchOnlyLabel || "KeepKey"}
						connected={false}
						firmwareVersion={undefined}
						firmwareVerified={undefined}
						onSettingsToggle={() => setSettingsOpen((o) => !o)}
						settingsOpen={settingsOpen}
						activeTab="vault"
						onTabChange={() => {}}
						watchOnly
					/>
					<Flex flex="1" direction="column" overflow="auto" pt="54px" pb="4">
						<Dashboard watchOnly onLoaded={() => {}} />
					</Flex>
				</Flex>
				<DeviceSettingsDrawer
					open={settingsOpen}
					onClose={() => setSettingsOpen(false)}
					deviceState={deviceState}
					appVersion={appVersion}
					onCheckForUpdate={update.checkForUpdate}
					onDownloadUpdate={update.downloadUpdate}
					onApplyUpdate={update.applyUpdate}
					updatePhase={update.phase}
					updateVersion={update.info?.version}
				/>
			</>
		)
	}

	if (phase === "claimed") {
		return (
			<>{splashNav}{resizeHandles}{updateBanner}{firmwareDropZone}{signingOverlay}{pairingOverlay}{passphraseOverlay}{charOverlay}{pinOverlay}
				<SplashScreen statusText={t("keepkeyDetected", { ns: "nav" })} variant="claimed">
					<DeviceClaimedDialog error={deviceState.error || t("claimed.defaultError", { ns: "device" })} />
				</SplashScreen>
			</>
		)
	}

	if (phase === "splash") {
		const isConnecting = deviceState.state === "connected_unpaired"
		const isError = deviceState.state === "error"
		const needsPin = deviceState.state === "needs_pin"
		const needsPassphrase = deviceState.state === "needs_passphrase"
		return (
			<>{splashNav}{resizeHandles}{updateBanner}{firmwareDropZone}{signingOverlay}{pairingOverlay}{passphraseOverlay}{charOverlay}{pinOverlay}
				<SplashScreen
					statusText={
						needsPin ? t("unlockYourKeepKey", { ns: "nav" })
						: needsPassphrase ? t("passphraseRequired", { ns: "nav" })
						: isConnecting ? t("keepkeyDetectedConnecting", { ns: "nav" })
						: isError ? t("errorWithMessage", { ns: "nav", error: deviceState.error || "Unknown" })
						: t("searchingForKeepKey", { ns: "nav" })
					}
					hintText={isError ? t("tryUnplugging", { ns: "nav" }) : undefined}
					variant={needsPin || needsPassphrase || isConnecting ? "connecting" : isError ? "error" : "searching"}
				>
					{watchOnlyAvailable && deviceState.state === "disconnected" && (
						<WatchOnlyPrompt
							deviceLabel={watchOnlyLabel}
							lastSynced={watchOnlyLastSynced}
							onViewPortfolio={handleViewPortfolio}
							onConnectWallet={handleConnectWallet}
						/>
					)}
				</SplashScreen>
			</>
		)
	}

	if (phase === "setup") {
		return (
			<>{splashNav}{resizeHandles}{updateBanner}{firmwareDropZone}{signingOverlay}{pairingOverlay}{passphraseOverlay}{charOverlay}{pinOverlay}
				<OobSetupWizard onComplete={() => { setWizardComplete(true); setSetupInProgress(false) }} onSetupInProgress={setSetupInProgress} onWordCountChange={setRecoveryWordCount} />
			</>
		)
	}

	// ── Ready phase ─────────────────────────────────────────────────
	// Warning/error are now bottom-right toasts — only push content down for actionable top banners
	const showBanner = !updateDismissed && update.phase !== "idle" && update.phase !== "checking" && update.phase !== "warning" && update.phase !== "error"

	return (
		<>{resizeHandles}{updateBanner}{firmwareDropZone}{signingOverlay}{pairingOverlay}{passphraseOverlay}{charOverlay}{pinOverlay}
			{!portfolioLoaded && activeTab === "vault" && (
				<SplashScreen statusText={t("loadingPortfolio", { ns: "nav" })} variant="connecting" />
			)}
			<Flex direction="column" h="100vh" bg="kk.bg" color="kk.textPrimary"
				{...(!portfolioLoaded && activeTab === "vault" ? { position: "absolute", w: 0, h: 0, overflow: "hidden" } as const : {})}
			>
				<TopNav
					label={deviceState.label}
					connected={deviceState.state === "ready"}
					firmwareVersion={deviceState.firmwareVersion}
					firmwareVerified={deviceState.firmwareVerified}
					needsFirmwareUpdate={deviceState.needsFirmwareUpdate}
					latestFirmware={deviceState.latestFirmware}
					onSettingsToggle={() => setSettingsOpen((o) => !o)}
					settingsOpen={settingsOpen}
					activeTab={activeTab}
					onTabChange={handleTabChange}
					passphraseActive={deviceState.passphraseProtection}
				/>
				<Flex flex="1" direction="column" overflow="auto" pt={showBanner ? "104px" : "54px"} pb="4" transition="padding-top 0.2s">
				{/* pt: 54px TopNav + 50px banner height when visible */}
					{activeTab === "vault" && <Dashboard onLoaded={handlePortfolioLoaded} onOpenSettings={() => setSettingsOpen(true)} firmwareVersion={deviceState.firmwareVersion} forceRefresh={wizardComplete} onForceRefreshConsumed={() => setWizardComplete(false)} />}
					{activeTab === "apps" && <AppStore onOpenApp={handleOpenApp} onOpenKeepKey={handleOpenKeepKey} onOpenWalletConnect={handleOpenWalletConnect} />}
				</Flex>
			</Flex>
			<DeviceSettingsDrawer
				open={settingsOpen}
				onClose={() => {
					setSettingsOpen(false)
					rpcRequest<AppSettings>("getAppSettings")
						.then((s) => { setRestApiEnabled(s.restApiEnabled); setSwapsEnabled(s.swapsEnabled) })
						.catch(() => {})
					window.dispatchEvent(new Event("keepkey-settings-changed"))
				}}
				deviceState={deviceState}
				onCheckForUpdate={update.checkForUpdate}
				onDownloadUpdate={update.downloadUpdate}
				onApplyUpdate={update.applyUpdate}
				updatePhase={update.phase}
				updateVersion={update.info?.version}
				appVersion={appVersion}
				onOpenAuditLog={() => setAuditLogOpen(true)}
				onOpenPairedApps={() => setPairedAppsOpen(true)}
				onRestApiChanged={setRestApiEnabled}
				onWordCountChange={setRecoveryWordCount}
			/>
			<ApiAuditLog
				open={auditLogOpen}
				entries={auditLogEntries}
				onClose={() => setAuditLogOpen(false)}
				side={wcPanelOpen ? "left" : "right"}
			/>
			<PairedAppsPanel
				open={pairedAppsOpen}
				onClose={() => setPairedAppsOpen(false)}
			/>
			<WalletConnectPanel
				open={wcPanelOpen}
				wcUri={wcUri}
				onClose={handleCloseWalletConnect}
			/>
			<ActivityTracker />
			{/* Enable API Bridge dialog — shown when user tries to launch an app with REST disabled */}
			{(pendingAppUrl || pendingWcOpen) && (
				<>
					<Box position="fixed" inset="0" bg="blackAlpha.700" zIndex={Z.dialog} onClick={handleCancelAppLaunch} />
					<Box
						position="fixed"
						top="50%"
						left="50%"
						transform="translate(-50%, -50%)"
						w="380px"
						maxW="90vw"
						bg="kk.bg"
						border="1px solid"
						borderColor="kk.border"
						borderRadius="xl"
						zIndex={Z.dialog + 1}
						overflow="hidden"
						role="dialog"
						aria-modal="true"
						aria-label={t("apiBridge.title", { ns: "dialogs" })}
					>
						<Box px="6" pt="5" pb="4">
							<Flex align="center" gap="2" mb="3">
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M4 11a9 9 0 0 1 9 9" />
									<path d="M4 4a16 16 0 0 1 16 16" />
									<circle cx="5" cy="19" r="1" />
								</svg>
								<Text fontSize="md" fontWeight="600" color="kk.textPrimary">
									{t("apiBridge.title", { ns: "dialogs" })}
								</Text>
							</Flex>
							<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.5" mb="2">
								{restApiEnabled
									? t("apiBridge.descriptionEnabled", { ns: "dialogs" })
									: t("apiBridge.descriptionDisabled", { ns: "dialogs" })
								}
							</Text>
							{!restApiEnabled && (
								<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.5">
									{t("apiBridge.enablePrompt", { ns: "dialogs" })} <Text as="span" color="kk.gold" fontWeight="500">{t("apiBridge.settingsApplication", { ns: "dialogs" })}</Text>.
								</Text>
							)}
						</Box>
						<Flex
							px="6"
							py="4"
							gap="3"
							justify="flex-end"
							borderTop="1px solid"
							borderColor="kk.border"
							bg="rgba(255,255,255,0.02)"
						>
							<Button
								size="sm"
								px="4"
								py="2"
								variant="ghost"
								color="kk.textSecondary"
								_hover={{ color: "kk.textPrimary" }}
								onClick={handleCancelAppLaunch}
								disabled={enablingApi}
							>
								{t("cancel", { ns: "common" })}
							</Button>
							<Button
								size="sm"
								px="4"
								py="2"
								bg="kk.gold"
								color="black"
								fontWeight="600"
								_hover={{ bg: "kk.goldHover" }}
								onClick={handleEnableApiAndLaunch}
								disabled={enablingApi}
							>
								{enablingApi
									? (restApiEnabled ? t("apiBridge.connecting", { ns: "dialogs" }) : t("apiBridge.enabling", { ns: "dialogs" }))
									: pendingWcOpen
										? (restApiEnabled ? t("apiBridge.openWalletConnect", { ns: "dialogs" }) : t("apiBridge.enableAndOpen", { ns: "dialogs" }))
										: t("apiBridge.enableAndLaunch", { ns: "dialogs" })
								}
							</Button>
						</Flex>
					</Box>
				</>
			)}
		</>
	)
}

export default App
