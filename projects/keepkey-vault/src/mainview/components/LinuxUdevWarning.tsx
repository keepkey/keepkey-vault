import { useState } from "react"
import { Box, Button, Code, Flex, Text, VStack, Link } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"

const RULE_CONTENT = `# KeepKey hardware wallet
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2b24", ATTRS{idProduct}=="0001", TAG+="uaccess"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2b24", ATTRS{idProduct}=="0002", TAG+="uaccess"
KERNEL=="hidraw*", ATTRS{idVendor}=="2b24", TAG+="uaccess"`

const MANUAL_CMD = `sudo tee /etc/udev/rules.d/51-keepkey.rules <<'EOF'
${RULE_CONTENT}
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger`

export function LinuxUdevWarning() {
	const [phase, setPhase] = useState<"idle" | "running" | "success" | "error">("idle")
	const [error, setError] = useState<string | null>(null)
	const [showManual, setShowManual] = useState(false)

	const handleFix = async () => {
		setPhase("running")
		setError(null)
		try {
			const result = await rpcRequest<{ success: boolean; error?: string }>("installLinuxUdevRules", undefined, 120_000)
			if (result.success) {
				setPhase("success")
			} else {
				setPhase("error")
				setError(result.error || "Unknown error")
			}
		} catch (e: any) {
			setPhase("error")
			setError(e?.message || String(e))
		}
	}

	return (
		<Box
			position="absolute"
			top="50%"
			left="50%"
			transform="translate(-50%, -50%)"
			mt="60px"
			bg="rgba(0, 0, 0, 0.95)"
			border="2px solid"
			borderColor="#D4A017"
			borderRadius="xl"
			px={8}
			py={7}
			maxW="540px"
			w="90%"
			boxShadow="0 0 40px rgba(212, 160, 23, 0.3)"
		>
			<VStack gap={4} align="stretch">
				<Text fontSize="xl" fontWeight="bold" color="#F5D060">
					KeepKey detected, but Linux is blocking access
				</Text>

				<Text fontSize="md" color="gray.100" lineHeight="tall">
					Your KeepKey is plugged in, but this user account doesn't have permission to talk to it.
					Linux requires a one-time udev rule to grant USB access to the device.
				</Text>

				{phase === "success" ? (
					<Box bg="rgba(74, 222, 128, 0.12)" border="1px solid" borderColor="rgba(74, 222, 128, 0.4)" borderRadius="md" px={4} py={3}>
						<Text fontSize="sm" color="green.200" fontWeight="medium">
							Rules installed. Unplug and re-plug your KeepKey if it doesn't reconnect automatically in a few seconds.
						</Text>
					</Box>
				) : phase === "error" ? (
					<Box bg="rgba(239, 68, 68, 0.12)" border="1px solid" borderColor="rgba(239, 68, 68, 0.4)" borderRadius="md" px={4} py={3}>
						<Text fontSize="sm" color="red.200" fontFamily="mono" wordBreak="break-word">
							{error}
						</Text>
					</Box>
				) : null}

				{phase !== "success" && (
					<Flex gap={3} justify="center">
						<Button
							onClick={handleFix}
							loading={phase === "running"}
							loadingText="Installing..."
							bg="#D4A017"
							color="black"
							fontWeight="bold"
							_hover={{ bg: "#F5D060" }}
							className="electrobun-webkit-app-region-no-drag"
						>
							Fix it for me
						</Button>
						<Button
							onClick={() => setShowManual((s) => !s)}
							variant="ghost"
							color="gray.300"
							_hover={{ color: "white", bg: "rgba(255,255,255,0.06)" }}
							className="electrobun-webkit-app-region-no-drag"
						>
							{showManual ? "Hide manual steps" : "Manual install"}
						</Button>
					</Flex>
				)}

				{phase === "running" && (
					<Text fontSize="xs" color="gray.400" textAlign="center">
						Look for the system password prompt — it may be behind this window.
					</Text>
				)}

				{showManual && (
					<VStack gap={2} align="stretch">
						<Text fontSize="sm" color="gray.300">
							Run this in a terminal, then unplug and re-plug your KeepKey:
						</Text>
						<Code
							display="block"
							whiteSpace="pre"
							bg="rgba(255,255,255,0.04)"
							border="1px solid"
							borderColor="rgba(255,255,255,0.08)"
							borderRadius="md"
							p={3}
							fontSize="xs"
							color="gray.200"
							overflowX="auto"
						>
							{MANUAL_CMD}
						</Code>
					</VStack>
				)}

				<Link
					href="https://support.keepkey.com"
					target="_blank"
					fontSize="sm"
					color="blue.300"
					textAlign="center"
					fontWeight="medium"
					_hover={{ color: "blue.200", textDecoration: "underline" }}
					className="electrobun-webkit-app-region-no-drag"
				>
					Need help? support.keepkey.com
				</Link>
			</VStack>
		</Box>
	)
}
