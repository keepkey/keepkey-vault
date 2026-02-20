import { useState, useEffect, useCallback } from "react"
import { Routes, Route } from "react-router-dom"
import { Box, Flex } from "@chakra-ui/react"
import { Header } from "./components/layout/Header"
import { Sidebar } from "./components/layout/Sidebar"
import { StatusBar } from "./components/layout/StatusBar"
import { Dashboard } from "./components/dashboard/Dashboard"
import { AddressPanel } from "./components/addresses/AddressPanel"
import { SignTransaction } from "./components/signing/SignTransaction"
import { DeviceStatus } from "./components/device/DeviceStatus"
import { DeviceSettings } from "./components/device/DeviceSettings"
import { PinEntry } from "./components/device/PinEntry"
import { useKeepKey } from "./hooks/useKeepKey"
import { SplashScreen } from "./components/SplashScreen"
import { DeviceClaimedDialog } from "./components/DeviceClaimedDialog"
import { OobSetupWizard } from "./components/OobSetupWizard"
import { useDeviceState } from "./hooks/useDeviceState"
import { rpcRequest, onRpcMessage } from "./lib/rpc"
import type { PinRequestType } from "../shared/types"

const SIDEBAR_WIDTH = "220px"
const HEADER_HEIGHT = "56px"
const STATUSBAR_HEIGHT = "32px"

type AppPhase = 'splash' | 'claimed' | 'setup' | 'ready'

function App() {
	const deviceState = useDeviceState()
	const [wizardComplete, setWizardComplete] = useState(false)

	// ── PIN overlay state ───────────────────────────────────────────────
	const [pinRequestType, setPinRequestType] = useState<PinRequestType | null>(null)

	// Listen for pin-request messages from Bun (device asking for PIN mid-operation)
	useEffect(() => {
		return onRpcMessage('pin-request', (payload) => {
			console.log('[App] pin-request received:', payload)
			setPinRequestType(payload.type as PinRequestType)
		})
	}, [])

	const handlePinSubmit = useCallback(async (pin: string) => {
		try {
			await rpcRequest('sendPin', { pin })
		} catch (err) {
			console.error('[App] sendPin failed:', err)
		}
		setPinRequestType(null)
	}, [])

	const handlePinCancel = useCallback(() => {
		setPinRequestType(null)
	}, [])

	// Also handle needs_pin state (device locked on boot) by showing PinEntry
	useEffect(() => {
		if (deviceState.state === 'needs_pin' && !pinRequestType) {
			setPinRequestType('current')
		}
	}, [deviceState.state, pinRequestType])

	// Clear PIN overlay when device transitions to ready
	useEffect(() => {
		if (deviceState.state === 'ready') {
			setPinRequestType(null)
		}
	}, [deviceState.state])

	// Detect "claimed by another app" — device seen but pair failed with timeout/access error
	const isClaimed = deviceState.state === 'connected_unpaired' && !!deviceState.error

	// 4-phase state machine
	const phase: AppPhase =
		isClaimed
			? 'claimed'
			: (deviceState.state === 'disconnected' || deviceState.state === 'connected_unpaired' || deviceState.state === 'error')
				? 'splash'
				: !wizardComplete && ['bootloader', 'needs_firmware', 'needs_init'].includes(deviceState.state)
					? 'setup'
					: 'ready'

	// PIN overlay — renders on top of ANY phase (setup wizard, splash, dashboard)
	const pinOverlay = pinRequestType ? (
		<PinEntry
			type={pinRequestType}
			onSubmit={handlePinSubmit}
			onCancel={handlePinCancel}
		/>
	) : null

	// Phase: Claimed — device in use by another application
	if (phase === 'claimed') {
		return (
			<>
				{pinOverlay}
				<SplashScreen statusText="KeepKey detected" variant="claimed">
					<DeviceClaimedDialog error={deviceState.error || 'Device claimed by another process'} />
				</SplashScreen>
			</>
		)
	}

	// Phase 1: Splash — searching/connecting to device
	if (phase === 'splash') {
		const isConnecting = deviceState.state === 'connected_unpaired'
		const isError = deviceState.state === 'error'

		const splashText = isConnecting
			? 'KeepKey detected — connecting'
			: isError
				? `Connection error: ${deviceState.error || 'Unknown'}`
				: 'Searching for KeepKey'

		const variant = isConnecting ? 'connecting' : isError ? 'error' : 'searching'

		const hintText = isError
			? 'Try unplugging and replugging your KeepKey, or close other apps that may be using it.'
			: undefined

		return (
			<>
				{pinOverlay}
				<SplashScreen statusText={splashText} hintText={hintText} variant={variant} />
			</>
		)
	}

	// Phase 2: Setup — OOB wizard for bootloader/firmware/init
	if (phase === 'setup') {
		return (
			<>
				{pinOverlay}
				<OobSetupWizard onComplete={() => setWizardComplete(true)} />
			</>
		)
	}

	// Phase 3: Ready — show dashboard (needs_pin handled by PIN overlay above)
	if (deviceState.state === 'needs_passphrase') {
		return <SplashScreen statusText="Passphrase entry required" />
	}

	return (
		<>
			{pinOverlay}
			<ReadyPhase />
		</>
	)
}

function ReadyPhase() {
	const keepkey = useKeepKey()

	return (
		<Flex direction="column" h="100vh" bg="kk.bg" color="kk.textPrimary">
			<Header status={keepkey.status} deviceInfo={keepkey.deviceInfo} />

			<Flex flex="1" overflow="hidden" pt={HEADER_HEIGHT}>
				<Sidebar />

				<Box
					flex="1"
					overflow="auto"
					p="6"
					ml={SIDEBAR_WIDTH}
					pb={STATUSBAR_HEIGHT}
				>
					<Routes>
						<Route
							path="/"
							element={
								<Dashboard
									status={keepkey.status}
									deviceInfo={keepkey.deviceInfo}
									onPair={keepkey.pair}
									pairing={keepkey.pairing}
									error={keepkey.error}
								/>
							}
						/>
						<Route path="/addresses" element={<AddressPanel paired={keepkey.status.paired} />} />
						<Route path="/sign" element={<SignTransaction paired={keepkey.status.paired} />} />
						<Route
							path="/device"
							element={
								<DeviceStatus
									status={keepkey.status}
									deviceInfo={keepkey.deviceInfo}
									onRefresh={keepkey.refreshDeviceInfo}
								/>
							}
						/>
						<Route
							path="/settings"
							element={<DeviceSettings paired={keepkey.status.paired} />}
						/>
					</Routes>
				</Box>
			</Flex>

			<StatusBar status={keepkey.status} />
		</Flex>
	)
}

export default App
