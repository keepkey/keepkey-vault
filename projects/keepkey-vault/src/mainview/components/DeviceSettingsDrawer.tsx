import { SettingsLayout, useSettingsCategory, type SettingsCategory } from "./SettingsLayout"
import { useUiTranslation } from "../i18n/ui"
import { firmwareSupportsMonero, MONERO_MIN_FIRMWARE } from "../../shared/firmware-versions"
import { useState, useEffect, useCallback, useRef } from "react"
import { useFiat } from "../lib/fiat-context"
import { Box, Flex, Text, VStack, Button, Input, IconButton } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { LanguageSelector } from "../i18n/LanguageSelector"
import { CurrencySelector } from "./CurrencySelector"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { IS_MAC, IS_WINDOWS } from "../lib/platform"
import { AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK_MS } from "../../shared/flags"
import { Z } from "../lib/z-index"
import type { DeviceStateInfo, AppSettings, EmulatorWalletInfo, EmulatorBuildInfo, EmulatorNextBuild } from "../../shared/types"
import { isBitcoinOnlyVariant } from "../../shared/flags"
import { SelfHostNodePanel } from "./SelfHostNodePanel"
import { MoneroNodePanel } from './MoneroNodePanel'
import { EmulatorBuildOptions, useEmulatorNames } from "./EmulatorIdentity"
import { ClearSignStudio } from "./ClearSignStudio"
import { ClearSignProvidersPanel } from "./ClearSignProvidersPanel"
import { RngAuditPanel } from "./RngAuditPanel"
import { DocsLink } from "./DocsLink"
import { DOCS_LINKS, watch } from "../../shared/docs-links"
import { BROWSER_AGENT_PROMPT, BROWSER_EXTENSION_URL, BROWSER_AGENT_DOCS_URL } from "../../shared/browser-agent-prompt"
import { isActivePioneerServer } from "../../shared/pioneer-server"

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
	autoLockDelayMs?: number
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
	onOpenMobilePairing?: () => void
	/** Opens the network picker (multi-chain only). */
	onChooseNetworks?: () => void
	onRestApiChanged?: (enabled: boolean) => void
	/** Self-host node connected (tested OK + saved) — parent closes the drawer and runs the walkthrough. */
	onNodeConnected?: () => void
	onWordCountChange?: (count: 12 | 18 | 24) => void
}

function Section({ title, category, color, docsHref, videoHref, children }: {
  title: string; category: SettingsCategory; color?: string; docsHref?: string; videoHref?: string; children: React.ReactNode
}) {
  const uiText = useUiTranslation()
  const selected = useSettingsCategory()
  if (selected !== category) return null
  return <Box as="section" bg="kk.cardBg" border="1px solid" borderColor={color === 'kk.error' ? 'kk.error' : 'kk.border'} borderRadius="lg" overflow="hidden">
    <Flex align="center" justify="space-between" gap="3" px="4" py="3" borderBottom="1px solid" borderColor="kk.border" wrap="wrap">
      <Text as="h3" fontSize="sm" fontWeight="600" color={color || 'kk.textPrimary'}>{title}</Text>
      {(docsHref || videoHref) && <Flex gap="3" align="center">
        {docsHref && <DocsLink href={docsHref} />}
        {videoHref && <DocsLink href={videoHref} label={uiText('Watch video')} />}
      </Flex>}
    </Flex>
    <Box p="4">{children}</Box>
  </Box>
}

function FeatureIcon({ kind }: { kind: 'monero' | 'passwords' | 'offline' | 'multisig' | 'walletconnect' | 'emulator' }) {
  const colors = { monero: '#F5841F', passwords: '#E9C46A', offline: '#E08C7B', multisig: '#4FB7A5', walletconnect: '#3B99FC', emulator: '#A855F7' }
  const icons = {
    monero: <><circle cx="12" cy="12" r="10" /><path d="M5 16V9l7 7 7-7v7" /></>,
    passwords: <><circle cx="8" cy="15" r="5" /><path d="m11.5 11.5 9-9M16 7l3 3M18 5l3 3" /></>,
    offline: <><path d="m2 2 20 20M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M12 20h.01" /></>,
    multisig: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v3" /></>,
    walletconnect: <><path d="M6.5 9.5c3-3 8-3 11 0M4 7c4.5-4.5 11.5-4.5 16 0" /><circle cx="12" cy="15" r="1.5" fill="currentColor" /></>,
    emulator: <><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M12 18h.01" /></>,
  }
  return <Flex data-feature-icon={kind} aria-hidden="true" align="center" justify="center" w="32px" h="32px" flexShrink="0" borderRadius="lg" bg={`${colors[kind]}1a`} color={colors[kind]}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icons[kind]}</svg>
  </Flex>
}

// ── Toggle Switch ───────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
	return (
		<Button
			type="button"
			variant="plain"
			p="0"
			minW="40px"
			disabled={disabled}
			role="switch"
			aria-label={label}
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
		</Button>
	)
}

// ── Verification Badge ──────────────────────────────────────────────

