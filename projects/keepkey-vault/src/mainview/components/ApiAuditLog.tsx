import { Box, Flex, Text, VStack, IconButton } from "@chakra-ui/react"
import { Z } from "../lib/z-index"
import type { ApiLogEntry } from "../../shared/types"

interface ApiAuditLogProps {
	open: boolean
	entries: ApiLogEntry[]
	onClose: () => void
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

function relativeTime(ts: number): string {
	const delta = Math.floor((Date.now() - ts) / 1000)
	if (delta < 5) return "now"
	if (delta < 60) return `${delta}s ago`
	if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
	return `${Math.floor(delta / 3600)}h ago`
}

export function ApiAuditLog({ open, entries, onClose }: ApiAuditLogProps) {
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
						API Audit Log
					</Text>
					<Text fontSize="xs" color="kk.textMuted">
						({entries.length})
					</Text>
				</Flex>
				<IconButton
					aria-label="Close audit log"
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

			{/* Entries */}
			<VStack gap="0" align="stretch">
				{entries.length === 0 ? (
					<Box px="4" py="8" textAlign="center">
						<Text fontSize="sm" color="kk.textMuted">
							No API requests yet
						</Text>
					</Box>
				) : (
					entries.map((entry, i) => (
						<Flex
							key={`${entry.timestamp}-${i}`}
							align="center"
							gap="2"
							px="4"
							py="2.5"
							borderBottom="1px solid"
							borderColor="rgba(255,255,255,0.04)"
							_hover={{ bg: "rgba(255,255,255,0.02)" }}
						>
							<MethodBadge method={entry.method} />
							<Text
								fontSize="xs"
								color="kk.textPrimary"
								fontFamily="mono"
								flex="1"
								truncate
							>
								{entry.route}
							</Text>
							<Text fontSize="9px" color="kk.textMuted" flexShrink={0}>
								{entry.appName !== "public" ? entry.appName : ""}
							</Text>
							<StatusBadge status={entry.status} />
							<Text fontSize="9px" color="kk.textMuted" flexShrink={0} minW="40px" textAlign="right">
								{relativeTime(entry.timestamp)}
							</Text>
						</Flex>
					))
				)}
			</VStack>
		</Box>
	)
}
