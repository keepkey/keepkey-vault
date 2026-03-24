import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Spinner, Image } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { ReportMeta } from "../../shared/types"

import keepkeyLogo from "../assets/icon.png"
import coinTrackerLogo from "../assets/logo/cointracker.png"
import zenLedgerLogo from "../assets/logo/zenledger.png"

type ExportFormat = "pdf" | "cointracker" | "zenledger"

const EXPORT_OPTIONS: { key: ExportFormat; label: string; sub: string; logo: string; bg: string }[] = [
	{ key: "pdf", label: "KeepKey PDF", sub: "Full portfolio report", logo: keepkeyLogo, bg: "rgba(192,168,96,0.10)" },
	{ key: "cointracker", label: "CoinTracker", sub: "Tax CSV export", logo: coinTrackerLogo, bg: "rgba(255,255,255,0.05)" },
	{ key: "zenledger", label: "ZenLedger", sub: "Tax CSV export", logo: zenLedgerLogo, bg: "rgba(255,255,255,0.05)" },
]

interface ReportDialogProps {
	onClose: () => void
}

export function ReportDialog({ onClose }: ReportDialogProps) {
	const [generating, setGenerating] = useState(false)
	const [progress, setProgress] = useState<{ message: string; percent: number } | null>(null)
	const [reports, setReports] = useState<ReportMeta[]>([])
	const [error, setError] = useState<string | null>(null)
	const [loadingReports, setLoadingReports] = useState(true)
	const activeReportId = useRef<string | null>(null)
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

	// Load report list on mount
	useEffect(() => {
		rpcRequest<ReportMeta[]>("listReports", undefined, 5000)
			.then(setReports)
			.catch(() => {})
			.finally(() => setLoadingReports(false))
	}, [])

	// Listen for progress messages — accept any progress while generating
	useEffect(() => {
		return onRpcMessage("report-progress", (payload: { id: string; message: string; percent: number }) => {
			// Capture report ID from first progress message (set before await resolves)
			if (!activeReportId.current && payload.id) {
				activeReportId.current = payload.id
			}
			if (payload.id === activeReportId.current) {
				setProgress({ message: payload.message, percent: payload.percent })
			}
		})
	}, [])

	const handleGenerate = useCallback(async () => {
		setGenerating(true)
		setError(null)
		setProgress({ message: "Starting...", percent: 0 })

		try {
			const meta = await rpcRequest<ReportMeta>("generateReport", undefined, 300_000)
			activeReportId.current = meta.id
			setReports(prev => [meta, ...prev])
		} catch (e: any) {
			setError(e.message || "Report generation failed")
		} finally {
			setGenerating(false)
			setProgress(null)
			activeReportId.current = null
		}
	}, [])

	const handleDelete = useCallback(async (id: string) => {
		try {
			await rpcRequest("deleteReport", { id }, 5000)
			setReports(prev => prev.filter(r => r.id !== id))
		} catch {}
		setConfirmDeleteId(null)
	}, [])

	const [saving, setSaving] = useState<string | null>(null)

	const handleDownload = useCallback(async (id: string, format: ExportFormat) => {
		try {
			setSaving(`${id}-${format}`)
			setError(null)
			await rpcRequest<{ filePath: string }>("saveReportFile", { id, format }, 30000)
		} catch (e: any) {
			setError(e.message || `Failed to export ${format}`)
		} finally {
			setSaving(null)
		}
	}, [])

	return (
		<>
			{/* Backdrop */}
			<Box
				position="fixed"
				inset="0"
				bg="blackAlpha.700"
				zIndex={Z.dialog}
				onClick={generating ? undefined : onClose}
			/>

			{/* Dialog */}
			<Box
				position="fixed"
				top="50%"
				left="50%"
				transform="translate(-50%, -50%)"
				w="95%"
				maxW="520px"
				maxH="85vh"
				bg="kk.bg"
				border="1px solid"
				borderColor="kk.gold"
				borderRadius="xl"
				zIndex={Z.dialog + 1}
				overflow="hidden"
				display="flex"
				flexDirection="column"
			>
				{/* Header */}
				<Flex
					align="center"
					justify="space-between"
					px="5"
					py="4"
					borderBottom="1px solid"
					borderColor="kk.border"
					flexShrink={0}
				>
					<Text fontSize="lg" fontWeight="700" color="kk.gold">
						Reports &amp; Tax Export
					</Text>
					{!generating && (
						<Box
							as="button"
							color="kk.textMuted"
							fontSize="lg"
							cursor="pointer"
							_hover={{ color: "white" }}
							onClick={onClose}
						>
							&times;
						</Box>
					)}
				</Flex>

				{/* Scrollable body */}
				<Box flex="1" overflowY="auto" px="5" py="4">
					{/* Security notice */}
					<Box
						p="3"
						mb="4"
						bg="rgba(192,168,96,0.06)"
						border="1px solid"
						borderColor="rgba(192,168,96,0.15)"
						borderRadius="lg"
					>
						<Text fontSize="10px" color="kk.gold" lineHeight="1.5">
							Generate a report then export as KeepKey branded PDF, CoinTracker CSV,
							or ZenLedger CSV for tax filing. Reports include device info, chain balances,
							BTC transaction history, and address flow analysis.
							Store securely and never share with untrusted parties.
						</Text>
					</Box>

					{/* Generate button */}
					<Box
						as="button"
						w="100%"
						py="2.5"
						mb="4"
						bg={generating ? "kk.border" : "kk.gold"}
						color={generating ? "kk.textMuted" : "black"}
						fontSize="sm"
						fontWeight="700"
						borderRadius="lg"
						cursor={generating ? "default" : "pointer"}
						_hover={generating ? {} : { bg: "#e6c840" }}
						_active={generating ? {} : { transform: "scale(0.98)" }}
						onClick={generating ? undefined : handleGenerate}
						transition="all 0.15s"
					>
						{generating ? (
							<Flex align="center" justify="center" gap="2">
								<Spinner size="xs" />
								<Text>{progress?.message || "Generating..."}</Text>
							</Flex>
						) : (
							"Generate Report"
						)}
					</Box>

					{/* Progress bar */}
					{generating && progress && (
						<Box mb="4">
							<Box w="100%" h="4px" bg="kk.border" borderRadius="full" overflow="hidden">
								<Box
									h="100%"
									w={`${progress.percent}%`}
									bg="kk.gold"
									borderRadius="full"
									transition="width 0.3s"
								/>
							</Box>
							<Text fontSize="10px" color="kk.textMuted" mt="1" textAlign="center">
								{progress.percent}%
							</Text>
						</Box>
					)}

					{/* Error */}
					{error && (
						<Box
							p="3"
							mb="4"
							bg="rgba(220,53,69,0.08)"
							border="1px solid"
							borderColor="rgba(220,53,69,0.3)"
							borderRadius="lg"
						>
							<Text fontSize="xs" color="#DC3545">{error}</Text>
						</Box>
					)}

					{/* Previous reports */}
					{loadingReports ? (
						<Flex justify="center" py="4">
							<Spinner size="sm" color="kk.gold" />
						</Flex>
					) : reports.length > 0 ? (
						<Box>
							<Text fontSize="xs" color="kk.textSecondary" mb="2" fontWeight="600">
								Previous Reports
							</Text>
							<Flex direction="column" gap="3">
								{reports.map(r => (
									<Box
										key={r.id}
										p="3"
										bg="kk.cardBg"
										border="1px solid"
										borderColor="kk.border"
										borderRadius="lg"
									>
										<Flex justify="space-between" align="center" mb="1">
											<Text fontSize="xs" fontWeight="600" color="white">
												Full Detail Report
											</Text>
											<Text fontSize="10px" color={r.status === "error" ? "#DC3545" : "kk.textMuted"}>
												{r.status === "error" ? "Failed" : `$${r.totalUsd.toFixed(2)}`}
											</Text>
										</Flex>
										<Text fontSize="10px" color="kk.textMuted" mb="3">
											{new Date(r.createdAt).toLocaleString()}
										</Text>
										{r.error && (
											<Text fontSize="10px" color="#DC3545" mb="3">{r.error}</Text>
										)}

										{/* Export buttons with logos */}
										{r.status === "complete" && (
											<Flex gap="2" mb="2" wrap="wrap">
												{EXPORT_OPTIONS.map(({ key, label, sub, logo, bg }) => {
													const savingKey = `${r.id}-${key}`
													const isSavingThis = saving === savingKey
													return (
														<Box
															key={key}
															as="button"
															flex="1"
															minW="130px"
															p="2"
															bg={bg}
															border="1px solid"
															borderColor="rgba(192,168,96,0.2)"
															borderRadius="lg"
															cursor={isSavingThis ? "default" : "pointer"}
															opacity={isSavingThis ? 0.5 : 1}
															_hover={isSavingThis ? {} : { borderColor: "kk.gold", bg: "rgba(192,168,96,0.15)" }}
															transition="all 0.15s"
															onClick={() => !isSavingThis && handleDownload(r.id, key)}
														>
															<Flex align="center" gap="2">
																<Image
																	src={logo}
																	alt={label}
																	h="20px"
																	w="auto"
																	maxW="20px"
																	objectFit="contain"
																	borderRadius="3px"
																/>
																<Box textAlign="left">
																	<Text fontSize="10px" fontWeight="700" color="white" lineHeight="1.2">
																		{isSavingThis ? "Saving..." : label}
																	</Text>
																	<Text fontSize="8px" color="kk.textMuted" lineHeight="1.2">
																		{sub}
																	</Text>
																</Box>
															</Flex>
														</Box>
													)
												})}
											</Flex>
										)}

										{/* Delete with confirmation */}
										<Flex>
											{confirmDeleteId === r.id ? (
												<Flex gap="1" align="center">
													<Box
														as="button"
														px="2"
														py="1"
														fontSize="10px"
														fontWeight="600"
														color="white"
														bg="#DC3545"
														borderRadius="md"
														cursor="pointer"
														onClick={() => handleDelete(r.id)}
													>
														Confirm
													</Box>
													<Box
														as="button"
														px="2"
														py="1"
														fontSize="10px"
														fontWeight="600"
														color="kk.textMuted"
														bg="transparent"
														border="1px solid"
														borderColor="kk.border"
														borderRadius="md"
														cursor="pointer"
														onClick={() => setConfirmDeleteId(null)}
													>
														Cancel
													</Box>
												</Flex>
											) : (
												<Box
													as="button"
													px="2.5"
													py="1"
													fontSize="10px"
													fontWeight="600"
													color="kk.textMuted"
													bg="transparent"
													border="1px solid"
													borderColor="kk.border"
													borderRadius="md"
													cursor="pointer"
													_hover={{ borderColor: "#DC3545", color: "#DC3545" }}
													onClick={() => setConfirmDeleteId(r.id)}
												>
													Delete
												</Box>
											)}
										</Flex>
									</Box>
								))}
							</Flex>
						</Box>
					) : (
						<Text fontSize="xs" color="kk.textMuted" textAlign="center" py="4">
							No reports generated yet.
						</Text>
					)}
				</Box>
			</Box>
		</>
	)
}
