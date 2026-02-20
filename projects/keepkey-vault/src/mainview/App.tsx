import { useState } from "react"
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
import { useKeepKey } from "./hooks/useKeepKey"
import { SplashScreen } from "./components/SplashScreen"
import { OobSetupWizard } from "./components/OobSetupWizard"
import { useDeviceState } from "./hooks/useDeviceState"

const SIDEBAR_WIDTH = "220px"
const HEADER_HEIGHT = "56px"
const STATUSBAR_HEIGHT = "32px"

type AppPhase = 'splash' | 'setup' | 'ready'

function App() {
	const deviceState = useDeviceState()
	const [wizardComplete, setWizardComplete] = useState(false)

	// 3-phase state machine
	const phase: AppPhase =
		(deviceState.state === 'disconnected' || deviceState.state === 'connected_unpaired' || deviceState.state === 'error')
			? 'splash'
			: !wizardComplete && ['bootloader', 'needs_firmware', 'needs_init'].includes(deviceState.state)
				? 'setup'
				: 'ready'

	// Phase 1: Splash — searching/connecting to device
	if (phase === 'splash') {
		const splashText =
			deviceState.state === 'connected_unpaired'
				? 'KeepKey detected — connecting'
				: deviceState.state === 'error'
					? `Connection error: ${deviceState.error || 'Unknown'}`
					: 'Searching for KeepKey'

		const hintText =
			deviceState.state === 'connected_unpaired'
				? 'If this takes too long, try: close other apps using KeepKey, or unplug and replug the device.'
				: deviceState.state === 'error'
					? 'Try unplugging and replugging your KeepKey, or close other apps that may be using it.'
					: undefined

		return <SplashScreen statusText={splashText} hintText={hintText} />
	}

	// Phase 2: Setup — OOB wizard for bootloader/firmware/init
	if (phase === 'setup') {
		return <OobSetupWizard onComplete={() => setWizardComplete(true)} />
	}

	// Phase 3: Ready — show dashboard
	// For needs_pin / needs_passphrase, show splash with message for now
	if (deviceState.state === 'needs_pin') {
		return <SplashScreen statusText="Device is locked — enter PIN on the device" />
	}
	if (deviceState.state === 'needs_passphrase') {
		return <SplashScreen statusText="Passphrase entry required" />
	}

	return <ReadyPhase />
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
