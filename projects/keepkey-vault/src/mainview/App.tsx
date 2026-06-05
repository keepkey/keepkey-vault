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
import { MobilePairingDialog } from "./components/MobilePairingDialog"
import { MobilePanel } from "./components/MobilePanel"
import { WalletConnectPanel } from "./components/WalletConnectPanel"
import { FirmwareDropZone } from "./components/FirmwareDropZone"
import { SplashScreen } from "./components/SplashScreen"
import { DeviceGrid } from "./components/DeviceGrid"
import { DeviceClaimedDialog } from "./components/DeviceClaimedDialog"
import { LinuxUdevWarning } from "./components/LinuxUdevWarning"
import { OobSetupWizard } from "./components/OobSetupWizard"
import { TopNav, SplashNav } from "./components/TopNav"
import { WindowResizeHandles } from "./components/WindowResizeHandles"
import type { NavTab } from "./components/TopNav"
import { Dashboard } from "./components/Dashboard"
import { CommandPalette } from "./components/CommandPalette"
import { useLatestBalances } from "./lib/commandBus"
import { AppStore } from "./components/AppStore"
import { DeviceSettingsDrawer } from "./components/DeviceSettingsDrawer"
import { UpdateBanner } from "./components/UpdateBanner"
import { IncomingTxToast, type IncomingTx } from "./components/IncomingTxToast"
import { useDeviceState } from "./hooks/useDeviceState"
import { useUpdateState } from "./hooks/useUpdateState"
import { rpcRequest, onRpcMessage, rpcFire } from "./lib/rpc"
import { CHAINS, customChainToChainDef, findChainByNetwork, type ChainDef } from "../shared/chains"
import { loadSupportedChains } from "../shared/swap-support-matrix"
import { Z } from "./lib/z-index"
import { ActivityTracker } from "./components/ActivityTracker"
import { SwapRpcMount } from "./components/SwapRpcMount"
import { NAV_CONTENT_OFFSET, NAV_CONTENT_OFFSET_WITH_BANNER } from "./layout"
import type { PinRequestType, PairingRequestInfo, SigningRequestInfo, ApiLogEntry, AppSettings, EmulatorStatus, CustomChain } from "../shared/types"

type AppPhase = "splash" | "claimed" | "setup" | "ready"
type SigningPhase = "approve" | "sending-payload" | "device-confirm"

