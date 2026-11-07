import { useUiTranslation } from "../i18n/ui"
/**
 * How the emulator's firmware build and wallet are named in the UI, and the
 * running EMU badge. Firmware and wallet are separate selections, so both are
 * shown wherever the emulator is started or running.
 */
import { useCallback, useEffect, useState } from "react"
import { Text, chakra } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { EmulatorBuildInfo, EmulatorNextBuild, EmulatorRunningBuild, EmulatorStatus } from "../../shared/types"

const BUILD_HASH_NAME = /^build-[0-9a-f]{16}$/

/** Names for emulator builds and wallets, in the UI language. */
export function useEmulatorNames() {
	const uiText = useUiTranslation()
	const buildTitle = useCallback((build: EmulatorRunningBuild | null | undefined) => {
		const version = build?.version ? `v${build.version}` : ""
		if (!build?.id) return version ? uiText("{{version}} · bundled emulator", { version }) : uiText("Bundled emulator")
		const what = build.label || uiText("build {{id}}", { id: build.id.slice(0, 12) })
		return version ? `${version} · ${what}` : uiText("Unverified {{what}}", { what })
	}, [uiText])
	/** The device label, or the name the user gave the seed. A build-hash file
	 *  name ("build-249bcff134356ee7") with no label is not a name. */
	const walletTitle = useCallback((wallet: { name: string; label?: string }) =>
		wallet.label?.trim() || (BUILD_HASH_NAME.test(wallet.name) ? uiText("Unnamed wallet") : wallet.name), [uiText])
	return { buildTitle, walletTitle }
}

/** The <option>s of every emulator firmware select: "" is the bundled emulator;
 *  a selected build that is not available (a research build while Monero is off)
 *  stays listed, marked, so the select never shows a build that isn't selected. */
export function EmulatorBuildOptions({ builds, next, showId }: { builds: EmulatorBuildInfo[]; next: EmulatorNextBuild | null; showId?: boolean }) {
	const uiText = useUiTranslation()
	const { buildTitle } = useEmulatorNames()
	const unavailable = next?.id && !builds.some((b) => b.id === next.id) ? next : null
	const label = (b: EmulatorRunningBuild) => `${buildTitle(b)}${showId && b.id && b.label ? ` · ${b.id.slice(0, 12)}` : ""}`
	return (
		<>
			<option value="">{buildTitle(next?.id === null ? next : { id: null })}</option>
			{builds.map((b) => <option key={b.id} value={b.id}>{label(b)}</option>)}
			{unavailable && <option value={unavailable.id!}>{uiText("{{firmware}} (unavailable)", { firmware: label(unavailable) })}</option>}
		</>
	)
}

/** The running EMU badge: which wallet on which firmware. Clicking it brings the emulator window forward. */
export function EmulatorBadgeView({ wallet, build, onShow, fontFamily }: {
	wallet?: { name: string; label?: string }
	build?: EmulatorRunningBuild
	onShow?: () => void
	fontFamily?: string
}) {
	const uiText = useUiTranslation()
	const { buildTitle, walletTitle } = useEmulatorNames()
	const walletText = wallet ? walletTitle(wallet) : null
	const buildText = build ? buildTitle(build) : null
	const summary = walletText && buildText ? uiText("Emulator: {{wallet}} on {{firmware}}", { wallet: walletText, firmware: buildText }) : uiText("Emulator")
	return (
		<chakra.button type="button" onClick={onShow} disabled={!onShow}
			title={onShow ? uiText("{{summary}}. Click to show the emulator window.", { summary }) : summary}
			aria-label={onShow ? uiText("{{summary}}. Show the emulator window", { summary }) : summary}
			display="flex" alignItems="center" gap="1.5" minW="0" flexShrink={1} maxW="340px"
			bg="rgba(224,140,123,0.12)" px="1.5" py="0.5" borderRadius="sm" cursor={onShow ? "pointer" : "default"}
			_hover={onShow ? { bg: "rgba(224,140,123,0.22)" } : undefined}
			className="electrobun-webkit-app-region-no-drag" fontFamily={fontFamily}>
			<Text as="span" flexShrink={0} fontSize="9px" color="var(--rose)" fontWeight="600" textTransform="uppercase" letterSpacing="0.08em">EMU</Text>
			{walletText && <Text as="span" fontSize="9.5px" color="var(--text-1)" truncate data-testid="emu-badge-wallet">{walletText}</Text>}
			{buildText && <Text as="span" fontSize="9.5px" color="var(--text-3)" truncate data-testid="emu-badge-build">{buildText}</Text>}
		</chakra.button>
	)
}

/** Reads what the emulator is running; refreshes when `refreshKey` changes (device label, firmware). */
export function EmulatorBadge({ refreshKey, fontFamily }: { refreshKey?: string; fontFamily?: string }) {
	const [status, setStatus] = useState<EmulatorStatus | null>(null)
	useEffect(() => {
		let live = true
		rpcRequest<EmulatorStatus>("emulatorStatus", undefined, 5000).then(s => { if (live) setStatus(s) }).catch(() => {})
		return () => { live = false }
	}, [refreshKey])
	const show = useCallback(() => {
		rpcRequest("emulatorShowWindow", undefined, 10000).catch((e: any) => console.warn("emulatorShowWindow:", e?.message))
	}, [])
	return <EmulatorBadgeView wallet={status?.wallet} build={status?.build} onShow={status?.state === "running" ? show : undefined} fontFamily={fontFamily} />
}
