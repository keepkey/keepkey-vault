import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Spinner } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { ReportMeta } from "../../shared/types"

interface ReportDialogProps {
	onClose: () => void
}

export function ReportDialog({ onClose }: ReportDialogProps) {
	const { t } = useTranslation("common")
	const [generating, setGenerating] = useState(false)
	const [progress, setProgress] = useState<{ message: string; percent: number } | null>(null)
	const [reports, setReports] = useState<ReportMeta[]>([])
	const [error, setError] = useState<string | null>(null)
	const [loadingReports, setLoadingReports] = useState(true)
	const activeReportId = useRef<string | null>(null)

	// Load report list on mount
	useEffect(() => {
		rpcRequest<ReportMeta[]>("listReports", undefined, 5000)
			.then(setReports)
			.catch(() => {})
			.finally(() => setLoadingReports(false))
	}, [])

	// Listen for progress messages
	useEffect(() => {
		return onRpcMessage("report-progress", (payload: { id: string; message: string; percent: number }) => {
			if (activeReportId.current && payload.id === activeReportId.current) {
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
	}, [])

	const [saving, setSaving] = useState<string | null>(null)

	const handleDownload = useCallback(async (id: string, format: "json" | "csv" | "pdf") => {
		try {
			setSaving(`${id}-${format}`)
			await rpcRequest<{ filePath: string }>("saveReportFile", { id, format }, 30000)
		} catch {} finally {
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
						Portfolio Reports
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
							Full Detail Report — includes device info, all chain balances, cached pubkeys,
							token details, BTC transaction history, and address flow analysis.
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
							<Flex direction="column" gap="2">
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
										<Text fontSize="10px" color="kk.textMuted" mb="2">
											{new Date(r.createdAt).toLocaleString()}
										</Text>
										{r.error && (
											<Text fontSize="10px" color="#DC3545" mb="2">{r.error}</Text>
										)}
										<Flex gap="2">
											{r.status === "complete" && (
												<>
													{(["JSON", "CSV", "PDF"] as const).map(fmt => {
														const key = fmt.toLowerCase() as "json" | "csv" | "pdf"
														const savingKey = `${r.id}-${key}`
														return (
															<Box
																key={fmt}
																as="button"
																px="2.5"
																py="1"
																fontSize="10px"
																fontWeight="600"
																color="kk.gold"
																bg="rgba(192,168,96,0.1)"
																border="1px solid"
																borderColor="rgba(192,168,96,0.3)"
																borderRadius="md"
																cursor={saving ? "default" : "pointer"}
																opacity={saving === savingKey ? 0.6 : 1}
																_hover={saving ? {} : { bg: "rgba(192,168,96,0.2)" }}
																onClick={() => !saving && handleDownload(r.id, key)}
															>
																{saving === savingKey ? "Saving..." : fmt}
															</Box>
														)
													})}
												</>
											)}
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
												onClick={() => handleDelete(r.id)}
											>
												Delete
											</Box>
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
