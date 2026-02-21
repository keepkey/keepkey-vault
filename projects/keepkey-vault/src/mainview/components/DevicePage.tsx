import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, VStack, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { DeviceStateInfo } from "../../shared/types"

interface DevicePageProps {
	deviceState: DeviceStateInfo
}

export function DevicePage({ deviceState }: DevicePageProps) {
	const [features, setFeatures] = useState<any>(null)
	const [label, setLabel] = useState(deviceState.label || "")
	const [saving, setSaving] = useState(false)
	const [pinging, setPinging] = useState(false)
	const [pingResult, setPingResult] = useState("")
	const [wiping, setWiping] = useState(false)
	const [wipeConfirm, setWipeConfirm] = useState(false)
	const [verifying, setVerifying] = useState(false)
	const [verifyResult, setVerifyResult] = useState<{ success: boolean; message: string } | null>(null)

	useEffect(() => {
		if (deviceState.state === "ready") {
			rpcRequest("getFeatures").then(setFeatures).catch(() => {})
		}
	}, [deviceState.state])

	useEffect(() => { setLabel(deviceState.label || "") }, [deviceState.label])

	const saveLabel = useCallback(async () => {
		if (!label.trim()) return
		setSaving(true)
		try {
			await rpcRequest("applySettings", { label: label.trim() }, 60000)
			setPingResult("Label saved")
			setTimeout(() => setPingResult(""), 2000)
		} catch (e: any) { console.error("applySettings:", e) }
		setSaving(false)
	}, [label])

	const pingDevice = useCallback(async () => {
		setPinging(true)
		try {
			const result = await rpcRequest("ping", { msg: "Hello KeepKey!" }, 10000)
			setPingResult(typeof result === "string" ? result : "Pong!")
			setTimeout(() => setPingResult(""), 3000)
		} catch (e: any) {
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
		try { await rpcRequest("wipeDevice", undefined, 60000) } catch (e: any) { console.error("wipeDevice:", e) }
		setWiping(false)
		setWipeConfirm(false)
	}, [])

	return (
		<VStack gap="5" align="stretch" maxW="600px" mx="auto" pt="4">
			{/* Device Identity */}
			<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="6">
				<Text fontSize="lg" fontWeight="600" mb="4" color="kk.gold">Device Identity</Text>
				<VStack gap="3" align="stretch">
					<InfoRow label="Label" value={features?.label || deviceState.label || "—"} />
					<InfoRow label="Device ID" value={deviceState.deviceId ? deviceState.deviceId.slice(0, 20) + "..." : "—"} />
					<InfoRow label="Firmware" value={deviceState.firmwareVersion || "—"} />
					<InfoRow label="Bootloader" value={deviceState.bootloaderVersion || "—"} />
					<InfoRow label="Latest FW" value={deviceState.latestFirmware || "—"} />
					<InfoRow label="Transport" value={deviceState.activeTransport || "—"} />
				</VStack>
			</Box>

			{/* Security Status */}
			<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="6">
				<Text fontSize="lg" fontWeight="600" mb="4" color="kk.gold">Security</Text>
				<VStack gap="3" align="stretch">
					<InfoRow label="Initialized" value={deviceState.initialized ? "Yes" : "No"} />
					<InfoRow label="PIN Protection" value={features?.pinProtection ? "Enabled" : "Disabled"} />
					<InfoRow label="Passphrase" value={features?.passphraseProtection ? "Enabled" : "Disabled"} />
					<InfoRow label="U2F Counter" value={features?.u2fCounter != null ? String(features.u2fCounter) : "—"} />
				</VStack>
			</Box>

			{/* Verify Seed */}
			<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="6">
				<Text fontSize="lg" fontWeight="600" mb="2" color="kk.gold">Verify Recovery Seed</Text>
				<Text fontSize="sm" color="kk.textSecondary" mb="4">
					Confirm your recovery phrase matches the seed stored on the device. This does not modify anything on the device.
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
						<Text fontSize="sm" color={verifyResult.success ? "kk.success" : "kk.error"}>
							{verifyResult.success ? "Seed verified!" : verifyResult.message}
						</Text>
					)}
				</Flex>
			</Box>

			{/* Actions */}
			<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="6">
				<Text fontSize="lg" fontWeight="600" mb="4" color="kk.gold">Actions</Text>

				{/* Change label */}
				<Text fontSize="sm" color="kk.textSecondary" mb="2">Device Label</Text>
				<Flex gap="3" mb="4">
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

				{/* Ping */}
				<Flex gap="3" align="center">
					<Button size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={pingDevice} disabled={pinging}>
						{pinging ? "..." : "Ping Device"}
					</Button>
					{pingResult && <Text fontSize="sm" color="kk.success">{pingResult}</Text>}
				</Flex>
			</Box>

			{/* Danger Zone */}
			<Box bg="kk.cardBg" border="1px solid" borderColor="kk.error" borderRadius="xl" p="6">
				<Text fontSize="lg" fontWeight="600" mb="2" color="kk.error">Danger Zone</Text>
				<Text fontSize="sm" color="kk.textSecondary" mb="4">
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
