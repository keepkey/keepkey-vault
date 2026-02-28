import { useState } from "react"
import { Box, Flex, Text, VStack, IconButton, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../lib/z-index"
import type { ApiLogEntry } from "../../shared/types"

interface ApiAuditLogProps {
	open: boolean
	entries: ApiLogEntry[]
	onClose: () => void
	/** When true, render on the left side (e.g. WalletConnect panel owns the right) */
	side?: "left" | "right"
}

function StatusBadge({ status }: { status: number }) {
	const color = status < 300 ? "#4ADE80" : status < 500 ? "#FB923C" : "#FF6B6B"
	return (
		<Text
			fontSize="9px"
			fontWeight="600"
			color={color}
			bg={`${color}18`}
			px="1.5"
			py="0.5"
			borderRadius="sm"
			lineHeight="1"
			fontFamily="mono"
		>
			{status}
		</Text>
	)
}

function MethodBadge({ method }: { method: string }) {
	const color = method === "GET" ? "#60A5FA" : "#4ADE80"
	return (
		<Text
			fontSize="9px"
			fontWeight="600"
			color={color}
			bg={`${color}18`}
			px="1.5"
			py="0.5"
			borderRadius="sm"
			lineHeight="1"
			fontFamily="mono"
			minW="32px"
			textAlign="center"
		>
			{method}
		</Text>
	)
}

/** Fallback icon when imageUrl fails or is missing */
function AppInitial({ name }: { name: string }) {
	const letter = name.charAt(0).toUpperCase() || "?"
	return (
		<Flex
			w="18px"
			h="18px"
			borderRadius="4px"
			bg="rgba(192,168,96,0.15)"
			align="center"
			justify="center"
			flexShrink={0}
		>
			<Text fontSize="9px" fontWeight="700" color="#C0A860" lineHeight="1">
				{letter}
			</Text>
		</Flex>
	)
}

/** Small app logo with fallback to initial */
function AppLogo({ name, imageUrl, size = 18 }: { name: string; imageUrl?: string; size?: number }) {
	const [failed, setFailed] = useState(false)

	if (!imageUrl || failed) return <AppInitial name={name} />

	return (
		<Image
			src={imageUrl}
			alt={name}
			w={`${size}px`}
			h={`${size}px`}
			borderRadius="4px"
			objectFit="cover"
			flexShrink={0}
			onError={() => setFailed(true)}
		/>
	)
}

function relativeTime(ts: number): string {
	const delta = Math.floor((Date.now() - ts) / 1000)
	if (delta < 5) return "now"
	if (delta < 60) return `${delta}s ago`
	if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
	return `${Math.floor(delta / 3600)}h ago`
}

/** Derive unique paired apps from log entries */
function getUniqueApps(entries: ApiLogEntry[]): Array<{ name: string; imageUrl: string }> {
	const seen = new Map<string, string>()
	for (const e of entries) {
		if (e.appName && e.appName !== "public" && !seen.has(e.appName)) {
			seen.set(e.appName, e.imageUrl || "")
		}
	}
	return Array.from(seen, ([name, imageUrl]) => ({ name, imageUrl }))
}

/** Truncate JSON string for display */
function truncateJson(data: any, maxLen = 500): string {
	try {
		const str = typeof data === "string" ? data : JSON.stringify(data, null, 2)
		if (str.length <= maxLen) return str
		return str.slice(0, maxLen) + "\n..."
	} catch {
		return String(data)
	}
}

/** Collapsible JSON block with copy button */
function JsonBlock({ label, data }: { label: string; data: any }) {
	const [copied, setCopied] = useState(false)
	if (data === undefined || data === null) return null

	const handleCopy = (e: React.MouseEvent) => {
		e.stopPropagation()
		const fullJson = typeof data === "string" ? data : JSON.stringify(data, null, 2)
		navigator.clipboard.writeText(fullJson).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		}).catch(() => {})
	}

	return (
		<Box mt="1.5">
			<Flex align="center" justify="space-between" mb="1">
				<Text fontSize="9px" fontWeight="600" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em">
					{label}
				</Text>
				<Text
					as="button"
					fontSize="9px"
					fontWeight="500"
					color={copied ? "#4ADE80" : "kk.textMuted"}
					cursor="pointer"
					_hover={{ color: copied ? "#4ADE80" : "kk.textSecondary" }}
					onClick={handleCopy}
					transition="color 0.15s"
				>
					{copied ? "Copied!" : "Copy"}
				</Text>
			</Flex>
			<Box
				bg="rgba(0,0,0,0.3)"
				borderRadius="4px"
				p="2"
				maxH="200px"
				overflowY="auto"
				border="1px solid"
				borderColor="rgba(255,255,255,0.06)"
			>
				<Text
					fontSize="10px"
					fontFamily="mono"
					color="kk.textSecondary"
					whiteSpace="pre-wrap"
					wordBreak="break-all"
					lineHeight="1.4"
				>
					{truncateJson(data)}
				</Text>
			</Box>
		</Box>
	)
}

