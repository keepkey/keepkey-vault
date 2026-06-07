import { useState } from "react"
import { Box, Button, Code, Flex, Text, VStack } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { UsbDiagnosticReport } from "../../shared/types"

const SUPPORT_URL = "https://support.keepkey.com"

// Shown under the device grid on the Windows "Searching for KeepKey" splash.
// Starts as an unobtrusive link; on click it runs a read-only USB diagnostic
// (runUsbDiagnostic RPC → windows-usb-probe.ts) and explains the likely cause
// with a copy-ready report the user can paste into a support request.
export function WindowsUsbTroubleshooter() {
	const [phase, setPhase] = useState<"collapsed" | "running" | "done" | "error">("collapsed")
	const [report, setReport] = useState<UsbDiagnosticReport | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	const run = async () => {
		setPhase("running")
		setError(null)
		try {
			const r = await rpcRequest<UsbDiagnosticReport>("runUsbDiagnostic", undefined, 20_000)
			setReport(r)
			setPhase("done")
		} catch (e: any) {
			setError(e?.message || String(e))
			setPhase("error")
		}
	}

	const copyReport = () => {
		if (!report) return
		navigator.clipboard.writeText(report.text).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}

	const openSupport = () => {
		rpcRequest("openUrl", { url: SUPPORT_URL }).catch(() => {})
	}

	if (phase === "collapsed") {
		return (
			<Text
				as="button"
				onClick={run}
				mt={2}
				fontSize="12px"
				color="var(--text-3)"
				fontWeight="500"
				letterSpacing="0.02em"
				_hover={{ color: "var(--teal)", textDecoration: "underline" }}
				className="electrobun-webkit-app-region-no-drag"
			>
				Trouble connecting? Run diagnostics
			</Text>
		)
	}

	return (
		<Box
			mt={4}
			bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))"
			border="1px solid var(--line-2)"
			borderRadius="var(--r-lg)"
			px={7}
			py={6}
			maxW="540px"
			w="90%"
			boxShadow="var(--shadow-2)"
		>
			<VStack gap={4} align="stretch">
				<Flex align="center" gap={2}>
					<Box w="6px" h="6px" borderRadius="full" bg="var(--gold)" />
					<Text fontSize="lg" fontWeight="600" color="var(--text-0)" letterSpacing="-0.01em">
						USB diagnostics
					</Text>
				</Flex>

				{phase === "running" && (
					<Text fontSize="14px" color="var(--text-1)" lineHeight="1.55">
						Checking how Windows sees your KeepKey…
					</Text>
				)}

				{phase === "error" && (
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
				)}

				{phase === "done" && report && (
					<VStack gap={3} align="stretch">
						<Text fontSize="14px" fontWeight="600" color="var(--text-0)" lineHeight="1.5">
							{report.headline}
						</Text>
						<Text fontSize="13px" color="var(--text-1)" lineHeight="1.55">
							{report.guidance}
						</Text>
						<Code
							display="block"
							whiteSpace="pre-wrap"
							bg="var(--ink-0)"
							border="1px solid var(--line)"
							borderRadius="var(--r-md)"
							p={3}
							fontSize="11px"
							color="var(--text-2)"
							fontFamily="mono"
							maxH="160px"
							overflowY="auto"
						>
							{report.text}
						</Code>
					</VStack>
				)}

				<Flex gap={3} justify="center" wrap="wrap">
					{phase === "done" && (
						<Button
							onClick={copyReport}
							bg="var(--gold)"
							color="var(--ink-0)"
							fontWeight="600"
							_hover={{ bg: "var(--gold-2)" }}
							className="electrobun-webkit-app-region-no-drag"
						>
							{copied ? "Copied" : "Copy report"}
						</Button>
					)}
					<Button
						onClick={run}
						loading={phase === "running"}
						loadingText="Checking…"
						variant="ghost"
						color="var(--text-2)"
						_hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }}
						className="electrobun-webkit-app-region-no-drag"
					>
						{phase === "done" || phase === "error" ? "Run again" : "Checking…"}
					</Button>
					<Button
						onClick={openSupport}
						variant="ghost"
						color="var(--text-2)"
						_hover={{ color: "var(--teal)", bg: "var(--ink-2)" }}
						className="electrobun-webkit-app-region-no-drag"
					>
						Contact support
					</Button>
				</Flex>

				<Text fontSize="11px" color="var(--text-3)" textAlign="center" letterSpacing="0.02em">
					Copy the report and paste it at {SUPPORT_URL.replace("https://", "")}
				</Text>
			</VStack>
		</Box>
	)
}
