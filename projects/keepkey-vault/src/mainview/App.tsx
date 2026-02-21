import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import { PinEntry } from "./components/device/PinEntry"
import { RecoveryWordEntry } from "./components/device/RecoveryWordEntry"
import { SplashScreen } from "./components/SplashScreen"
import { DeviceClaimedDialog } from "./components/DeviceClaimedDialog"
import { OobSetupWizard } from "./components/OobSetupWizard"
import { TopNav } from "./components/TopNav"
import { Dashboard } from "./components/Dashboard"
import { DevicePage } from "./components/DevicePage"
import { useDeviceState } from "./hooks/useDeviceState"
import { rpcRequest, onRpcMessage } from "./lib/rpc"
import type { PinRequestType } from "../shared/types"

type Tab = "dashboard" | "device"
type AppPhase = "splash" | "claimed" | "setup" | "ready"

function App() {
	const deviceState = useDeviceState()
	const [wizardComplete, setWizardComplete] = useState(false)
	const [tab, setTab] = useState<Tab>("dashboard")

	// ── PIN overlay ─────────────────────────────────────────────────
	const [pinRequestType, setPinRequestType] = useState<PinRequestType | null>(null)

	useEffect(() => {
		return onRpcMessage("pin-request", (payload) => {
			setPinRequestType(payload.type as PinRequestType)
		})
	}, [])

	const handlePinSubmit = useCallback(async (pin: string) => {
		try { await rpcRequest("sendPin", { pin }) } catch (e) { console.error("sendPin:", e) }
		setPinRequestType(null)
	}, [])

	const handlePinCancel = useCallback(() => setPinRequestType(null), [])

	// ── Character request overlay (cipher recovery) ─────────────────
	const [charRequest, setCharRequest] = useState<{ wordPos: number; characterPos: number } | null>(null)
	const [recoveryError, setRecoveryError] = useState<{ message: string; errorType: string } | null>(null)

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
		try { await rpcRequest("recoverDevice", { wordCount: 12, pin: true, passphrase: false }, 600000) } catch { /* errors via RPC message */ }
	}, [])

	// Auto-show PIN for locked device
	useEffect(() => {
		if (deviceState.state === "needs_pin" && !pinRequestType) setPinRequestType("current")
	}, [deviceState.state, pinRequestType])

	// Clear overlays on ready
	useEffect(() => {
		if (deviceState.state === "ready") {
			setPinRequestType(null)
			setCharRequest(null)
		}
	}, [deviceState.state])

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
			totalWords={12}
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
		return <SplashScreen statusText="Passphrase entry required" />
	}

	// ── Ready phase ─────────────────────────────────────────────────
	return (
		<>{charOverlay}{pinOverlay}
			<Flex direction="column" h="100vh" bg="kk.bg" color="kk.textPrimary">
				<TopNav
					label={deviceState.label}
					connected={deviceState.state === "ready" || deviceState.state === "needs_pin" || deviceState.state === "needs_passphrase"}
					tab={tab}
					onTabChange={setTab}
				/>
				<Box flex="1" overflow="auto" pt="50px" p="6">
					{tab === "dashboard" && <Dashboard />}
					{tab === "device" && <DevicePage deviceState={deviceState} />}
				</Box>
			</Flex>
		</>
	)
}

export default App
