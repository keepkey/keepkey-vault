import { useState, useEffect, useCallback } from "react"
import { Box, Flex } from "@chakra-ui/react"
import { PinEntry } from "./components/device/PinEntry"
import { RecoveryWordEntry } from "./components/device/RecoveryWordEntry"
import { SplashScreen } from "./components/SplashScreen"
import { DeviceClaimedDialog } from "./components/DeviceClaimedDialog"
import { OobSetupWizard } from "./components/OobSetupWizard"
import { TopNav } from "./components/TopNav"
import { Dashboard } from "./components/Dashboard"
import { DeviceSettingsDrawer } from "./components/DeviceSettingsDrawer"
import { useDeviceState } from "./hooks/useDeviceState"
import { rpcRequest, onRpcMessage } from "./lib/rpc"
import type { PinRequestType } from "../shared/types"

type AppPhase = "splash" | "claimed" | "setup" | "ready"

function App() {
	const deviceState = useDeviceState()
	const [wizardComplete, setWizardComplete] = useState(false)
	const [portfolioLoaded, setPortfolioLoaded] = useState(false)
	const [settingsOpen, setSettingsOpen] = useState(false)

	// ── PIN overlay ─────────────────────────────────────────────────
	const [pinRequestType, setPinRequestType] = useState<PinRequestType | null>(null)
	const [pinDismissed, setPinDismissed] = useState(false)

	useEffect(() => {
		return onRpcMessage("pin-request", (payload) => {
			setPinDismissed(false) // new request from device resets dismiss
			setPinRequestType(payload.type as PinRequestType)
		})
	}, [])

	const handlePinSubmit = useCallback(async (pin: string) => {
		try { await rpcRequest("sendPin", { pin }) } catch (e) { console.error("sendPin:", e) }
		setPinRequestType(null)
	}, [])

	const handlePinCancel = useCallback(() => { setPinRequestType(null); setPinDismissed(true) }, [])

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
	const handleRecoveryRetry = useCallback(async () => {
		setCharRequest(null)
		setRecoveryError(null)
		try { await rpcRequest("recoverDevice", { wordCount: recoveryWordCount, pin: true, passphrase: false }, 600000) } catch { /* errors via RPC message */ }
	}, [recoveryWordCount])

	// Auto-show PIN for locked device (only once — respect user dismiss)
	useEffect(() => {
		if (deviceState.state === "needs_pin" && !pinRequestType && !pinDismissed) setPinRequestType("current")
	}, [deviceState.state, pinRequestType, pinDismissed])

	// Clear overlays on ready or disconnect
	useEffect(() => {
		if (deviceState.state === "ready" || deviceState.state === "disconnected") {
			setPinRequestType(null)
			setCharRequest(null)
			setPinDismissed(false) // reset dismiss on state transitions
		}
	}, [deviceState.state])

	const handlePortfolioLoaded = useCallback(() => setPortfolioLoaded(true), [])

	// ── Phase detection ─────────────────────────────────────────────
	const isClaimed = deviceState.state === "connected_unpaired" && !!deviceState.error

	const phase: AppPhase =
		isClaimed ? "claimed"
		: ["disconnected", "connected_unpaired", "error"].includes(deviceState.state) ? "splash"
		: !wizardComplete && ["bootloader", "needs_firmware", "needs_init"].includes(deviceState.state) ? "setup"
		: "ready"

	// ── Overlays (render above everything) ──────────────────────────
	const pinOverlay = pinRequestType ? (
		<PinEntry type={pinRequestType} onSubmit={handlePinSubmit} onCancel={handlePinCancel} />
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

	// ── Render phases ───────────────────────────────────────────────
	if (phase === "claimed") {
		return (
			<>{charOverlay}{pinOverlay}
				<SplashScreen statusText="KeepKey detected" variant="claimed">
					<DeviceClaimedDialog error={deviceState.error || "Device claimed by another process"} />
				</SplashScreen>
			</>
		)
	}

	if (phase === "splash") {
		const isConnecting = deviceState.state === "connected_unpaired"
		const isError = deviceState.state === "error"
		return (
			<>{charOverlay}{pinOverlay}
				<SplashScreen
					statusText={isConnecting ? "KeepKey detected — connecting" : isError ? `Error: ${deviceState.error || "Unknown"}` : "Searching for KeepKey"}
					hintText={isError ? "Try unplugging and replugging your KeepKey." : undefined}
					variant={isConnecting ? "connecting" : isError ? "error" : "searching"}
				/>
			</>
		)
	}

	if (phase === "setup") {
		return (
			<>{charOverlay}{pinOverlay}
				<OobSetupWizard onComplete={() => setWizardComplete(true)} />
			</>
		)
	}

	if (deviceState.state === "needs_passphrase") {
		return (
			<>{charOverlay}{pinOverlay}
				<SplashScreen statusText="Passphrase entry required" variant="connecting" />
			</>
		)
	}

	// ── Ready phase ─────────────────────────────────────────────────
	return (
		<>{charOverlay}{pinOverlay}
			{!portfolioLoaded && (
				<SplashScreen statusText="Loading portfolio" variant="connecting" />
			)}
			<Flex direction="column" h="100vh" bg="kk.bg" color="kk.textPrimary"
				{...(!portfolioLoaded ? { position: "absolute", w: 0, h: 0, overflow: "hidden" } as const : {})}
			>
				<TopNav
					label={deviceState.label}
					connected={deviceState.state === "ready" || deviceState.state === "needs_pin" || deviceState.state === "needs_passphrase"}
					firmwareVersion={deviceState.firmwareVersion}
					onSettingsToggle={() => setSettingsOpen((o) => !o)}
					settingsOpen={settingsOpen}
				/>
				<Flex flex="1" direction="column" overflow="auto" pt="54px" pb="4">
					<Dashboard onLoaded={handlePortfolioLoaded} />
				</Flex>
			</Flex>
			<DeviceSettingsDrawer
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				deviceState={deviceState}
			/>
		</>
	)
}

export default App
