import { Routes, Route } from "react-router-dom";
import { Box, Flex } from "@chakra-ui/react";
import { Header } from "./components/layout/Header";
import { Sidebar } from "./components/layout/Sidebar";
import { StatusBar } from "./components/layout/StatusBar";
import { Dashboard } from "./components/dashboard/Dashboard";
import { AddressPanel } from "./components/addresses/AddressPanel";
import { SignTransaction } from "./components/signing/SignTransaction";
import { DeviceStatus } from "./components/device/DeviceStatus";
import { DeviceSettings } from "./components/device/DeviceSettings";
import { useKeepKey } from "./hooks/useKeepKey";

const SIDEBAR_WIDTH = "220px";
const HEADER_HEIGHT = "56px";
const STATUSBAR_HEIGHT = "32px";

function App() {
	const keepkey = useKeepKey();

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
	);
}

export default App;