function VerificationBadge({ verified, t }: { verified?: boolean; t: (key: string) => string }) {
	if (verified === undefined) return null
	if (verified) {
		return (
			<Flex align="center" gap="1">
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
					<circle cx="12" cy="12" r="10" fill="var(--teal)" />
					<path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
				<Text fontSize="11px" color="var(--teal)" fontWeight="600">{t("official")}</Text>
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

export function DeviceSettingsDrawer({ open, onClose, deviceState, onCheckForUpdate, onDownloadUpdate, onApplyUpdate, updatePhase, updateVersion, appVersion, onOpenAuditLog, onOpenPairedApps, onOpenMobilePairing, onChooseNetworks, onRestApiChanged, onNodeConnected, onWordCountChange }: DeviceSettingsDrawerProps) {
  const uiText = useUiTranslation()

	const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("general")
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
	const [browserPromptStatus, setBrowserPromptStatus] = useState("")
	const [appSettings, setAppSettings] = useState<AppSettings>({ restApiEnabled: false, pioneerApiBase: '', pioneerServers: [], activePioneerServer: '', fiatCurrency: 'USD', numberLocale: 'en-US', walletConnectEnabled: false, btcMultisigEnabled: false, zcashPrivacyEnabled: false, moneroEnabled: false, moneroDaemonUrl: "http://127.0.0.1:18081", moneroNodeMode: "local", moneroRestoreHeight: 0, hiveEnabled: false, emulatorEnabled: false, offlineMode: false, btcNodeEnabled: false, btcNodeType: 'blockbook', btcNodeUrl: '', btcOnboardingShown: false, preReleaseUpdates: false, alphaFirmware: false, addressBookClearsignEnabled: false, privateModeEnabled: false, passphraseIntroShown: false, evmSimulationRpcUrls: {}, disabledNetworks: [], networksChosen: false })
	const [togglingRestApi, setTogglingRestApi] = useState(false)
	const [windowFocusState, setWindowFocusState] = useState<{ refs: number; alwaysOnTop: boolean } | null>(null)
	const [releasingWindowFocus, setReleasingWindowFocus] = useState(false)
	const [togglingWalletConnect, setTogglingWalletConnect] = useState(false)
	const [togglingEmulator, setTogglingEmulator] = useState(false)
	const [moneroBusy, setMoneroBusy] = useState(false)
	const [moneroError, setMoneroError] = useState<string | null>(null)
	const [togglingPreRelease, setTogglingPreRelease] = useState(false)
	const [togglingAlphaFirmware, setTogglingAlphaFirmware] = useState(false)
	const [togglingPrivateMode, setTogglingPrivateMode] = useState(false)
	const [checkingUpdate, setCheckingUpdate] = useState(false)
	const [updateMessage, setUpdateMessage] = useState("")
	const [newServerUrl, setNewServerUrl] = useState("")
	const [newServerLabel, setNewServerLabel] = useState("")
	const [addingServer, setAddingServer] = useState(false)
	const [serverMsg, setServerMsg] = useState<{ text: string; ok: boolean } | null>(null)
	const [switchingServer, setSwitchingServer] = useState("")
	const [resetConfirm, setResetConfirm] = useState(false)
	const [resetting, setResetting] = useState(false)
	const [clearSignStudioOpen, setClearSignStudioOpen] = useState(false)
	const [rngAuditOpen, setRngAuditOpen] = useState(false)
	const [simulationChainId, setSimulationChainId] = useState('1')
	const [simulationRpcUrl, setSimulationRpcUrl] = useState('')
	const [savingSimulationRpc, setSavingSimulationRpc] = useState(false)
	const [simulationRpcMessage, setSimulationRpcMessage] = useState<{ ok: boolean; text: string } | null>(null)
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
		rpcRequest<{ refs: number; alwaysOnTop: boolean }>("getWindowFocusState")
			.then(s => setWindowFocusState(s))
			.catch(() => {})
	}, [open, deviceState.state])

	// Keep window-focus indicator live — bun pushes this whenever alwaysOnTop changes
	useEffect(() => onRpcMessage('window-focus-changed', (state) => setWindowFocusState(state)), [])
	useEffect(() => onRpcMessage('pioneer-server-changed', settings => {
		setAppSettings(settings)
		window.dispatchEvent(new Event('keepkey-settings-changed'))
	}), [])

	useEffect(() => { setLabel(deviceState.label || "") }, [deviceState.label])
	useEffect(() => {
		setSimulationRpcUrl(appSettings.evmSimulationRpcUrls?.[simulationChainId] || '')
	}, [appSettings.evmSimulationRpcUrls, simulationChainId])
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
	const saveSimulationRpc = useCallback(async () => {
		setSavingSimulationRpc(true); setSimulationRpcMessage(null)
		try {
			const result = await rpcRequest<AppSettings>('setEvmSimulationRpc', {
				chainId: Number(simulationChainId), url: simulationRpcUrl.trim(),
			}, 10000)
			setAppSettings(result)
			setSimulationRpcMessage({ ok: true, text: simulationRpcUrl.trim() ? 'Verified and saved.' : 'Custom endpoint removed.' })
		} catch (error: any) {
			setSimulationRpcMessage({ ok: false, text: error?.message || 'Endpoint validation failed.' })
		} finally { setSavingSimulationRpc(false) }
	}, [simulationChainId, simulationRpcUrl])

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

	const forceReleaseWindowFocus = useCallback(async () => {
		setReleasingWindowFocus(true)
		try {
			await rpcRequest("forceReleaseWindowFocus", undefined, 5000)
			const updated = await rpcRequest<{ refs: number; alwaysOnTop: boolean }>("getWindowFocusState")
			setWindowFocusState(updated)
		} catch (e: any) { console.error("forceReleaseWindowFocus:", e) }
		setReleasingWindowFocus(false)
	}, [])

	const toggleWindowAlwaysOnTop = useCallback(async (enabled: boolean) => {
		try {
			await rpcRequest("setWindowAlwaysOnTop", { enabled }, 5000)
		} catch (e: any) { console.error("setWindowAlwaysOnTop:", e) }
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

  const toggleMonero = async (enabled: boolean) => {
    setMoneroBusy(true); setMoneroError(null)
    try {
      setAppSettings(await rpcRequest<AppSettings>("setMoneroEnabled", { enabled }, 30000))
      window.dispatchEvent(new Event("keepkey-settings-changed"))
      await reloadEmuBuilds()
    } catch (error) { setMoneroError(error instanceof Error ? error.message : "Unable to change Monero setting") }
    finally { setMoneroBusy(false) }
  }
	const [togglingPasswords, setTogglingPasswords] = useState(false)
	const [passwordsError, setPasswordsError] = useState('')
	const togglePasswords = useCallback(async (enabled: boolean) => {
		setTogglingPasswords(true); setPasswordsError('')
		try {
			setAppSettings(await rpcRequest<AppSettings>('setPasswordManagerEnabled', { enabled }))
			window.dispatchEvent(new Event('keepkey-settings-changed'))
		} catch (e: any) { setPasswordsError(e?.message || 'Could not change password manager') }
		finally { setTogglingPasswords(false) }
	}, [])
	const [togglingMultisig,setTogglingMultisig]=useState(false)
    const [multisigError,setMultisigError]=useState<string|null>(null)
    const toggleMultisig=useCallback(async(enabled:boolean)=>{
        setTogglingMultisig(true);setMultisigError(null)
        try{
            const result=await rpcRequest<AppSettings>('setBtcMultisigEnabled',{enabled},10000)
            setAppSettings(result)
            window.dispatchEvent(new Event('keepkey-settings-changed'))
        }catch(e:any){setMultisigError(e?.message||'Could not change multisig co-signing')}
        finally{setTogglingMultisig(false)}
    },[])

    const toggleWalletConnect = useCallback(async (enabled: boolean) => {
		setTogglingWalletConnect(true)
		try {
			const result = await rpcRequest<AppSettings>("setWalletConnectEnabled", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setWalletConnectEnabled:", e) }
		setTogglingWalletConnect(false)
	}, [])

	const toggleEmulator = useCallback(async (enabled: boolean) => {
		setTogglingEmulator(true)
		try {
			const result = await rpcRequest<AppSettings>("setEmulatorEnabled", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setEmulatorEnabled:", e) }
		setTogglingEmulator(false)
	}, [])

	const [togglingOffline, setTogglingOffline] = useState(false)
	const [offlineError, setOfflineError] = useState<string | null>(null)
	const toggleOffline = useCallback(async (enabled: boolean) => {
		setTogglingOffline(true)
		setOfflineError(null)
		try {
			const result = await rpcRequest<AppSettings>("setOfflineMode", { enabled }, 20000)
			setAppSettings(result)
		} catch (e: any) { setOfflineError(e?.message || "Could not enable offline mode. Try again.") }
		setTogglingOffline(false)
	}, [])

	// File-picker install of the emulator library. Drag-drop is the other path,
	// but it's unreliable on Windows (Electrobun raw-input handling swallows OS
	// file drops — see WINDOWS-QUIRKS.md), so a Browse button is the dependable
	// route there. Reuses the same backend RPC the drop handler uses; the backend
	// validates the PE/Mach-O header and normalizes the filename to libkkemu.<ext>.
	const emuFileRef = useRef<HTMLInputElement>(null)
	const [installingEmu, setInstallingEmu] = useState(false)
	const [emuInstallMsg, setEmuInstallMsg] = useState<string | null>(null)
	const [emuBuilds, setEmuBuilds] = useState<EmulatorBuildInfo[]>([])
	const [selectedEmuBuild, setSelectedEmuBuild] = useState<string | null>(null)
	const [emuNextBuild, setEmuNextBuild] = useState<EmulatorNextBuild | null>(null)
	const { buildTitle, walletTitle } = useEmulatorNames()
	const reloadEmuBuilds = useCallback(async () => {
		const result = await rpcRequest<{ builds: EmulatorBuildInfo[]; selected: string | null; next: EmulatorNextBuild }>("emulatorListBuilds", undefined, 10000)
		setEmuBuilds(result.builds); setSelectedEmuBuild(result.selected); setEmuNextBuild(result.next)
	}, [])
	useEffect(() => { if (deviceState.isEmulator) reloadEmuBuilds().catch(console.error) }, [deviceState.isEmulator, reloadEmuBuilds])
	async function activateEmuBuild(id: string | null) {
		setInstallingEmu(true); setEmuInstallMsg(null); setRevealedSeed(null)
		try {
			const result = await rpcRequest<{ flashName: string }>("emulatorActivateBuild", { id }, 30000)
			await reloadEmuBuilds()
			await reloadEmuWallets()
			setEmuInstallMsg(`${buildTitle(id ? emuBuilds.find(b => b.id === id) ?? { id } : { id: null })} running with saved wallet ${result.flashName}.`)
		} catch (err: any) { setEmuInstallMsg(err?.message || "Build switch failed") }
		setInstallingEmu(false)
	}
	const handleEmuFilePick = useCallback(async (input: HTMLInputElement) => {
		const file = input.files?.[0]
		input.value = "" // let the user re-pick the same file after a failure
		if (!file) return
		const wantExt = IS_WINDOWS ? ".dll" : ".dylib"
		if (!file.name.toLowerCase().endsWith(wantExt)) {
			setEmuInstallMsg(`Pick a libkkemu${wantExt} file`)
			return
		}
		setInstallingEmu(true); setEmuInstallMsg(null)
		try {
			const bytes = new Uint8Array(await file.arrayBuffer())
			const CHUNK = 8192
			let binary = ""
			for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
			const installed = await rpcRequest<{ buildId: string }>("emulatorInstallDylib", { data: btoa(binary) }, 30000)
			// Backend auto-enables the emulator; nudge the app to re-pull settings.
			window.dispatchEvent(new Event("keepkey-settings-changed"))
			// First-time install (no existing wallets) — DeviceGrid only shows a
			// Start card for wallets emulatorListWallets returns, so with none it
			// has nothing to click. Bootstrap one, same as the drag-drop path.
			try { await rpcRequest("emulatorPair", undefined, 10000) } catch { /* may already be paired */ }
			await rpcRequest("emulatorActivateBuild", { id: installed.buildId }, 30000)
			await reloadEmuBuilds()
			setEmuInstallMsg(`Build ${installed.buildId.slice(0, 12)} installed. Your selected wallet is retained.`)
		} catch (err: any) {
			setEmuInstallMsg(err?.message || "Install failed")
		}
		setInstallingEmu(false)
	}, [reloadEmuBuilds])

	// Emulator wallet (seed) management — switch between saved seeds, generate
	// or import a new one for the active flash, and reveal the active seed for
	// backup. All ops are only reachable while deviceState.isEmulator is true
	// (the Section below is gated on it); emulatorRevealSeed also hard-gates
	// server-side on engine.isEmulator so it can never fire against real hardware.
	const [emuWallets, setEmuWallets] = useState<EmulatorWalletInfo[]>([])
	const [showSeedTools, setShowSeedTools] = useState(false)
	const [newSeedWordCount, setNewSeedWordCount] = useState<12 | 18 | 24>(12)
	const [creatingNewSeed, setCreatingNewSeed] = useState(false)
	const [switchingWallet, setSwitchingWallet] = useState(false)
	const [importMnemonic, setImportMnemonic] = useState("")
	const [importingSeed, setImportingSeed] = useState(false)
	const [revealedSeed, setRevealedSeed] = useState<string | null>(null)
	const [revealingSeed, setRevealingSeed] = useState(false)
	const [emuSeedMsg, setEmuSeedMsg] = useState<string | null>(null)

	const reloadEmuWallets = useCallback(async () => {
		try { setEmuWallets(await rpcRequest<EmulatorWalletInfo[]>("emulatorListWallets", undefined, 10000)) }
		catch (e: any) { console.error("emulatorListWallets:", e?.message); setEmuSeedMsg(`Wallet list refresh failed: ${e?.message || e}`) }
	}, [])

	useEffect(() => {
		if (deviceState.isEmulator) reloadEmuWallets()
	}, [deviceState.isEmulator, reloadEmuWallets])

	const activeEmuWalletName = emuWallets.find((w) => w.isActive)?.name || "default"

	// A revealed mnemonic belongs to whichever wallet was active when it was
	// read — clear it the moment the active wallet changes for ANY reason,
	// including a switch initiated from DeviceGrid's own picker (which calls
	// emulatorSwitchWallet directly, bypassing switchEmuWallet below).
	useEffect(() => { setRevealedSeed(null) }, [activeEmuWalletName])

	// Wipe/Stop/Delete/Switch/New-Seed/Import-Seed all mutate the same live
	// flash + dylib handle — mutually exclusive so a second click mid-flight
	// can't race two stopEmulator/initEmulator/loadDevice sequences.
	const emuBusy = wiping || switchingWallet || creatingNewSeed || importingSeed

	const switchEmuWallet = useCallback(async (name: string) => {
		if (name === activeEmuWalletName) return
		setSwitchingWallet(true); setEmuSeedMsg(null)
		try {
			await rpcRequest("emulatorSwitchWallet", { name }, 30000)
			await reloadEmuWallets()
		} catch (e: any) { setEmuSeedMsg(e?.message || "Switch failed") }
		setSwitchingWallet(false)
	}, [activeEmuWalletName, reloadEmuWallets])

	const generateNewSeed = useCallback(async () => {
		if (!confirm(`Wipe "${activeEmuWalletName}" and load a fresh ${newSeedWordCount}-word seed?`)) return
		setCreatingNewSeed(true); setEmuSeedMsg(null); setRevealedSeed(null)
		try {
			await rpcRequest("emulatorCreateWallet", { wordCount: newSeedWordCount }, 30000)
			setEmuSeedMsg("New seed loaded. Use Reveal Seed below to back it up.")
			await reloadEmuWallets()
		} catch (e: any) { setEmuSeedMsg(e?.message || "Seed generation failed") }
		setCreatingNewSeed(false)
	}, [activeEmuWalletName, newSeedWordCount, reloadEmuWallets])

	const importCustomSeed = useCallback(async () => {
		const mnemonic = importMnemonic.trim()
		const wc = mnemonic.split(/\s+/).filter(Boolean).length
		if (![12, 18, 24].includes(wc)) { setEmuSeedMsg(`Expected 12, 18, or 24 words, got ${wc}`); return }
		if (!confirm(`Wipe "${activeEmuWalletName}" and load this seed?`)) return
		setImportingSeed(true); setEmuSeedMsg(null); setRevealedSeed(null)
		try {
			await rpcRequest("emulatorImportWallet", { name: activeEmuWalletName, mnemonic }, 30000)
			setImportMnemonic("")
			setEmuSeedMsg("Seed imported.")
			await reloadEmuWallets()
		} catch (e: any) { setEmuSeedMsg(e?.message || "Import failed") }
		setImportingSeed(false)
	}, [activeEmuWalletName, importMnemonic, reloadEmuWallets])

	const revealSeed = useCallback(async () => {
		if (revealedSeed) { setRevealedSeed(null); return }
		setRevealingSeed(true); setEmuSeedMsg(null)
		try {
			const result = await rpcRequest<{ mnemonic: string; flashName: string }>("emulatorRevealSeed", undefined, 10000)
			setRevealedSeed(result.mnemonic)
		} catch (e: any) { setEmuSeedMsg(e?.message || "Reveal failed") }
		setRevealingSeed(false)
	}, [revealedSeed])

	const togglePreRelease = useCallback(async (enabled: boolean) => {
		setTogglingPreRelease(true)
		try {
			const result = await rpcRequest<AppSettings>("setPreReleaseUpdates", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setPreReleaseUpdates:", e) }
		setTogglingPreRelease(false)
	}, [])

	const toggleAlphaFirmware = useCallback(async (enabled: boolean) => {
		setTogglingAlphaFirmware(true)
		try {
			const result = await rpcRequest<AppSettings>("setAlphaFirmware", { enabled }, 10000)
			setAppSettings(result)
		} catch (e: any) { console.error("setAlphaFirmware:", e) }
		setTogglingAlphaFirmware(false)
	}, [])

	const { setPrivateMode } = useFiat()
	const togglePrivateMode = useCallback(async (enabled: boolean) => {
		setTogglingPrivateMode(true)
		try {
			const result = await rpcRequest<AppSettings>("setPrivateModeEnabled", { enabled }, 10000)
			setAppSettings(result)
			setPrivateMode(enabled)
		} catch (e: any) { console.error("setPrivateModeEnabled:", e) }
		setTogglingPrivateMode(false)
	}, [setPrivateMode])

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

	const [savingAutoLock, setSavingAutoLock] = useState(false)
	const handleAutoLockChange = useCallback(async (ms: number) => {
		setSavingAutoLock(true)
		try {
			// The device shows a confirm screen with the new delay in seconds.
			await rpcRequest("applySettings", { autoLockDelayMs: ms }, 60000)
			const f = await rpcRequest<DeviceFeatures>("getFeatures")
			setFeatures(f)
		} catch (e: any) {
			console.error("autoLock:", e)
			// Declined on device (or failed) — re-read so the select snaps back to
			// what the device actually holds rather than the value we optimistically
			// showed.
			rpcRequest<DeviceFeatures>("getFeatures").then(setFeatures).catch(() => {})
		} finally {
			setSavingAutoLock(false)
		}
	}, [])

	const handleTogglePassphrase = useCallback(async (enable: boolean) => {
		setTogglingPassphrase(true)
		try {
			await rpcRequest("applySettings", { usePassphrase: enable }, 60000)
			// Toggling passphrase (enable OR disable) clears the device session so the
			// firmware re-derives from the correct seed (see engine.applySettings). That
			// transitions the device to 'needs_pin' → 'needs_passphrase', the app switches
			// to the splash re-auth flow, and this drawer unmounts. We must NOT call
			// getFeatures here — it would race promptPin()'s getPublicKeys() on the
			// transport lock and hang. The drawer re-fetches features when it next opens.
		} catch (e: any) {
			console.error("togglePassphrase:", e)
			// On failure — e.g. the on-device confirm was rejected before the session was
			// cleared, so the device stays 'ready' — refresh features so the toggle
			// reflects the device's actual state.
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
			if (policyName === "AdvancedMode" && !enable) { setClearSignStudioOpen(false); setRngAuditOpen(false) }
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
			const result = await rpcRequest<AppSettings>("setActivePioneerServer", { url }, 60000)
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
			{/* Hidden dylib file picker — shared by the Settings "Install…" button
			    and the Emulator section's "Change Version…" button. Lives at the
			    drawer top level (always mounted) so neither button depends on the
			    other section's render condition. */}
			<input
				ref={emuFileRef}
				type="file"
				accept={IS_WINDOWS ? ".dll" : ".dylib"}
				style={{ display: "none" }}
				onChange={(e) => handleEmuFilePick(e.currentTarget)}
			/>

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
				w={{ base: "100vw", md: "860px" }}
				maxW="100vw"
				bg="kk.bg"
				fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
				css={{ '& button, & select': { fontFamily: 'inherit' } }}
				borderLeft="1px solid"
				borderColor="kk.border"
				zIndex={Z.drawerPanel}
				transform={open ? "translateX(0)" : "translateX(100%)"}
				visibility={open ? "visible" : "hidden"}
				transition="transform 0.25s ease, visibility 0.25s"
				display="flex"
				flexDirection="column"
				overflow="hidden"
				outline="none"
				role={open ? "dialog" : undefined}
				aria-label={t("title")}
				aria-hidden={!open}
				aria-modal={open || undefined}
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
				<SettingsLayout category={settingsCategory} onChange={category => { setSettingsCategory(category); setWipeConfirm(false); setResetConfirm(false); setRemovePinConfirm(false) }}>

					{/* ── Language & Currency ─────────────────────────── */}
					<Section title={t("language")} category="general">
						<LanguageSelector />
						<Box mt="2">
							<CurrencySelector />
						</Box>
					</Section>

					{/* ── Device Identity ─────────────────────────────── */}
					<Section title={uiText("Device information")} category="device" docsHref={DOCS_LINKS.settingsDevice} videoHref={watch('course-08-firmware')}>
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
								<details style={{ marginTop: 8 }}><summary style={{ cursor: "pointer", fontSize: 13, color: "var(--chakra-colors-kk-textSecondary)" }}>{uiText("Firmware details")}</summary>
									{deviceState.firmwareHash && (
										<Box mb="1">
											<Text fontSize="xs" color="kk.textSecondary">{t("fwHash")}</Text>
											<Text fontSize="xs" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">{deviceState.firmwareHash}</Text>
										</Box>
									)}
									{deviceState.bootloaderHash && (
										<Box>
											<Text fontSize="xs" color="kk.textSecondary">{t("blHash")}</Text>
											<Text fontSize="xs" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">{deviceState.bootloaderHash}</Text>
										</Box>
									)}
								</details>
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

					{/* ── Emulator ────────────────────────────────────── */}
					{deviceState.isEmulator && (
						<Section title={uiText("Emulator")} category="device">
							<VStack gap="2" align="stretch">
								<Box bg="rgba(255,152,0,0.08)" border="1px solid" borderColor="rgba(255,152,0,0.3)" borderRadius="md" px="3" py="2">
									<Text fontSize="xs" color="orange.300" fontWeight="600">{uiText("For Development Purposes Only")}</Text>
								</Box>
								<InfoRow label={uiText("Mode")} value="In-Process (dylib FFI)" />
								<InfoRow label={uiText("Transport")} value="Ring Buffer" />
								<InfoRow label={uiText("Firmware")} value={deviceState.firmwareVersion || "—"} />
								<InfoRow label={uiText("Flash")} value={activeEmuWalletName} />
								<InfoRow label={uiText("Seed ID")} value={deviceState.deviceId?.includes(":") ? deviceState.deviceId.split(":")[1] : "—"} />
							</VStack>

							<Flex gap="3" mt="4" wrap="wrap">
								<Button
									size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" px="4" py="2"
									_hover={{ borderColor: "orange.400", color: "orange.400" }}
									onClick={async () => {
										try {
											setWiping(true); setRevealedSeed(null)
											await rpcRequest("wipeDevice", undefined, 30000)
										} catch (e: any) {
											console.error("Emulator wipe failed:", e?.message)
										} finally { setWiping(false) }
									}}
									disabled={wiping || emuBusy}
								>
									{wiping ? uiText("Wiping...") : uiText("Wipe Emulator")}
								</Button>
								<Button
									size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" px="4" py="2"
									_hover={{ borderColor: "kk.error", color: "kk.error" }}
									onClick={async () => {
										setRevealedSeed(null)
										try {
											await rpcRequest("emulatorStop", undefined, 10000)
										} catch (e: any) {
											console.error("Emulator stop failed:", e?.message)
										}
									}}
									disabled={emuBusy}
								>{uiText("Stop Emulator")}</Button>
								<Button
									size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" px="4" py="2"
									_hover={{ borderColor: "kk.error", color: "kk.error" }}
									onClick={async () => {
										// Only ever the wallet that is running, and say which one.
										const name = emuWallets.find((w) => w.isActive)?.name
										if (!name || !confirm(`Delete emulator wallet "${name}" and stop? This erases its seed from this computer. This can't be undone.`)) return
										setRevealedSeed(null)
										try {
											await rpcRequest("emulatorDeleteFlash", { name, stopIfRunning: true }, 5000)
										} catch (e: any) {
											console.error("Flash delete failed:", e?.message)
										}
									}}
									disabled={emuBusy}
								>{uiText("Delete Flash")}</Button>
								<Button
									size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" px="4" py="2"
									_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
									onClick={() => emuFileRef.current?.click()}
									disabled={installingEmu || emuBusy}
								>
									{installingEmu ? uiText("Installing…") : uiText("Change Version…")}
								</Button>
								{(emuBuilds.length > 0 || !!emuNextBuild?.id) && (
									<Box as="select" aria-label={uiText("Emulator build")} value={selectedEmuBuild || ""}
										disabled={installingEmu || emuBusy}
										onChange={(e: React.ChangeEvent<HTMLSelectElement>) => activateEmuBuild(e.target.value || null)}
										fontSize="xs" color="kk.textPrimary" bg="kk.bgSecondary" border="1px solid" borderColor="kk.border" borderRadius="md" p="2">
										{/* Bundled and unavailable-selected builds are listed too: the select never shows a build that isn't selected. */}
										<EmulatorBuildOptions builds={emuBuilds} next={emuNextBuild} showId />
									</Box>
								)}
								{emuInstallMsg && <Text fontSize="xs" color="kk.textSecondary">{emuInstallMsg}</Text>}
							</Flex>

							{/* ── Wallet (seed) switcher — pick a different saved seed ── */}
							{emuWallets.length > 0 && (
								<Flex align="center" gap="2" mt="3" wrap="wrap">
									<Text fontSize="xs" color="kk.textMuted">{uiText("Wallet:")}</Text>
									<Box
										as="select"
										value={activeEmuWalletName}
										onChange={(e: React.ChangeEvent<HTMLSelectElement>) => switchEmuWallet(e.target.value)}
										disabled={emuBusy}
										bg="var(--ink-1)" color="kk.textPrimary" borderWidth="1px" borderColor="kk.border"
										borderRadius="md" fontSize="xs" px="2" py="1"
									>
										{emuWallets.map((w) => (
											<option key={w.name} value={w.name}>{walletTitle(w)}{walletTitle(w) !== w.name ? ` · ${w.name}` : ""}{w.firmwareVersion ? ` (fw ${w.firmwareVersion})` : ""}</option>
										))}
									</Box>
								</Flex>
							)}

							{/* ── Seed tools — adjust or reveal the active wallet's seed ── */}
							<Box mt="3">
								<Box as="button" fontSize="xs" color="kk.textMuted" cursor="pointer" _hover={{ color: "kk.textSecondary" }} onClick={() => setShowSeedTools(!showSeedTools)}>
									{showSeedTools ? uiText("- Hide seed tools") : uiText("+ Seed tools (generate / import / reveal)")}
								</Box>
								{showSeedTools && (
									<VStack align="stretch" gap="3" mt="2" p="3" bg="rgba(255,255,255,0.03)" borderRadius="md">
										<Box bg="rgba(229,62,62,0.08)" border="1px solid" borderColor="rgba(229,62,62,0.3)" borderRadius="md" px="3" py="2">
											<Text fontSize="xs" color="red.300" fontWeight="600">{uiText("Emulator-only. These actions wipe the active flash and never touch real hardware.")}</Text>
										</Box>

										{/* Generate a new random seed */}
										<Flex align="center" gap="2" wrap="wrap">
											<Flex gap="1">
												{([12, 18, 24] as const).map((wc) => (
													<Box
														key={wc} as="button" px="2" py="1" borderRadius="md" fontSize="xs" fontWeight="500" cursor="pointer"
														bg={newSeedWordCount === wc ? "kk.gold" : "rgba(255,255,255,0.06)"}
														color={newSeedWordCount === wc ? "black" : "kk.textSecondary"}
														onClick={() => setNewSeedWordCount(wc)}
													>
														{wc}
													</Box>
												))}
											</Flex>
											<Button size="xs" variant="outline" onClick={generateNewSeed} disabled={emuBusy}>
												{creatingNewSeed ? uiText("Generating…") : uiText("New Seed")}
											</Button>
										</Flex>

										{/* Import a custom seed */}
										<VStack align="stretch" gap="1">
											<Box
												as="textarea"
												value={importMnemonic}
												onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setImportMnemonic(e.target.value)}
												placeholder={uiText("Paste a 12/18/24-word mnemonic to load onto the active wallet")}
												w="100%" rows={2} p={2} bg="var(--ink-1)" color="white" borderWidth="1px" borderColor="gray.700"
												borderRadius="md" fontSize="xs" fontFamily="mono" resize="none"
											/>
											<Button size="xs" variant="outline" alignSelf="flex-start" onClick={importCustomSeed} disabled={emuBusy || !importMnemonic.trim()}>
												{importingSeed ? uiText("Importing…") : uiText("Import Seed")}
											</Button>
										</VStack>

										{/* Reveal the active seed for backup */}
										<VStack align="stretch" gap="1">
											<Button size="xs" variant="outline" alignSelf="flex-start" onClick={revealSeed} disabled={revealingSeed}>
												{revealingSeed ? uiText("Reading…") : revealedSeed ? uiText("Hide Seed") : uiText("Reveal Seed (Backup)")}
											</Button>
											{revealedSeed && (
												<Box bg="var(--ink-1)" borderWidth="1px" borderColor="kk.gold" borderRadius="md" p={2}>
													<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-word">{revealedSeed}</Text>
												</Box>
											)}
										</VStack>

										{emuSeedMsg && <Text fontSize="xs" color="kk.textSecondary">{emuSeedMsg}</Text>}
									</VStack>
								)}
							</Box>
						</Section>
					)}

					{/* ── Security ────────────────────────────────────── */}
					<Section title={uiText("Protection and privacy")} category="security" docsHref={DOCS_LINKS.settingsSecurity} videoHref={watch('course-03-pin')}>
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
								<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(233,196,106,0.1)">
									<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
										bg="rgba(233,196,106,0.12)"
										color="kk.gold"
										fontSize="xs"
										fontWeight="500"
										cursor={changingPin ? "not-allowed" : "pointer"}
										opacity={changingPin ? 0.5 : 1}
										_hover={{ bg: "rgba(233,196,106,0.22)" }}
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
									bg="rgba(233,196,106,0.12)"
									color="kk.gold"
									fontSize="xs"
									fontWeight="500"
									cursor={changingPin ? "not-allowed" : "pointer"}
									opacity={changingPin ? 0.5 : 1}
									_hover={{ bg: "rgba(233,196,106,0.22)" }}
									transition="all 0.15s"
									onClick={handleChangePin}
								>
									{changingPin ? "..." : t("addPin")}
								</Box>
							)}
						</Flex>

						{/* ── Auto-lock row ──────────────────────── */}
						<Flex
							align="center"
							justify="space-between"
							py="3"
							borderBottom="1px solid"
							borderColor="rgba(255,255,255,0.06)"
						>
							<Flex align="center" gap="3">
								<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(233,196,106,0.1)">
									<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<circle cx="12" cy="12" r="10" />
										<polyline points="12 6 12 12 16 14" />
									</svg>
								</Flex>
								<Box>
									<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("autoLock", { defaultValue: "Auto-lock" })}</Text>
									<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
										{t("autoLockHint", { defaultValue: "Idle time before the device re-asks for your PIN. Unplugging always locks it immediately." })}
									</Text>
								</Box>
							</Flex>
							<select
								disabled={savingAutoLock || !features}
								value={String(features?.autoLockDelayMs ?? DEFAULT_AUTO_LOCK_MS)}
								onChange={(e) => handleAutoLockChange(Number(e.target.value))}
								style={{
									padding: "6px 12px",
									borderRadius: "999px",
									background: "rgba(233,196,106,0.12)",
									color: "var(--gold)",
									fontSize: "12px",
									fontWeight: 500,
									border: "none",
									cursor: savingAutoLock ? "not-allowed" : "pointer",
									opacity: savingAutoLock ? 0.5 : 1,
								}}
							>
								{/* A device may already hold a value we do not offer (set by an
								    older build or another host) — show it so the select never
								    silently misreports what the device is actually using. */}
								{!AUTO_LOCK_CHOICES.some(c => c.ms === (features?.autoLockDelayMs ?? DEFAULT_AUTO_LOCK_MS)) && (
									<option value={String(features?.autoLockDelayMs)}>
										{Math.round((features?.autoLockDelayMs ?? 0) / 60000)}{" "}{uiText("min")}</option>
								)}
								{AUTO_LOCK_CHOICES.map(c => (
									<option key={c.ms} value={String(c.ms)}>{c.labelKey}</option>
								))}
							</select>
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
								<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(233,196,106,0.1)">
									<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
								label={t("bip39Passphrase")} checked={!!features?.passphraseProtection}
								onChange={handleTogglePassphrase}
								disabled={togglingPassphrase || !features}
							/>
						</Flex>

						{/* ── Verify Seed row ────────────────────── */}
						<Box py="3">
							<Flex align="center" justify="space-between">
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(233,196,106,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
									bg="rgba(233,196,106,0.12)"
									color="kk.gold"
									fontSize="xs"
									fontWeight="500"
									cursor={verifying ? "not-allowed" : "pointer"}
									opacity={verifying ? 0.5 : 1}
									_hover={{ bg: "rgba(233,196,106,0.22)" }}
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

						{/* Private Mode toggle */}
						<Flex justify="space-between" align="center">
							<Flex align="center" gap="3">
								<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(148,163,184,0.1)">
									<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
										<line x1="1" y1="1" x2="23" y2="23" />
									</svg>
								</Flex>
								<Box>
									<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{uiText("Private Mode")}</Text>
									<Text fontSize="sm" color="kk.textSecondary" mt="0.5">{uiText("Hide portfolio totals and balances from the screen")}</Text>
								</Box>
							</Flex>
							<Toggle
								label={uiText("Private Mode")} checked={appSettings.privateModeEnabled}
								onChange={togglePrivateMode}
								disabled={togglingPrivateMode}
							/>
						</Flex>
					</Section>

					{/* ── Signing Policy ─────────────────────────────── */}
					<Section title={t("signingPolicy")} category="security" docsHref={DOCS_LINKS.settingsSigningPolicy}>
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
									label={t("advancedMode")} checked={isPolicyEnabled("AdvancedMode")}
									onChange={(v) => handleTogglePolicy("AdvancedMode", v)}
									disabled={togglingPolicy === "AdvancedMode" || !features}
								/>
							</Flex>

							{isPolicyEnabled("AdvancedMode") && (
								<Box px="3" py="3" borderRadius="12px" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.18)">
									<Flex align="center" justify="space-between" gap="3">
										<Box>
											<Text fontSize="sm" color="kk.textPrimary" fontWeight="600">{uiText("ClearSign Studio")}</Text>
											<Text fontSize="xs" color="kk.textSecondary" mt="0.5">{uiText("Attest schemas, load a RAM-only signer, and export test evidence.")}</Text>
										</Box>
										<Button size="sm" variant="outline" borderColor="rgba(233,196,106,0.45)" color="kk.gold" onClick={() => setClearSignStudioOpen(true)}>{uiText("Open Studio")}</Button>
									</Flex>
								</Box>
							)}

							{isPolicyEnabled("AdvancedMode") && <ClearSignProvidersPanel />}

							{isPolicyEnabled("AdvancedMode") && (
								<Box px="3" py="3" borderRadius="12px" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.18)">
									<Flex align="center" justify="space-between" gap="3">
										<Box>
											<Text fontSize="sm" color="kk.textPrimary" fontWeight="600">{uiText("RNG health test")}</Text>
											<Text fontSize="xs" color="kk.textSecondary" mt="0.5">{uiText("Pull 64 KB from the device RNG and check it for stuck, repeated, or biased output.")}</Text>
										</Box>
										<Button size="sm" variant="outline" borderColor="rgba(233,196,106,0.45)" color="kk.gold" onClick={() => setRngAuditOpen(true)}>{uiText("Run test")}</Button>
									</Flex>
								</Box>
							)}
						</VStack>
					</Section>

					{/* ── Application Settings ────────────────────────── */}
					<Section title={uiText("App connections")} category="connections" docsHref={DOCS_LINKS.settingsApplication}>
						<VStack gap="4" align="stretch">
							{/* REST API server toggle */}
							<Flex justify="space-between" align="center">
								<Flex align="center" gap="3">
									<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(233,196,106,0.1)">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
									label={t("apiBridge")} checked={appSettings.restApiEnabled}
									onChange={toggleRestApi}
									disabled={togglingRestApi}
								/>
							</Flex>

							{/* API Bridge status */}
							<Box bg="rgba(233,196,106,0.08)" borderRadius="lg" px="3" py="3">
								<Flex align="center" justify="space-between">
									<Flex align="center" gap="2">
										<Box
											w="8px"
											h="8px"
											borderRadius="full"
											bg={appSettings.restApiEnabled ? "var(--teal)" : "var(--rose)"}
											boxShadow={appSettings.restApiEnabled ? "0 0 6px rgba(34,197,94,0.5)" : "0 0 6px rgba(239,68,68,0.4)"}
										/>
										<Text fontSize="sm" fontWeight="500" color={appSettings.restApiEnabled ? "var(--teal)" : "var(--rose)"}>
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

							{/* ── Mobile Pairing ────── */}
							<Box pt="3" borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
								<Flex justify="space-between" align="center">
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">
											{t("mobilePairing.title")}
										</Text>
										<Text fontSize="xs" color="kk.textSecondary" mt="0.5">
											{t("mobilePairing.securityNote")}
										</Text>
									</Box>
									<Box
										as="button"
										px="3"
										py="1.5"
										borderRadius="full"
										bg="rgba(233,196,106,0.12)"
										color="kk.gold"
										fontSize="xs"
										fontWeight="500"
										cursor={deviceState.state !== "ready" ? "not-allowed" : "pointer"}
										opacity={deviceState.state !== "ready" ? 0.4 : 1}
										_hover={deviceState.state === "ready" ? { bg: "rgba(233,196,106,0.22)" } : {}}
										transition="all 0.15s"
										onClick={() => { if (deviceState.state === "ready") onOpenMobilePairing?.() }}
									>
										{t("mobilePairing.button")}
									</Box>
								</Flex>
							</Box>

							</VStack>
                    </Section>
                    <Section title={t("application")} category="general"><VStack gap="4" align="stretch">
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
										bg="rgba(233,196,106,0.12)"
										color="kk.gold"
										fontSize="xs"
										fontWeight="500"
										cursor={checkingUpdate ? "not-allowed" : "pointer"}
										opacity={checkingUpdate ? 0.5 : 1}
										_hover={{ bg: "rgba(233,196,106,0.22)" }}
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
										bg="var(--teal)" color="white" fontSize="xs" fontWeight="600"
										cursor="pointer" _hover={{ bg: "var(--teal)" }}
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
										{t("downloadManually", { defaultValue: "How to Update" })}
									</Box>
								)}
							</Box>

							{/* Always on Top toggle */}
							<Box mt="3" pt="3" borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
								<Flex align="center" justify="space-between">
									<Flex align="center" gap="3">
										<Flex align="center" justify="center" w="32px" h="32px" borderRadius="lg" bg="rgba(233,196,106,0.07)">
											<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
												<rect x="3" y="3" width="18" height="18" rx="2" />
												<path d="M9 9h6M9 12h6M9 15h4" />
											</svg>
										</Flex>
										<Box>
											<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{uiText("Always on Top")}</Text>
											<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
												{windowFocusState === null
													? uiText("Loading...")
													: windowFocusState.alwaysOnTop
														? `Active — ${windowFocusState.refs} request${windowFocusState.refs === 1 ? "" : "s"} holding focus`
														: uiText("Inactive — window behaves normally")
												}
											</Text>
										</Box>
									</Flex>
									<Toggle
										label={uiText("Always on Top")} checked={windowFocusState?.alwaysOnTop ?? false}
										onChange={toggleWindowAlwaysOnTop}
									/>
								</Flex>
								<Text fontSize="xs" color="kk.textMuted" mt="1.5" ml="44px">{uiText("Vault raises itself to the front when a signing or pairing request arrives.")}</Text>
							</Box>

							</VStack>
                    </Section>
                    <Section title={uiText("Preview releases")} category="advanced"><VStack gap="4" align="stretch">
                        {/* Pre-release updates toggle */}
							<Flex justify="space-between" align="center" mt="3" pt="3" borderTopWidth="1px" borderColor="kk.border">
								<Flex align="center" gap="3">
									<Box w="8" h="8" borderRadius="lg" bg="rgba(139,92,246,0.15)" display="flex" alignItems="center" justifyContent="center">
										<Text fontSize="sm">🧪</Text>
									</Box>
									<VStack gap="0" align="start">
										<Text fontSize="sm" color="kk.textPrimary" fontWeight="500">{t("preReleaseUpdates", { defaultValue: "Pre-release Updates" })}</Text>
										<Text fontSize="xs" color="kk.textMuted">{t("preReleaseUpdatesDesc", { defaultValue: "Get early access to new features before stable release" })}</Text>
									</VStack>
								</Flex>
								<Toggle label={t("preReleaseUpdates")} checked={appSettings.preReleaseUpdates} onChange={togglePreRelease} disabled={togglingPreRelease} />
							</Flex>

                            </VStack>
                    </Section>
                    <Section title={uiText("Node connection")} category="monero"><VStack gap="4" align="stretch">
                            <Box>
                                {!appSettings.moneroEnabled && <Box>
                                  <Text fontSize="sm" color="kk.textSecondary">{appSettings.moneroAvailable === false ? uiText("Monero is unavailable in this build.") : uiText("Enable Monero in Feature Flags to connect your wallet and manage its node.")}</Text>
                                  <Button mt="3" size="sm" variant="outline" onClick={() => setSettingsCategory('features')}>{uiText("Open Feature Flags")}</Button>
                                </Box>}
                                {(appSettings.moneroPendingBroadcasts ?? 0) > 0 && <Text data-monero-pending-kept="" fontSize="xs" color="orange.300" mt="2">{uiText("{{count}} Monero send(s) have an unknown broadcast result. They stay recorded even with Monero off or the device wiped, so no second payment is built from the same funds; open XMR to resolve them.", { count: appSettings.moneroPendingBroadcasts ?? 0 })}</Text>}
                                {appSettings.moneroEnabled && <VStack gap="2" align="stretch" mt="3">
                                    {open && <MoneroNodePanel />}
                                    <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer', fontSize: 13 }}>{uiText('Wallet history settings')}</summary>
                                    <Text fontSize="xs" color="kk.textSecondary">{uiText("Scan start block (restore height)")}</Text>
                                    <Flex gap="2">
                                        <Input aria-label={uiText("Monero restore height")} size="sm" type="number" min="0" value={appSettings.moneroRestoreHeight} onChange={event => setAppSettings(previous => ({ ...previous, moneroRestoreHeight: Number(event.target.value) }))} />
                                        <Button size="xs" variant="outline" disabled={moneroBusy} onClick={async () => {
                                            setMoneroBusy(true); setMoneroError(null)
                                            try { const suggested = await rpcRequest<{ restoreHeight: number }>("moneroSuggestRestoreHeight", {}, 20000); setAppSettings(previous => ({ ...previous, moneroRestoreHeight: suggested.restoreHeight })) }
                                            catch (error) { setMoneroError(error instanceof Error ? error.message : "Unable to read the node height") }
                                            finally { setMoneroBusy(false) }
                                        }}>{uiText("New wallet: a week back")}</Button>
                                    </Flex>
                                    <Text fontSize="xs" color="kk.textMuted">{uiText("0 scans the whole chain (hours) and finds every payment. A later block is faster but hides anything received before it, so use it only for a wallet that has never received XMR. The week-back block comes from the node, which KeepKey can't verify.")}</Text>
                                    <Button size="xs" disabled={moneroBusy} onClick={async () => {
                                        setMoneroBusy(true); setMoneroError(null)
                                        try { const current = await rpcRequest<AppSettings>('getAppSettings'); setAppSettings(await rpcRequest<AppSettings>("setMoneroNode", { daemonUrl: current.moneroDaemonUrl, mode: current.moneroNodeMode, restoreHeight: appSettings.moneroRestoreHeight })); window.dispatchEvent(new Event("keepkey-settings-changed")) }
                                        catch (error) { setMoneroError(error instanceof Error ? error.message : "Unable to save Monero daemon") }
                                        finally { setMoneroBusy(false) }
                                    }}>{uiText("Save Monero settings")}</Button>
                                    </details>
                                </VStack>}
                                {moneroError && <Text role="alert" fontSize="xs" color="red.400" mt="2">{moneroError}</Text>}
                            </Box>

							</VStack>
                    </Section>
                    <Section title={uiText("Research firmware")} category="advanced"><VStack gap="4" align="stretch">
                        {/* Alpha firmware toggle */}
							<Flex justify="space-between" align="center" mt="3" pt="3" borderTopWidth="1px" borderColor="kk.border">
								<Flex align="center" gap="3">
									<Box w="8" h="8" borderRadius="lg" bg="rgba(236,72,153,0.15)" display="flex" alignItems="center" justifyContent="center">
										<Text fontSize="sm">🚧</Text>
									</Box>
									<VStack gap="0" align="start">
										<Text fontSize="sm" color="kk.textPrimary" fontWeight="500">{t("alphaFirmware", { defaultValue: "Alpha Firmware" })}</Text>
										<Text fontSize="xs" color="kk.textMuted">{t("alphaFirmwareDesc", { defaultValue: "Opt in to early firmware releases from the beta channel" })}</Text>
									</VStack>
								</Flex>
								<Toggle label={t("alphaFirmware")} checked={appSettings.alphaFirmware} onChange={toggleAlphaFirmware} disabled={togglingAlphaFirmware} />
							</Flex>

						</VStack>
					</Section>

					{/* ── Browser use — needs the REST API, so only shown once it is on ── */}
					{appSettings.restApiEnabled && <Section title={uiText("Browser use")} category="connections">
						<Box>
							<Text fontSize="sm" color="kk.textSecondary">{uiText("Use your existing Chrome profile with an agent. Install and pair the extension, enable its Agent Mode, then paste this prompt into your local agent. The prompt contains no credentials.")}</Text>
							<Flex gap="2" mt="3" flexWrap="wrap">
								<Button size="sm" variant="outline" borderColor="rgba(233,196,106,0.45)" color="kk.gold" onClick={async () => {
									try {
										await navigator.clipboard.writeText(BROWSER_AGENT_PROMPT)
										setBrowserPromptStatus("Copied. Paste into your local agent and describe your task.")
									} catch {
										setBrowserPromptStatus("Clipboard unavailable. Open the browser-use guide and copy the prompt there.")
									}
								}}>{uiText("Copy browser-use prompt")}</Button>
								<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={() => rpcRequest("openUrl", { url: BROWSER_EXTENSION_URL }).catch(() => setBrowserPromptStatus("Could not open Chrome Web Store. Use the install link in the guide."))}>{uiText("Install Chrome extension")}</Button>
								<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={() => rpcRequest("openUrl", { url: BROWSER_AGENT_DOCS_URL }).catch(() => setBrowserPromptStatus("Open docs.keepkey.com/docs/bex/mcp in your browser."))}>{uiText("Browser-use guide")}</Button>
							</Flex>
							{browserPromptStatus && <Text role="status" fontSize="sm" color="kk.textSecondary" mt="2">{browserPromptStatus}</Text>}
						</Box>
					</Section>}

					{/* ── Bitcoin node (self-host) — btc-only devices ─── */}
					{isBitcoinOnlyVariant(deviceState.firmwareVariant) && (
						<Section title={uiText("Bitcoin node")} category="networks" videoHref={watch('btc-node-desktop-core')}>
							<SelfHostNodePanel settings={appSettings} onChange={setAppSettings} onConnected={onNodeConnected} />
						</Section>
					)}

					{!isBitcoinOnlyVariant(deviceState.firmwareVariant) && onChooseNetworks && (
						<Section title={uiText("Networks")} category="networks" docsHref={DOCS_LINKS.performance}>
							<Flex align="center" justify="space-between" gap="3">
								<Text fontSize="sm" color="kk.textSecondary">
									{appSettings.disabledNetworks.length === 0
										? uiText("Every network is on.")
										: `${appSettings.disabledNetworks.length} turned off for a faster dashboard.`}
								</Text>
								<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textPrimary" onClick={onChooseNetworks}>{uiText("Choose networks")}</Button>
							</Flex>
						</Section>
					)}

					{!isBitcoinOnlyVariant(deviceState.firmwareVariant) && isPolicyEnabled("AdvancedMode") && (
						<Section title={uiText("ClearSign simulation")} category="advanced">
							<VStack gap="3" align="stretch">
								<Text fontSize="sm" color="kk.textSecondary">{uiText("Use an explicit JSON-RPC provider for pre-sign execution, logs, and call traces. Vault verifies the chain ID before saving. Providers can observe transaction data.")}</Text>
								<Flex gap="2">
									<Input value={simulationChainId} onChange={(e) => setSimulationChainId(e.target.value.replace(/\D/g, ''))} placeholder={uiText("Chain ID")} w="110px" />
									<Input value={simulationRpcUrl} onChange={(e) => setSimulationRpcUrl(e.target.value)} placeholder="https://your-rpc.example" fontFamily="mono" />
									<Button onClick={saveSimulationRpc} loading={savingSimulationRpc} disabled={!simulationChainId}>{simulationRpcUrl.trim() ? uiText("Verify & save") : uiText("Remove")}</Button>
								</Flex>
								{simulationRpcMessage && <Text fontSize="xs" color={simulationRpcMessage.ok ? 'green.300' : 'kk.error'}>{simulationRpcMessage.text}</Text>}
								<Text fontSize="xs" color="kk.textMuted">{uiText("Without a configured endpoint, Vault keeps the Pioneer fallback and explicitly marks unavailable or incomplete simulation evidence.")}</Text>
							</VStack>
						</Section>
					)}

					{/* ── Feature Flags ──────────────────────────────── */}
					<Section title={uiText("Available features")} category="features" docsHref={DOCS_LINKS.settingsFeatureFlags}>
						<VStack gap="4" align="stretch">
              <Flex justify="space-between" align="center" gap="4" pb="4" borderBottom="1px solid" borderColor="kk.border">
                <Flex align="center" gap="3" minW="0"><FeatureIcon kind="monero" /><Box><Text fontSize="md" fontWeight="500" color="kk.textPrimary">{uiText('Monero (XMR)')}</Text>
                  <Text fontSize="sm" color="kk.textSecondary" mt="0.5">{appSettings.moneroAvailable === false ? uiText('Monero is unavailable in this build.') : !firmwareSupportsMonero(deviceState.firmwareVersion) ? `Needs KeepKey firmware ${MONERO_MIN_FIRMWARE} or newer.` : uiText('Add Monero to your wallet. Manage its node and scan history in Settings → Monero.')}</Text></Box></Flex>
                <Toggle label={uiText('Monero (XMR)')} checked={appSettings.moneroEnabled} disabled={moneroBusy || appSettings.moneroAvailable === false} onChange={toggleMonero} />
              </Flex>
              {moneroError && <Text role="alert" fontSize="xs" color="kk.error">{moneroError}</Text>}

							<Box>
								<Flex justify="space-between" align="center" gap="3">
									<Flex align="center" gap="3" minW="0"><FeatureIcon kind="passwords" /><Box><Text fontSize="md" color="kk.textPrimary" fontWeight="500">{uiText("Password manager")}</Text><Text fontSize="sm" color="kk.textSecondary" mt="0.5">{uiText("Experimental. Encrypted password storage, backups and guided rotation with KeepKey approval. Off by default.")}</Text></Box></Flex>
									<Toggle label={uiText('Password manager')} checked={appSettings.passwordManagerEnabled === true} onChange={togglePasswords} disabled={togglingPasswords} />
								</Flex>
								{passwordsError && <Text role="alert" fontSize="xs" color="kk.error">{passwordsError}</Text>}
							</Box>
							{/* Offline (airplane) mode toggle */}
							<Flex justify="space-between" align="center">
								<Flex align="center" gap="3">
									<FeatureIcon kind="offline" />
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("offlineMode", { defaultValue: "Offline mode" })}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("offlineModeDescription", { defaultValue: "Airplane mode — no network. Device, addresses, and signing still work; balances, history, and broadcast are disabled." })}
										</Text>
									</Box>
								</Flex>
								<Toggle
									label={t("offlineMode", { defaultValue: "Offline mode" })} checked={appSettings.offlineMode}
									onChange={toggleOffline}
									disabled={togglingOffline}
								/>
							</Flex>
							{offlineError && <Text role="alert" fontSize="xs" color="kk.error" mt="2">{offlineError}</Text>}

							<Box>
                                <Flex justify="space-between" align="center" gap="3">
                                    <Flex align="center" gap="3" minW="0"><FeatureIcon kind="multisig" /><Box><Text fontSize="md" color="kk.textPrimary" fontWeight="500">{uiText("Multisig")}</Text>
                                    <Text fontSize="sm" color="kk.textSecondary" mt="0.5">{uiText("Experimental. Safe multisig accounts on EVM chains and Vaults, plus Bitcoin co-signing for Sparrow or Electrum PSBTs. Off by default. Completed transactions can still be broadcast with this off.")}</Text></Box></Flex>
                                    <Toggle label={uiText("Multisig")} checked={appSettings.btcMultisigEnabled===true} onChange={toggleMultisig} disabled={togglingMultisig}/>
                                </Flex>
                                {multisigError && <Text role="alert" fontSize="xs" color="kk.error" mt="2">{multisigError}</Text>}
                            </Box>

                            {/* WalletConnect is an altcoin signing surface. A persisted global
							    setting must not re-expose it on Bitcoin-only firmware. */}
							{!isBitcoinOnlyVariant(deviceState.firmwareVariant) && <Flex justify="space-between" align="center">
								<Flex align="center" gap="3">
									<FeatureIcon kind="walletconnect" />
									<Box>
										<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{t("walletConnectFeature")}</Text>
										<Text fontSize="sm" color="kk.textSecondary" mt="0.5">
											{t("walletConnectFeatureDescription")}
										</Text>
									</Box>
								</Flex>
								<Toggle
									label={t("walletConnectFeature")} checked={appSettings.walletConnectEnabled}
									onChange={toggleWalletConnect}
									disabled={togglingWalletConnect}
								/>
							</Flex>}

							{/* Zcash + Hive have no toggles — both turn on automatically on
							    firmware >= 7.15.0 (derived in bun/index.ts on device ready).
							    BIP-85 likewise: the Dashboard shows it on firmware >= 7.16.0. */}

							{/* Emulator toggle — dev tool, default off. Supported on macOS
							    (Keychain) and Windows (DPAPI); Linux has no key store wired up. */}
							{(IS_MAC || IS_WINDOWS) && (
								<VStack align="stretch" gap="2">
									<Flex justify="space-between" align="center">
										<Flex align="center" gap="3">
											<FeatureIcon kind="emulator" />
											<Box>
												<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{uiText("Emulator")}</Text>
												<Text fontSize="sm" color="kk.textSecondary" mt="0.5">{uiText("Run a KeepKey firmware emulator locally for development and testing.")}</Text>
											</Box>
										</Flex>
										<Toggle
											label={uiText("Emulator")} checked={appSettings.emulatorEnabled}
											onChange={toggleEmulator}
											disabled={togglingEmulator}
										/>
									</Flex>
									{appSettings.emulatorEnabled && (
										<Flex align="center" gap="3" pl="44px" wrap="wrap">
											<Text
												fontSize="xs"
												color="kk.gold"
												cursor="pointer"
												textDecoration="underline"
												onClick={() => rpcRequest('openUrl', { url: "https://keepkey.com/emulator" }).catch((e: any) => console.warn('[openUrl]', e?.message))}
											>{uiText("Get the emulator at keepkey.com/emulator")}</Text>
										</Flex>
									)}
								</VStack>
							)}
						</VStack>
					</Section>

					{/* ── API Services ────────────────────────────────── */}
					<Section title={uiText("API Services")} category="connections" docsHref={DOCS_LINKS.settingsApi} videoHref={watch('course-11-app-connections')}>
						<VStack gap="4" align="stretch">
							<Box>
								<Text fontSize="md" color="kk.textPrimary" fontWeight="500">{uiText("Pioneer API Servers")}</Text>
								<Text fontSize="sm" color="kk.textSecondary" mt="0.5">{uiText("Manage which Pioneer API server the vault connects to.")}</Text>
								<Text fontSize="xs" color="kk.textSecondary" mt="3">{uiText("Active server")}</Text>
								<Text fontSize="sm" color="kk.textPrimary" fontFamily="mono" overflowWrap="anywhere">
									{appSettings.pioneerApiBase || uiText("Loading…")}
								</Text>
							</Box>

							{/* Server list */}
							<VStack gap="2" align="stretch">
								{(appSettings.pioneerServers || []).map(server => {
									const isActive = isActivePioneerServer(appSettings.pioneerApiBase, server.url)
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
								<Text fontSize="sm" color="kk.textSecondary" mb="2">{uiText("Add Server")}</Text>
								<VStack gap="2" align="stretch">
									<Input
										value={newServerLabel}
										onChange={(e) => setNewServerLabel(e.target.value)}
										placeholder={uiText("My Server")}
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
											{addingServer ? "..." : uiText("Add")}
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
					<Section title={t("dangerZone")} category="advanced" color="kk.error" docsHref={DOCS_LINKS.wipeDevice} videoHref={watch('intro-more-forgot-pin')}>
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

				</SettingsLayout>
			</Box>
			<RngAuditPanel open={rngAuditOpen} onClose={() => setRngAuditOpen(false)} />
			<ClearSignStudio
				open={clearSignStudioOpen}
				onClose={() => setClearSignStudioOpen(false)}
				advancedMode={isPolicyEnabled("AdvancedMode")}
				firmwareVersion={deviceState.firmwareVersion}
			/>
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
