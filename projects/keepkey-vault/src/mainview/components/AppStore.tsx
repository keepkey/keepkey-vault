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
	/** Brand accent — drives the soft blur tint in the card's top-right corner */
	accent?: string
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
			accent: "var(--gold)",
		},
		{
			id: "shapeshift",
			name: t("shapeshiftName"),
			description: t("shapeshiftDescription"),
			icon: "https://pioneers.dev/coins/fox.png",
			url: "https://app.shapeshift.com",
			enabled: true,
			accent: "var(--teal)",
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
		if (app.internal) onOpenKeepKey()
		else if (app.url) onOpenApp(app.url)
	}

	return (
		<Flex flex="1" direction="column" align="center" px={{ base: "4", md: "8" }} py={{ base: "10", md: "16" }} className="v3-page-enter">
			<Box w="100%" maxW="1100px">
				{/* Hero header — eyebrow + Instrument Serif italic title */}
				<Box mb={{ base: "8", md: "12" }}>
					<Text
						fontSize="11px"
						color="var(--text-3)"
						letterSpacing="0.18em"
						textTransform="uppercase"
						mb="3"
						fontWeight="500"
					>
						{t("title")}
					</Text>
					<Text
						as="h1"
						fontFamily="serif"
						fontStyle="italic"
						fontWeight="400"
						letterSpacing="-0.02em"
						color="var(--text-0)"
						lineHeight="1"
						fontSize={{ base: "44px", md: "64px" }}
						m="0"
					>
						Apps
					</Text>
					<Text fontSize="15px" color="var(--text-2)" mt="3" maxW="520px" lineHeight="1.5">
						{t("subtitle")}
					</Text>
				</Box>

				<Grid templateColumns={{ base: "1fr", sm: "repeat(auto-fill, minmax(260px, 1fr))" }} gap="4">
					{APPS.map((app) => (
						<Box
							key={app.id}
							as="button"
							className="electrobun-webkit-app-region-no-drag"
							textAlign="left"
							p="6"
							bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))"
							border="1px solid var(--line)"
							borderRadius="var(--r-lg)"
							cursor={app.enabled ? "pointer" : "default"}
							opacity={app.enabled ? 1 : 0.45}
							_hover={app.enabled ? { borderColor: "var(--line-2)", transform: "translateY(-2px)" } : {}}
							transition="all 0.25s"
							onClick={() => handleClick(app)}
							position="relative"
							overflow="hidden"
						>
							{/* soft accent glow in the corner */}
							{app.enabled && app.accent && (
								<Box
									position="absolute"
									top="-40px"
									right="-40px"
									w="120px"
									h="120px"
									borderRadius="full"
									bg={app.accent}
									opacity="0.06"
									filter="blur(20px)"
									pointerEvents="none"
								/>
							)}

							<Box
								w="56px"
								h="56px"
								borderRadius="14px"
								bg="var(--ink-3)"
								border="1px solid var(--line-2)"
								display="grid"
								placeItems="center"
								mb="5"
								overflow="hidden"
								position="relative"
							>
								<Image
									src={app.icon}
									alt={app.name}
									w="100%"
									h="100%"
									objectFit="cover"
								/>
							</Box>

							<Flex align="center" gap="2" mb="1">
								<Text fontSize="17px" fontWeight="600" color="var(--text-0)" letterSpacing="-0.01em">
									{app.name}
								</Text>
								{app.badge && (
									<Text
										fontSize="9.5px"
										fontFamily="mono"
										bg="var(--ink-3)"
										color="var(--text-2)"
										px="2"
										py="0.5"
										borderRadius="sm"
										fontWeight="500"
										letterSpacing="0.04em"
										lineHeight="1.4"
										textTransform="uppercase"
									>
										{app.badge}
									</Text>
								)}
							</Flex>
							<Text fontSize="13px" color="var(--text-2)" mb="6" lineHeight="1.5">
								{app.description}
							</Text>

							{app.enabled && (
								<Flex align="center" gap="1.5" fontSize="12px" color="var(--text-3)">
									{!app.internal && (
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
											<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
											<path d="M15 3h6v6M10 14L21 3" />
										</svg>
									)}
									<Text as="span">{app.internal ? t("internal", { defaultValue: "Open" }) : t("open", { defaultValue: "Open" })}</Text>
								</Flex>
							)}
						</Box>
					))}
				</Grid>
			</Box>
		</Flex>
	)
}
