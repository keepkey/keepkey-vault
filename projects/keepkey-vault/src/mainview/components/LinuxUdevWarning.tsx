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
			bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))"
			border="1px solid var(--line-2)"
			borderRadius="var(--r-lg)"
			px={8}
			py={7}
			maxW="540px"
			w="90%"
			boxShadow="var(--shadow-2)"
		>
			<VStack gap={4} align="stretch">
				<Flex align="center" gap={2}>
					<Box w="6px" h="6px" borderRadius="full" bg="var(--gold)" />
					<Text fontSize="lg" fontWeight="600" color="var(--text-0)" letterSpacing="-0.01em">
						KeepKey detected, but Linux is blocking access
					</Text>
				</Flex>

				<Text fontSize="14px" color="var(--text-1)" lineHeight="1.55">
					Your KeepKey is plugged in, but this user account doesn't have permission to talk to it.
					Linux requires a one-time udev rule to grant USB access to the device.
				</Text>

				{phase === "success" ? (
					<Box
						bg="rgba(139,227,196,0.08)"
						border="1px solid rgba(139,227,196,0.25)"
						borderRadius="var(--r-md)"
						px={4}
						py={3}
					>
						<Flex align="center" gap="2">
							<Box w="6px" h="6px" borderRadius="full" bg="var(--teal)" />
							<Text fontSize="13px" color="var(--teal-2)" fontWeight="500" letterSpacing="-0.005em">
								Rules installed. Unplug and re-plug your KeepKey if it doesn't reconnect automatically in a few seconds.
							</Text>
						</Flex>
					</Box>
				) : phase === "error" ? (
					<Box
						bg="rgba(224,140,123,0.08)"
						border="1px solid rgba(224,140,123,0.25)"
						borderRadius="var(--r-md)"
						px={4}
						py={3}
					>
						<Text fontSize="12px" color="var(--rose)" fontFamily="mono" wordBreak="break-word">
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
							bg="var(--gold)"
							color="var(--ink-0)"
							fontWeight="600"
							_hover={{ bg: "var(--gold-2)" }}
							className="electrobun-webkit-app-region-no-drag"
						>
							Fix it for me
						</Button>
						<Button
							onClick={() => setShowManual((s) => !s)}
							variant="ghost"
							color="var(--text-2)"
							_hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }}
							className="electrobun-webkit-app-region-no-drag"
						>
							{showManual ? "Hide manual steps" : "Manual install"}
						</Button>
					</Flex>
				)}

				{phase === "running" && (
					<Text fontSize="11px" color="var(--text-3)" textAlign="center" letterSpacing="-0.005em">
						Look for the system password prompt — it may be behind this window.
					</Text>
				)}

				{showManual && (
					<VStack gap={2} align="stretch">
						<Text fontSize="13px" color="var(--text-2)" letterSpacing="-0.005em">
							Run this in a terminal, then unplug and re-plug your KeepKey:
						</Text>
						<Code
							display="block"
							whiteSpace="pre"
							bg="var(--ink-0)"
							border="1px solid var(--line)"
							borderRadius="var(--r-md)"
							p={3}
							fontSize="11px"
							color="var(--text-1)"
							fontFamily="mono"
							overflowX="auto"
						>
							{MANUAL_CMD}
						</Code>
					</VStack>
				)}

				<Link
					href="https://support.keepkey.com"
					target="_blank"
					fontSize="12px"
					color="var(--text-3)"
					textAlign="center"
					fontWeight="500"
					letterSpacing="0.04em"
					_hover={{ color: "var(--teal)", textDecoration: "underline" }}
					className="electrobun-webkit-app-region-no-drag"
				>
					Need help? support.keepkey.com
				</Link>
			</VStack>
		</Box>
	)
}