const SIGNING_PAYLOAD_MIN_MS = 15000

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
	const [gridReady, setGridReady] = useState(false)
	const [settingsOpen, setSettingsOpen] = useState(false)
	const [activeTab, setActiveTab] = useState<NavTab>("vault")
	const [paletteOpen, setPaletteOpen] = useState(false)
	const paletteBalances = useLatestBalances()
	const [updateDismissed, setUpdateDismissed] = useState(false)
	const [appVersion, setAppVersion] = useState<{ version: string; channel: string } | null>(null)
	const [restApiEnabled, setRestApiEnabled] = useState(false)
	const [walletConnectEnabled, setWalletConnectEnabled] = useState(false)
	const [swapsEnabled, setSwapsEnabled] = useState(false)
	const [emulatorEnabled, setEmulatorEnabled] = useState(false)
	const [pendingAppUrl, setPendingAppUrl] = useState<string | null>(null)
	const [pendingWcOpen, setPendingWcOpen] = useState(false)
	const [enablingApi, setEnablingApi] = useState(false)

	// ── WalletConnect sidebar ────────────────────────────────────
	const [wcPanelOpen, setWcPanelOpen] = useState(false)
	const [wcUri, setWcUri] = useState<string | null>(null)
	const [wcNotSupportedOpen, setWcNotSupportedOpen] = useState(false)

	// ── Watch-only mode ──────────────────────────────────────────
	const [watchOnlyAvailable, setWatchOnlyAvailable] = useState(false)
	const [watchOnlyMode, setWatchOnlyMode] = useState(false)
	const [watchOnlyDeviceId, setWatchOnlyDeviceId] = useState<string | undefined>(undefined)
	const [watchOnlyLabel, setWatchOnlyLabel] = useState("")
	const [watchOnlyLastSynced, setWatchOnlyLastSynced] = useState(0)


	// Fetch app version + REST API state on mount
	useEffect(() => {
		rpcRequest<{ version: string; channel: string }>("getAppVersion")
			.then(setAppVersion)
			.catch(() => {})
		const refreshSettings = () => {
			rpcRequest<AppSettings>("getAppSettings")
				.then((s) => {
					setRestApiEnabled(s.restApiEnabled); setWalletConnectEnabled(s.walletConnectEnabled); setSwapsEnabled(s.swapsEnabled); setEmulatorEnabled(s.emulatorEnabled)
					if (s.pioneerApiBase) loadSupportedChains(s.pioneerApiBase).catch(() => {})
				})
				.catch(() => {})
		}
		refreshSettings()
		// Other surfaces (settings drawer close, drop-zone dylib install) flip
		// server-side flags then dispatch this event so the React tree picks up
		// the new state without waiting for the user to reopen settings.
		window.addEventListener("keepkey-settings-changed", refreshSettings)
		return () => window.removeEventListener("keepkey-settings-changed", refreshSettings)
	}, [])

	// ── REST API UI-active handshake ─────────────────────────────────
	// The Bun process refuses to serve pubkeys/addresses on port 1646 unless
	// the Vault UI signals it's open + heartbeats regularly. `viewDeviceId`
	// scopes serving to the device the user currently has open, so a
	// 3rd-party request can never get xpubs from a device the user isn't
	// actively viewing (incl. watch-only mode which uses the cached device).
	//
	// Defer activation until we know which device the UI is bound to. On
	// fresh mount `deviceState.deviceId` is null until the engine state
	// machine reports `ready`; activating with viewDeviceId=null in that
	// window would let a stale on-disk pubkey cache from a prior session
	// be served against the wrong (or no) device, since requireUiActive
	// only enforces device matching when uiState.viewDeviceId is truthy.
	useEffect(() => {
		const viewDeviceId = watchOnlyMode ? (watchOnlyDeviceId ?? null) : (deviceState.deviceId ?? null)
		if (!viewDeviceId) return
		rpcRequest("uiSetActive", { active: true, viewDeviceId }).catch(() => {})
		const heartbeat = setInterval(() => {
			rpcRequest("uiHeartbeat", { viewDeviceId }).catch(() => {})
		}, 15_000)
		const beforeUnload = () => {
			try { rpcRequest("uiSetActive", { active: false, viewDeviceId: null }).catch(() => {}) } catch { /* ignore */ }
		}
		window.addEventListener("beforeunload", beforeUnload)
		return () => {
			clearInterval(heartbeat)
			window.removeEventListener("beforeunload", beforeUnload)
			rpcRequest("uiSetActive", { active: false, viewDeviceId: null }).catch(() => {})
		}
	}, [deviceState.deviceId, watchOnlyMode, watchOnlyDeviceId])

	// Reset dismiss when update phase transitions to available or ready
	useEffect(() => {
		if (update.phase === "available" || update.phase === "ready") {
			setUpdateDismissed(false)
		}
	}, [update.phase])

	// ── Command Palette (⌘K / Ctrl+K) ───────────────────────────────
	// Global toggle. Ignore presses while the user is typing in an input or
	// textarea so we don't hijack search fields elsewhere in the app.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K"))) return
			const target = e.target
			// Allow toggle from inside the palette's own input — only ignore other inputs.
			if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
				const insidePalette = (target as HTMLElement).closest('[aria-label="Command Palette"]')
				if (!insidePalette) return
			}
			e.preventDefault()
			setPaletteOpen((o) => !o)
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [])

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

	// Listen for pin-error from backend (wrong PIN detected).
	// Reset pinFailed first so the false→true transition fires the
	// useEffect inside PinEntry even if it was already true.
	useEffect(() => {
		return onRpcMessage("pin-error", () => {
			setPinFailed(false)
			// Batch in next tick so React sees the transition
			queueMicrotask(() => setPinFailed(true))
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
		setPinFailed(false)
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
		setPinFailed(false)
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
	const [signingPhase, setSigningPhase] = useState<SigningPhase>('approve')
	const signingRequestRef = useRef<SigningRequestInfo | null>(null)
	const signingPhaseRef = useRef<SigningPhase>('approve')
	const signingPayloadStartedAt = useRef<number | null>(null)
	const signingConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const setSigningPhaseTracked = useCallback((phase: SigningPhase) => {
		signingPhaseRef.current = phase
		setSigningPhase(phase)
	}, [])

	const clearSigningConfirmTimer = useCallback(() => {
		if (signingConfirmTimer.current) {
			clearTimeout(signingConfirmTimer.current)
			signingConfirmTimer.current = null
		}
	}, [])

	useEffect(() => {
		const unsub1 = onRpcMessage("signing-request", (payload) => {
			clearSigningConfirmTimer()
			signingPayloadStartedAt.current = null
			const request = payload as SigningRequestInfo
			signingRequestRef.current = request
			setSigningPhaseTracked('approve')
			setSigningRequest(request)
		})
		const unsub2 = onRpcMessage("signing-dismissed", () => {
			clearSigningConfirmTimer()
			signingPayloadStartedAt.current = null
			signingRequestRef.current = null
			setSigningRequest(null)
			setSigningPhaseTracked('approve')
		})
		return () => { unsub1(); unsub2() }
	}, [clearSigningConfirmTimer, setSigningPhaseTracked])

	useEffect(() => {
		return () => clearSigningConfirmTimer()
	}, [clearSigningConfirmTimer])

	useEffect(() => {
		return onRpcMessage("device-button-request", () => {
			if (!signingRequestRef.current || signingPhaseRef.current !== 'sending-payload') return

			const startedAt = signingPayloadStartedAt.current ?? Date.now()
			const elapsedMs = Date.now() - startedAt
			const delayMs = Math.max(0, SIGNING_PAYLOAD_MIN_MS - elapsedMs)

			clearSigningConfirmTimer()
			signingConfirmTimer.current = setTimeout(() => {
				signingConfirmTimer.current = null
				if (signingPhaseRef.current === 'sending-payload') {
					setSigningPhaseTracked('device-confirm')
				}
			}, delayMs)
		})
	}, [clearSigningConfirmTimer, setSigningPhaseTracked])

	const handleApproveSign = useCallback(async () => {
		if (!signingRequest) return
		clearSigningConfirmTimer()
		signingPayloadStartedAt.current = Date.now()
		// The backend is now unblocked and can start writing the request to the
		// device. Wait for the real device ButtonRequest before asking the user
		// to press the physical button.
		setSigningPhaseTracked('sending-payload')
		try {
			await rpcRequest("approveSigningRequest", { id: signingRequest.id })
		} catch (e) {
			console.error("approveSign:", e)
			clearSigningConfirmTimer()
			signingPayloadStartedAt.current = null
			// RPC failed (device disconnected, timeout, etc.) — revert to actionable
			// approve/reject state so the user isn't stuck on a dead "confirm on device" overlay.
			setSigningPhaseTracked('approve')
		}
		// On success, overlay stays open until 'signing-dismissed' RPC arrives from bun side
	}, [clearSigningConfirmTimer, setSigningPhaseTracked, signingRequest])

	const handleRejectSign = useCallback(async () => {
		if (!signingRequest) return
		try { await rpcRequest("rejectSigningRequest", { id: signingRequest.id }) } catch (e) { console.error("rejectSign:", e) }
		clearSigningConfirmTimer()
		signingPayloadStartedAt.current = null
		signingRequestRef.current = null
		setSigningRequest(null)
		setSigningPhaseTracked('approve')
	}, [clearSigningConfirmTimer, setSigningPhaseTracked, signingRequest])

	// ── Paired Apps panel ───────────────────────────────────────────
	const [pairedAppsOpen, setPairedAppsOpen] = useState(false)

	// ── Mobile panel + pairing dialog ───────────────────────────────
	const [mobilePanelOpen, setMobilePanelOpen] = useState(false)
	const [mobilePairingOpen, setMobilePairingOpen] = useState(false)

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
	// This fires only when WC is DISABLED (backend sends URI to frontend).
	// When WC is enabled, the backend pairs natively and never sends this message.
	useEffect(() => {
		return onRpcMessage("walletconnect-uri", (_uri) => {
			setWcNotSupportedOpen(true)
		})
	}, [])

	// Warm-path WC deep link: backend hands us the URI so the panel can mount
	// *before* the session_proposal arrives — the pair-approval modal lives
	// inside the panel, so opening it after the proposal would let the modal
	// render invisibly and silently time out at 120s.
	useEffect(() => {
		return onRpcMessage("wc-deep-link-pair", (data) => {
			const { uri } = data as { uri: string }
			if (!walletConnectEnabled) {
				setWcNotSupportedOpen(true)
				return
			}
			setWcUri(uri)
			setWcPanelOpen(true)
		})
	}, [walletConnectEnabled])

	// Force-open the panel whenever a pair proposal arrives. The pair-approval
	// modal lives inside WalletConnectPanel and renders nothing while the panel
	// is closed — so a proposal landing after the user closed the panel (e.g.
	// closed it between hitting Pair and the session_proposal arriving) would
	// be invisible until the 120s backend timeout. The panel keeps its own
	// listener for the request payload; this one only ensures visibility.
	useEffect(() => {
		return onRpcMessage("wc-pair-request", () => {
			setWcPanelOpen(true)
		})
	}, [])

	// ── Incoming payment toast + live per-chain resync ──────────────
	// SSE event-stream pushes 'tx-push-received' when a watched address sees a
	// tx. This lives in App (always mounted) rather than Dashboard (mounted only
	// on the vault tab) so the resync also fires while the user is on another tab.
	// networkId is the reliable matching key; caip is the fallback.
	const [incomingTx, setIncomingTx] = useState<IncomingTx | null>(null)
	const dismissIncomingTx = useCallback(() => setIncomingTx(null), [])
	// Custom chains aren't in the built-in CHAINS list — load them so a tx on a
	// user-added chain still resolves. Reload on 'keepkey-settings-changed', which
	// AddChainDialog dispatches after a successful add (and the settings drawer on close).
	const [customChainDefs, setCustomChainDefs] = useState<ChainDef[]>([])
	useEffect(() => {
		const load = () => rpcRequest<CustomChain[]>("getCustomChains", undefined, 5000)
			.then(chains => setCustomChainDefs(chains.map(customChainToChainDef)))
			.catch(() => {})
		load()
		window.addEventListener("keepkey-settings-changed", load)
		return () => window.removeEventListener("keepkey-settings-changed", load)
	}, [])
	useEffect(() => {
		return onRpcMessage("tx-push-received", (payload: { chain?: string; networkId?: string; type?: "incoming" | "outgoing" | "confirmed" }) => {
			const def = findChainByNetwork(payload.networkId, payload.chain, [...CHAINS, ...customChainDefs])
			// Resync the affected chain regardless of direction — both inbound and
			// outbound txs change the balance. Backend pushes 'balance-updated' back.
			if (def) rpcFire("getBalance", { chainId: def.id })
			// Toast only for genuine inbound payments. New object identity on every
			// event → resets the auto-dismiss timer below.
			if (payload.type === "incoming") setIncomingTx({ chainName: def?.coin })
		})
	}, [customChainDefs])
	// Auto-dismiss after 6s. Armed here (not in the toast) so it fires even while
	// the toast is unmounted — e.g. device disconnects mid-display and the
	// ready-phase view unmounts — preventing a stale toast on reconnect.
	useEffect(() => {
		if (!incomingTx) return
		const timer = setTimeout(() => setIncomingTx(null), 6000)
		return () => clearTimeout(timer)
	}, [incomingTx])

	// ── Check for pending deep link from cold start ─────────────────
	useEffect(() => {
		rpcRequest<string | null>("getPendingDeepLink").then(uri => {
			if (uri) {
				if (walletConnectEnabled) {
					// Set URI and open panel — panel's auto-pair effect handles pairing + errors
					setWcUri(uri)
					setWcPanelOpen(true)
				} else {
					setWcNotSupportedOpen(true)
				}
				// Consume so it's not re-delivered on next mount
				rpcRequest("consumePendingDeepLink").catch(() => {})
			}
		}).catch(() => {})
	}, [walletConnectEnabled])

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
		if (!walletConnectEnabled) {
			setWcNotSupportedOpen(true)
			return
		}
		// Native WC — open the panel directly (no REST API needed)
		setWcPanelOpen(true)
	}, [walletConnectEnabled])

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

	const incomingTxToast = <IncomingTxToast tx={incomingTx} onDismiss={dismissIncomingTx} />

	// Watch-only mode: render dashboard with cached data (read-only)
	if (watchOnlyMode) {
		return (
			<>{resizeHandles}{updateBanner}{firmwareDropZone}
				<Flex direction="column" h="100vh" bg="transparent" color="kk.textPrimary">
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
						onExitToDeviceSelect={() => { setWatchOnlyMode(false); setWatchOnlyDeviceId(undefined) }}
					/>
					<Flex flex="1" direction="column" overflow="auto" pt={NAV_CONTENT_OFFSET} pb="4">
						<Dashboard watchOnly watchOnlyDeviceId={watchOnlyDeviceId} onLoaded={() => {}} />
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
				<CommandPalette
					open={paletteOpen}
					onClose={() => setPaletteOpen(false)}
					onJumpToVault={() => setActiveTab("vault")}
					balances={paletteBalances}
					firmwareVersion={undefined}
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
		const linuxUdevBlocked = !!deviceState.linuxUdevPermissionDenied
		return (
			<>{splashNav}{resizeHandles}{updateBanner}{firmwareDropZone}{signingOverlay}{pairingOverlay}{passphraseOverlay}{charOverlay}{pinOverlay}
				<SplashScreen
					statusText={
						linuxUdevBlocked ? "KeepKey detected — install udev rules to continue"
						: needsPin ? t("unlockYourKeepKey", { ns: "nav" })
						: needsPassphrase ? t("passphraseRequired", { ns: "nav" })
						: isConnecting ? t("keepkeyDetectedConnecting", { ns: "nav" })
						: isError ? t("errorWithMessage", { ns: "nav", error: deviceState.error || "Unknown" })
						: t("searchingForKeepKey", { ns: "nav" })
					}
					hintText={isError ? t("tryUnplugging", { ns: "nav" }) : undefined}
					variant={linuxUdevBlocked ? "error" : needsPin || needsPassphrase || isConnecting ? "connecting" : isError ? "error" : "searching"}
					childrenReady={linuxUdevBlocked ? true : gridReady}
					onLogoClick={linuxUdevBlocked || needsPin || needsPassphrase ? undefined : () => { rpcRequest("retryConnect").catch(() => {}) }}
				>
					{linuxUdevBlocked ? (
						<LinuxUdevWarning />
					) : (
						/* Unified device grid — registered devices + emulator wallets */
						<DeviceGrid
							onViewPortfolio={(id, label) => { setWatchOnlyDeviceId(id); setWatchOnlyLabel(label); setWatchOnlyMode(true) }}
							onReady={() => setGridReady(true)}
							emulatorEnabled={emulatorEnabled}
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
		<>{resizeHandles}{updateBanner}{incomingTxToast}{firmwareDropZone}{signingOverlay}{pairingOverlay}{passphraseOverlay}{charOverlay}{pinOverlay}
			{!portfolioLoaded && activeTab === "vault" && (
				<SplashScreen statusText={t("loadingPortfolio", { ns: "nav" })} variant="connecting" />
			)}
			<Flex direction="column" h="100vh" bg="transparent" color="kk.textPrimary" position="relative"
				{...(!portfolioLoaded && activeTab === "vault" ? { position: "absolute", w: 0, h: 0, overflow: "hidden" } as const : {})}
			>
				{/* Full-screen ambient radial glow — replaces the per-card glow inside the orbital view. */}
				<Box
					position="absolute"
					inset="0"
					pointerEvents="none"
					zIndex={0}
					style={{
						background: 'radial-gradient(ellipse 70% 55% at 50% 42%, rgba(233,196,106,0.22) 0%, rgba(139,227,196,0.06) 35%, transparent 75%)',
					}}
				/>
				<TopNav
					label={deviceState.label}
					connected={deviceState.state === "ready"}
					firmwareVersion={deviceState.firmwareVersion}
					firmwareVerified={deviceState.firmwareVerified}
					needsFirmwareUpdate={deviceState.needsFirmwareUpdate}
					latestFirmware={deviceState.latestFirmware}
					isEmulator={deviceState.isEmulator}
					onSettingsToggle={() => setSettingsOpen((o) => !o)}
					onMobileToggle={() => setMobilePanelOpen((o) => !o)}
					onWalletConnectToggle={walletConnectEnabled ? handleOpenWalletConnect : undefined}
					settingsOpen={settingsOpen}
					mobileOpen={mobilePanelOpen}
					walletConnectOpen={wcPanelOpen}
					activeTab={activeTab}
					onTabChange={handleTabChange}
					passphraseActive={deviceState.isHiddenWallet}
					onExitToDeviceSelect={deviceState.isEmulator ? () => { rpcRequest("emulatorStop").catch(() => {}) } : undefined}
				/>
				<Flex flex="1" direction="column" overflow="auto" pt={showBanner ? NAV_CONTENT_OFFSET_WITH_BANNER : NAV_CONTENT_OFFSET} pb="4" transition="padding-top 0.2s">
				{/* TopNav offset plus banner height when visible. */}
					{activeTab === "vault" && <Dashboard onLoaded={handlePortfolioLoaded} onOpenSettings={() => setSettingsOpen(true)} firmwareVersion={deviceState.firmwareVersion} forceRefresh={wizardComplete} onForceRefreshConsumed={() => setWizardComplete(false)} isHiddenWallet={deviceState.isHiddenWallet} />}
					{activeTab === "apps" && <AppStore onOpenApp={handleOpenApp} onOpenKeepKey={handleOpenKeepKey} />}
				</Flex>
			</Flex>
			<DeviceSettingsDrawer
				open={settingsOpen}
				onClose={() => {
					setSettingsOpen(false)
					rpcRequest<AppSettings>("getAppSettings")
						.then((s) => { setRestApiEnabled(s.restApiEnabled); setWalletConnectEnabled(s.walletConnectEnabled); setSwapsEnabled(s.swapsEnabled); setEmulatorEnabled(s.emulatorEnabled) })
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
				onOpenMobilePairing={() => setMobilePairingOpen(true)}
				onRestApiChanged={setRestApiEnabled}
				onWordCountChange={setRecoveryWordCount}
			/>
			<MobilePairingDialog
				open={mobilePairingOpen}
				onClose={() => setMobilePairingOpen(false)}
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
			<MobilePanel
				open={mobilePanelOpen}
				onClose={() => setMobilePanelOpen(false)}
				deviceReady={deviceState.state === "ready"}
				onOpenPairing={() => { setMobilePanelOpen(false); setMobilePairingOpen(true) }}
			/>
			<WalletConnectPanel
				open={wcPanelOpen}
				wcUri={wcUri}
				onClose={handleCloseWalletConnect}
				nativeEnabled={walletConnectEnabled}
			/>
			<ActivityTracker />
			<CommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
				onJumpToVault={() => setActiveTab("vault")}
				balances={paletteBalances}
				firmwareVersion={deviceState.firmwareVersion}
			/>
			{/* Top-level swap dialog mount for REST-driven /api/v2/swap/open. */}
			<SwapRpcMount />
			{/* Enable API Bridge dialog — shown when user tries to launch an app with REST disabled */}
			{/* ── WalletConnect Not Supported dialog ──────────────────── */}
			{wcNotSupportedOpen && (
				<>
					<Box position="fixed" inset="0" bg="blackAlpha.700" zIndex={Z.dialog} onClick={() => setWcNotSupportedOpen(false)} />
					<Box
						position="fixed"
						top="50%"
						left="50%"
						transform="translate(-50%, -50%)"
						w="420px"
						maxW="90vw"
						bg="kk.bg"
						border="1px solid"
						borderColor="kk.border"
						borderRadius="xl"
						zIndex={Z.dialog + 1}
						overflow="hidden"
						role="dialog"
						aria-modal="true"
						aria-label="WalletConnect Not Supported"
					>
						<Box px="6" pt="5" pb="4">
							<Flex align="center" gap="2" mb="3">
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3B99FC" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M6.5 9.5c3-3 8-3 11 0" />
									<path d="M4 7c4.5-4.5 11.5-4.5 16 0" />
									<circle cx="12" cy="15" r="1.5" fill="#3B99FC" />
								</svg>
								<Text fontSize="md" fontWeight="600" color="kk.textPrimary">
									WalletConnect
								</Text>
							</Flex>
							<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.6" mb="3">
								WalletConnect is not supported in KeepKey Vault. Please use the KeepKey Browser Extension instead.
							</Text>
							<Box
								as="a"
								href="#"
								onClick={(e: React.MouseEvent) => {
									e.preventDefault()
									rpcRequest("openUrl", { url: "https://keepkey.com/keepkey-browser-extension" }).catch(() => {})
								}}
								color="kk.gold"
								fontSize="sm"
								fontWeight="500"
								_hover={{ textDecoration: "underline" }}
							>
								https://keepkey.com/keepkey-browser-extension
							</Box>
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
								bg="kk.gold"
								color="black"
								fontWeight="600"
								_hover={{ bg: "kk.goldHover" }}
								onClick={() => setWcNotSupportedOpen(false)}
							>
								OK
							</Button>
						</Flex>
					</Box>
				</>
			)}

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
