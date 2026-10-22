import { Box, Flex, Text, Grid, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import supportIcon from "../assets/apps/support.svg"
import docsIcon from "../assets/apps/docs.svg"
import affiliatesIcon from "../assets/apps/affiliates.svg"
import bexIcon from "../assets/apps/bex.svg"
import keepkeyIcon from "../assets/apps/keepkey.png"
import shapeshiftIcon from "../assets/apps/shapeshift.png"
import swapsproIcon from "../assets/apps/swapspro.png"
import { rpcRequest } from "../lib/rpc"
import { DOCS_LINKS, watch } from "../../shared/docs-links"

/** KeepKey Academy: the main course from docs.keepkey.com/watch, copied from the
 *  docs repo's data/videos.json (ids, titles, posters). Cards open the docs
 *  player at that video; old ids keep working there if a video is re-released. */
const ACADEMY = [
	{ id: "course-overview-welcome", code: "START 00", title: "Welcome to KeepKey", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/releases/intro-20261022-17708cbfdb65/course-overview-welcome.jpg" },
	{ id: "course-01-install", code: "START 01", title: "Download, install and connect", minutes: 2, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/releases/intro-20261022-17708cbfdb65/course-01-install.jpg" },
	{ id: "course-02-setup", code: "START 02", title: "Create your wallet and PIN", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/releases/intro-20261022-17708cbfdb65/course-02-setup.jpg" },
	{ id: "intro-backup", code: "START 03", title: "Write down and check your backup", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/releases/intro-20261022-17708cbfdb65/intro-backup.jpg" },
	{ id: "course-04-receive", code: "START 04", title: "Receive your first payment", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/releases/intro-20261022-17708cbfdb65/course-04-receive.jpg" },
	{ id: "course-05-send", code: "START 05", title: "Make your first payment", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/releases/intro-20261022-17708cbfdb65/course-05-send.jpg" },
	{ id: "course-06-verify", code: "HELP 05", title: "Verify on your device", minutes: 2, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/course/course-06-verify-b1775ee665d373a7.jpg" },
	{ id: "course-07-swap", code: "MULTI 03", title: "Review a swap", minutes: 2, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/course/course-07-swap-d22999eba8988fad.jpg" },
	{ id: "course-09-passphrase", code: "MULTI 05", title: "Passphrase wallets", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/course/course-09-passphrase-7c6bb1de6a8097ef.jpg" },
	{ id: "course-08-firmware", code: "MULTI 06", title: "Update firmware", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/course/course-08-firmware-21ce86184a0680bc.jpg" },
	{ id: "course-11-app-connections", code: "MULTI 04", title: "Connect an application", minutes: 1, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/course/course-11-app-connections-2f16b7f25918bf03.jpg" },
	{ id: "course-13-not-showing", code: "MULTI 07", title: "Find a missing payment", minutes: 2, poster: "https://pub-adc370f689a247389d20badd7a32cf36.r2.dev/step-by-step/course/course-13-not-showing-5ecfb6af707c4494.jpg" },
]

/** Docs and videos open in the system browser, not as a dApp window. */
const openExternal = (url: string) => { rpcRequest("openUrl", { url }).catch(() => {}) }

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
	/** Opens in the system browser instead of as a dApp (docs, not an app) */
	external?: boolean
}

function useApps(): AppDef[] {
	const { t } = useTranslation("appstore")
	return [
		{
			id: "keepkey",
			name: t("keepkeyName"),
			description: t("keepkeyDescription"),
			icon: keepkeyIcon,
			url: "https://keepkey.com",
			enabled: true,
			accent: "var(--gold)",
		},
		{
			id: "bex",
			name: t("bexName"),
			description: t("bexDescription"),
			icon: bexIcon,
			url: "https://keepkey.com/bex",
			enabled: true,
			accent: "var(--gold)",
		},
		{
			id: "shapeshift",
			name: t("shapeshiftName"),
			description: t("shapeshiftDescription"),
			icon: shapeshiftIcon,
			url: "https://app.shapeshift.com",
			enabled: true,
			accent: "var(--teal)",
		},
		{
			id: "swapspro",
			name: t("swapsproName"),
			description: t("swapsproDescription"),
			icon: swapsproIcon,
			url: "https://swaps.pro",
			enabled: true,
			accent: "var(--teal)",
		},
		{
			id: "support",
			name: t("supportName"),
			description: t("supportDescription"),
			icon: supportIcon,
			url: "https://support.keepkey.com",
			enabled: true,
			accent: "var(--gold)",
		},
		{
			id: "docs",
			name: t("docsName"),
			description: t("docsDescription"),
			icon: docsIcon,
			url: DOCS_LINKS.docsHome,
			enabled: true,
			accent: "var(--gold)",
			external: true,
		},
		{
			id: "affiliates",
			name: t("affiliatesName"),
			description: t("affiliatesDescription"),
			icon: affiliatesIcon,
			url: "https://affiliates.keepkey.com",
			enabled: true,
			accent: "var(--gold)",
		},
		{
			id: "coincap",
			name: t("coincapName"),
			description: t("coincapDescription"),
			icon: "https://coincap.io/static/logo_mark.png",
			url: "https://coincap.io",
			enabled: true,
			accent: "var(--teal)",
		},
		{
			id: "venice",
			name: t("veniceName"),
			description: t("veniceDescription"),
			icon: "https://venice.ai/apple-touch-icon.png",
			url: "https://venice.ai",
			enabled: true,
			accent: "var(--gold)",
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
		else if (app.external) openExternal(app.url)
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
						fontWeight="500"
						letterSpacing="-0.01em"
						color="var(--text-0)"
						lineHeight="1"
						fontSize={{ base: "44px", md: "64px" }}
						m="0"
					>
						{t("heading")}
					</Text>
					<Text fontSize="15px" color="var(--text-2)" mt="3" maxW="520px" lineHeight="1.5">
						{t("subtitle")}
					</Text>
				</Box>

				{/* ── KeepKey Academy ── */}
				<Flex align="baseline" justify="space-between" mb="4" gap="3" wrap="wrap">
					<Box>
						<Text fontSize="22px" fontWeight="600" color="var(--text-0)" letterSpacing="-0.01em">
							{t("academyTitle", { defaultValue: "KeepKey Academy" })}
						</Text>
						<Text fontSize="13px" color="var(--text-2)" mt="1">
							{t("academySubtitle", { defaultValue: "Short videos that walk through KeepKey one step at a time." })}
						</Text>
					</Box>
					<Text as="button" fontSize="13px" color="var(--text-2)" textDecoration="underline" _hover={{ color: "var(--text-0)" }}
						onClick={() => openExternal(DOCS_LINKS.watchAll)}>
						{t("academyAll", { defaultValue: "All videos" })}
					</Text>
				</Flex>
				<Grid templateColumns={{ base: "1fr 1fr", sm: "repeat(auto-fill, minmax(200px, 1fr))" }} gap="3" mb={{ base: "10", md: "14" }}>
					{ACADEMY.map((v) => (
						<Box
							key={v.id}
							as="button"
							className="electrobun-webkit-app-region-no-drag"
							textAlign="left"
							bg="var(--ink-2)"
							border="1px solid var(--line)"
							borderRadius="var(--r-lg)"
							overflow="hidden"
							cursor="pointer"
							_hover={{ borderColor: "var(--line-2)", transform: "translateY(-2px)" }}
							transition="all 0.25s"
							onClick={() => openExternal(watch(v.id))}
						>
							<Box position="relative" aspectRatio="16 / 9" bg="var(--ink-3)">
								<Image src={v.poster} alt="" w="100%" h="100%" objectFit="cover" loading="lazy" />
								<Box position="absolute" bottom="2" right="2" px="1.5" py="0.5" borderRadius="sm" bg="rgba(0,0,0,0.7)">
									<Text fontSize="10px" color="white">{v.minutes} min</Text>
								</Box>
							</Box>
							<Box p="3">
								<Text fontSize="10px" fontFamily="mono" color="var(--text-3)" letterSpacing="0.04em">{v.code}</Text>
								<Text fontSize="13px" fontWeight="600" color="var(--text-0)" lineHeight="1.3" mt="0.5">{v.title}</Text>
							</Box>
						</Box>
					))}
				</Grid>

				{/* ── Apps ── */}
				<Text fontSize="22px" fontWeight="600" color="var(--text-0)" letterSpacing="-0.01em" mb="4">
					{t("appsTitle", { defaultValue: "Apps" })}
				</Text>
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
