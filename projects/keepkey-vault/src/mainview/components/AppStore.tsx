import { Box, Flex, Text, Grid, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"

interface AppDef {
	id: string
	name: string
	description: string
	icon: string
	url: string
	enabled: boolean
	badge?: string
	/** If true, this app is internal (switches tab) rather than opening a URL */
	internal?: boolean
}

function useApps(): AppDef[] {
	const { t } = useTranslation("appstore")
	return [
		{
			id: "keepkey",
			name: t("keepkeyName"),
			description: t("keepkeyDescription"),
			icon: "https://pioneers.dev/coins/keepkey.png",
			url: "https://vault.keepkey.com",
			enabled: true,
		},
		{
			id: "shapeshift",
			name: t("shapeshiftName"),
			description: t("shapeshiftDescription"),
			icon: "https://pioneers.dev/coins/fox.png",
			url: "https://app.shapeshift.com",
			enabled: true,
		},
	]
}

interface AppStoreProps {
	onOpenApp: (url: string) => void
	onOpenKeepKey: () => void
}

export function AppStore({ onOpenApp, onOpenKeepKey }: AppStoreProps) {
	const { t } = useTranslation("appstore")
	const APPS = useApps()
	const handleClick = (app: AppDef) => {
		if (!app.enabled) return
		if (app.internal) {
			onOpenKeepKey()
		} else if (app.url) {
			onOpenApp(app.url)
		}
	}

	return (
		<Flex flex="1" direction="column" align="center" px={{ base: "3", md: "6" }} py="6">
			<Box w="100%" maxW="600px">
				<Text fontSize="lg" fontWeight="600" color="kk.textPrimary" mb="1">
					{t("title")}
				</Text>
				<Text fontSize="sm" color="kk.textSecondary" mb="5">
					{t("subtitle")}
				</Text>
				<Grid
					templateColumns="repeat(auto-fill, minmax(160px, 1fr))"
					gap="4"
				>
					{APPS.map((app) => (
						<Box
							key={app.id}
							p="5"
							bg="kk.cardBg"
							border="1px solid"
							borderColor={app.enabled ? "kk.border" : "rgba(255,255,255,0.04)"}
							borderRadius="xl"
							cursor={app.enabled ? "pointer" : "default"}
							opacity={app.enabled ? 1 : 0.45}
							_hover={app.enabled ? { borderColor: "kk.gold", bg: "rgba(255,255,255,0.04)" } : {}}
							transition="all 0.15s"
							onClick={() => handleClick(app)}
						>
							<Flex direction="column" align="center" gap="3">
								<Image
									src={app.icon}
									alt={app.name}
									w="64px"
									h="64px"
									borderRadius="xl"
									bg="gray.800"
								/>
								<Flex direction="column" align="center" gap="0.5">
									<Flex align="center" gap="2">
										<Text fontSize="sm" fontWeight="600" color="white">
											{app.name}
										</Text>
										{app.badge && (
											<Text
												fontSize="9px"
												bg="rgba(255,255,255,0.08)"
												color="kk.textMuted"
												px="1.5"
												py="0.5"
												borderRadius="sm"
												fontWeight="500"
												lineHeight="1"
											>
												{app.badge}
											</Text>
										)}
									</Flex>
									<Text fontSize="xs" color="kk.textSecondary" textAlign="center" lineHeight="1.3">
										{app.description}
									</Text>
								</Flex>
								{app.enabled && !app.internal && (
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity={0.4}>
										<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
										<polyline points="15 3 21 3 21 9" />
										<line x1="10" y1="14" x2="21" y2="3" />
									</svg>
								)}
							</Flex>
						</Box>
					))}
				</Grid>
			</Box>
		</Flex>
	)
}