export function ApiAuditLog({ open, entries, onClose, side = "right" }: ApiAuditLogProps) {
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
	const { t } = useTranslation("settings")

	if (!open) return null

	const pairedApps = getUniqueApps(entries)
	const isLeft = side === "left"

	return (
		<Box
			position="fixed"
			top="0"
			left={isLeft ? "0" : undefined}
			right={isLeft ? undefined : "0"}
			h="100vh"
			w="380px"
			maxW="90vw"
			bg="kk.bg"
			borderLeft={isLeft ? undefined : "1px solid"}
			borderRight={isLeft ? "1px solid" : undefined}
			borderColor="kk.border"
			zIndex={Z.drawerPanel}
			overflowY="auto"
			boxShadow={isLeft ? "4px 0 24px rgba(0,0,0,0.5)" : "-4px 0 24px rgba(0,0,0,0.5)"}
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
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
						<polyline points="14 2 14 8 20 8" />
						<line x1="16" y1="13" x2="8" y2="13" />
						<line x1="16" y1="17" x2="8" y2="17" />
						<polyline points="10 9 9 9 8 9" />
					</svg>
					<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
						{t('auditLogPanel.title')}
					</Text>
					<Text fontSize="xs" color="kk.textMuted">
						({entries.length})
					</Text>
				</Flex>
				<IconButton
					aria-label={t('auditLogPanel.closeAuditLog')}
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

			{/* Paired Apps strip */}
			{pairedApps.length > 0 && (
				<Box
					px="4"
					py="2.5"
					borderBottom="1px solid"
					borderColor="kk.border"
					bg="rgba(192,168,96,0.04)"
				>
					<Text fontSize="9px" fontWeight="600" color="kk.textMuted" mb="1.5" textTransform="uppercase" letterSpacing="0.05em">
						{t('auditLogPanel.pairedAppsCount', { count: pairedApps.length })}
					</Text>
					<Flex gap="2" flexWrap="wrap">
						{pairedApps.map((app) => (
							<Flex
								key={app.name}
								align="center"
								gap="1.5"
								bg="rgba(255,255,255,0.04)"
								borderRadius="6px"
								px="2"
								py="1"
								border="1px solid"
								borderColor="rgba(255,255,255,0.06)"
							>
								<AppLogo name={app.name} imageUrl={app.imageUrl} size={16} />
								<Text fontSize="10px" fontWeight="500" color="kk.textSecondary" lineHeight="1">
									{app.name}
								</Text>
							</Flex>
						))}
					</Flex>
				</Box>
			)}

			{/* Entries */}
			<VStack gap="0" align="stretch">
				{entries.length === 0 ? (
					<Box px="4" py="8" textAlign="center">
						<Text fontSize="sm" color="kk.textMuted">
							{t('auditLogPanel.noRequests')}
						</Text>
					</Box>
				) : (
					entries.map((entry, i) => {
						const isExpanded = expandedIndex === i
						const hasDetail = entry.requestBody || entry.responseBody
						return (
							<Box
								key={`${entry.timestamp}-${i}`}
								borderBottom="1px solid"
								borderColor="rgba(255,255,255,0.04)"
								_hover={{ bg: "rgba(255,255,255,0.02)" }}
								cursor={hasDetail ? "pointer" : "default"}
								onClick={() => {
									if (hasDetail) setExpandedIndex(isExpanded ? null : i)
								}}
							>
								<Flex align="center" gap="2" px="4" py="2.5">
									{/* App logo (or method badge for public requests) */}
									{entry.appName && entry.appName !== "public" ? (
										<AppLogo name={entry.appName} imageUrl={entry.imageUrl} />
									) : (
										<MethodBadge method={entry.method} />
									)}
									<Text
										fontSize="xs"
										color="kk.textPrimary"
										fontFamily="mono"
										flex="1"
										truncate
									>
										{entry.route}
									</Text>
									{entry.appName && entry.appName !== "public" && (
										<Text fontSize="9px" color="kk.textMuted" flexShrink={0} maxW="60px" truncate>
											{entry.appName}
										</Text>
									)}
									{entry.durationMs !== undefined && entry.durationMs > 0 && (
										<Text fontSize="9px" color="kk.textMuted" fontFamily="mono" flexShrink={0}>
											{entry.durationMs}ms
										</Text>
									)}
									<StatusBadge status={entry.status} />
									<Text fontSize="9px" color="kk.textMuted" flexShrink={0} minW="40px" textAlign="right">
										{relativeTime(entry.timestamp)}
									</Text>
									{hasDetail && (
										<Text fontSize="9px" color="kk.textMuted" flexShrink={0} transition="transform 0.15s" transform={isExpanded ? "rotate(180deg)" : "rotate(0deg)"}>
											&#x25BC;
										</Text>
									)}
								</Flex>
								{/* Expanded detail panel */}
								{isExpanded && hasDetail && (
									<Box px="4" pb="3" pt="0">
										<JsonBlock label={t('auditLogPanel.requestBody')} data={entry.requestBody} />
										<JsonBlock label={t('auditLogPanel.responseBody')} data={entry.responseBody} />
									</Box>
								)}
							</Box>
						)
					})
				)}
			</VStack>
		</Box>
	)
}
