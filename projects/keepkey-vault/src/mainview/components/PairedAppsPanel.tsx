import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, VStack, IconButton, Image } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { PairedAppInfo } from "../../shared/types"

interface PairedAppsPanelProps {
	open: boolean
	onClose: () => void
}

function AppInitial({ name }: { name: string }) {
	const letter = name.charAt(0).toUpperCase() || "?"
	return (
		<Flex
			w="32px"
			h="32px"
			borderRadius="8px"
			bg="rgba(192,168,96,0.15)"
			align="center"
			justify="center"
			flexShrink={0}
		>
			<Text fontSize="14px" fontWeight="700" color="#C0A860" lineHeight="1">
				{letter}
			</Text>
		</Flex>
	)
}

function AppLogo({ name, imageUrl }: { name: string; imageUrl?: string }) {
	const [failed, setFailed] = useState(false)

	if (!imageUrl || failed) return <AppInitial name={name} />

	return (
		<Image
			src={imageUrl}
			alt={name}
			w="32px"
			h="32px"
			borderRadius="8px"
			objectFit="cover"
			flexShrink={0}
			onError={() => setFailed(true)}
		/>
	)
}

function formatDate(ts: number): string {
	if (!ts) return "—"
	const d = new Date(ts)
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export function PairedAppsPanel({ open, onClose }: PairedAppsPanelProps) {
	const [apps, setApps] = useState<PairedAppInfo[]>([])
	const [loading, setLoading] = useState(false)
	const [revoking, setRevoking] = useState<string | null>(null)
	const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

	const fetchApps = useCallback(async () => {
		setLoading(true)
		try {
			const result = await rpcRequest<PairedAppInfo[]>("listPairedApps")
			setApps(result)
		} catch (e) {
			console.error("listPairedApps:", e)
		}
		setLoading(false)
	}, [])

	useEffect(() => {
		if (open) {
			fetchApps()
			setConfirmRevoke(null)
		}
	}, [open, fetchApps])

	const handleRevoke = useCallback(async (apiKey: string) => {
		setRevoking(apiKey)
		try {
			await rpcRequest("revokePairing", { apiKey })
			setApps((prev) => prev.filter((a) => a.apiKey !== apiKey))
		} catch (e) {
			console.error("revokePairing:", e)
		}
		setRevoking(null)
		setConfirmRevoke(null)
	}, [])

	if (!open) return null

	return (
		<Box
			position="fixed"
			top="0"
			right="0"
			h="100vh"
			w="380px"
			maxW="90vw"
			bg="kk.bg"
			borderLeft="1px solid"
			borderColor="kk.border"
			zIndex={Z.drawerPanel}
			overflowY="auto"
			role="dialog"
			aria-label="Paired Apps"
			aria-modal="true"
		>
			{/* Header */}
			<Flex
				align="center"
				justify="space-between"
				px="4"
				py="3"
				borderBottom="1px solid"
				borderColor="kk.border"
				position="sticky"
				top="0"
				bg="kk.bg"
				zIndex={1}
			>
				<Flex align="center" gap="2">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
						<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
					</svg>
					<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
						Paired Apps
					</Text>
					<Text fontSize="xs" color="kk.textMuted">
						({apps.length})
					</Text>
				</Flex>
				<IconButton
					aria-label="Close paired apps"
					onClick={onClose}
					size="sm"
					variant="ghost"
					color="kk.textSecondary"
					_hover={{ color: "kk.textPrimary" }}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</IconButton>
			</Flex>

			{/* Content */}
			<VStack gap="0" align="stretch">
				{loading && apps.length === 0 ? (
					<Box px="4" py="8" textAlign="center">
						<Text fontSize="sm" color="kk.textMuted">Loading...</Text>
					</Box>
				) : apps.length === 0 ? (
					<Box px="4" py="8" textAlign="center">
						<Text fontSize="sm" color="kk.textMuted" mb="1">
							No paired apps
						</Text>
						<Text fontSize="xs" color="kk.textMuted">
							Apps paired via the REST API will appear here.
						</Text>
					</Box>
				) : (
					apps.map((app) => (
						<Flex
							key={app.apiKey}
							align="center"
							gap="3"
							px="4"
							py="3"
							borderBottom="1px solid"
							borderColor="rgba(255,255,255,0.04)"
							_hover={{ bg: "rgba(255,255,255,0.02)" }}
						>
							<AppLogo name={app.name} imageUrl={app.imageUrl} />
							<Box flex="1" minW="0">
								<Text fontSize="sm" fontWeight="500" color="kk.textPrimary" truncate>
									{app.name}
								</Text>
								{app.url && (
									<Text fontSize="xs" color="kk.textMuted" truncate>
										{app.url}
									</Text>
								)}
								<Text fontSize="10px" color="kk.textMuted" mt="0.5">
									Paired {formatDate(app.addedOn)}
								</Text>
							</Box>
							{confirmRevoke === app.apiKey ? (
								<Flex gap="2" align="center" flexShrink={0}>
									<Box
										as="button"
										px="3"
										py="1.5"
										borderRadius="full"
										bg="#FF4444"
										color="white"
										fontSize="xs"
										fontWeight="600"
										cursor={revoking === app.apiKey ? "not-allowed" : "pointer"}
										opacity={revoking === app.apiKey ? 0.6 : 1}
										_hover={{ bg: "#FF2222" }}
										transition="all 0.15s"
										onClick={() => handleRevoke(app.apiKey)}
									>
										{revoking === app.apiKey ? "..." : "Confirm"}
									</Box>
									<Box
										as="button"
										px="2"
										py="1.5"
										color="kk.textSecondary"
										fontSize="xs"
										cursor="pointer"
										_hover={{ color: "kk.textPrimary" }}
										onClick={() => setConfirmRevoke(null)}
									>
										Cancel
									</Box>
								</Flex>
							) : (
								<Box
									as="button"
									px="3"
									py="1.5"
									borderRadius="full"
									bg="rgba(255,23,68,0.08)"
									color="#FF6B6B"
									fontSize="xs"
									fontWeight="500"
									cursor="pointer"
									_hover={{ bg: "rgba(255,23,68,0.18)" }}
									transition="all 0.15s"
									flexShrink={0}
									onClick={() => setConfirmRevoke(app.apiKey)}
								>
									Revoke
								</Box>
							)}
						</Flex>
					))
				)}
			</VStack>
		</Box>
	)
}
