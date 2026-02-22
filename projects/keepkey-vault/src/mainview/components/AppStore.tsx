import { Box, Flex, Text, Grid, Image } from "@chakra-ui/react"

interface AppDef {
	id: string
	name: string
	description: string
	icon: string
	/** Inline SVG fallback when icon URL may 404 */
	iconFallback?: JSX.Element
	url: string
	enabled: boolean
	badge?: string
	/** If true, this app is internal (switches tab) rather than opening a URL */
	internal?: boolean
}

/** WalletConnect logo as inline SVG (CDN icon unreliable) */
const WalletConnectIcon = () => (
	<svg width="80" height="80" viewBox="0 0 100 100">
		<rect width="100" height="100" rx="20" fill="#3B99FC" />
		<path
			d="M31.5 38.5c10.2-10.2 26.8-10.2 37 0l1.2 1.2a1.3 1.3 0 0 1 0 1.8l-4.2 4.2a.65.65 0 0 1-.9 0l-1.7-1.7a19.3 19.3 0 0 0-26.8 0l-1.8 1.8a.65.65 0 0 1-.9 0l-4.2-4.2a1.3 1.3 0 0 1 0-1.8l1.3-1.3zm45.7 8.5l3.7 3.7a1.3 1.3 0 0 1 0 1.8L64.7 68.7a1.3 1.3 0 0 1-1.8 0L52.1 57.9a.33.33 0 0 0-.45 0L40.9 68.7a1.3 1.3 0 0 1-1.8 0L22.9 52.5a1.3 1.3 0 0 1 0-1.8l3.7-3.7a1.3 1.3 0 0 1 1.8 0l10.8 10.8a.33.33 0 0 0 .45 0L50.4 47a1.3 1.3 0 0 1 1.8 0L63 57.8a.33.33 0 0 0 .45 0L74.3 47a1.3 1.3 0 0 1 1.8 0z"
			fill="#fff"
		/>
	</svg>
)

const APPS: AppDef[] = [
	{
		id: "keepkey",
		name: "KeepKey",
		description: "Manage your KeepKey hardware wallet",
		icon: "https://pioneers.dev/coins/keepkey.png",
		url: "https://vault.keepkey.com",
		enabled: true,
	},
	{
		id: "shapeshift",
		name: "ShapeShift",
		description: "Trade, track, and manage your crypto across chains",
		icon: "https://pioneers.dev/coins/fox.png",
		url: "https://app.shapeshift.com",
		enabled: true,
	},
	{
		id: "walletconnect",
		name: "WalletConnect",
		description: "Connect to any WalletConnect-compatible dApp",
		icon: "",
		iconFallback: <WalletConnectIcon />,
		url: "https://wallet-connect-dapp-ochre.vercel.app",
		enabled: true,
	},
]

interface AppStoreProps {
	onOpenApp: (url: string) => void
	onOpenKeepKey: () => void
}

export function AppStore({ onOpenApp, onOpenKeepKey }: AppStoreProps) {
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
					Apps
				</Text>
				<Text fontSize="sm" color="kk.textSecondary" mb="5">
					Connect your KeepKey to supported applications
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
								{app.iconFallback ? (
									<Box w="64px" h="64px" borderRadius="xl" overflow="hidden">
										{app.iconFallback}
									</Box>
								) : (
									<Image
										src={app.icon}
										alt={app.name}
										w="64px"
										h="64px"
										borderRadius="xl"
										bg="gray.800"
									/>
								)}
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
