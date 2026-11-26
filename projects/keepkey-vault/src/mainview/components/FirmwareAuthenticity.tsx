import { useUiTranslation } from "../i18n/ui"
/**
 * First screen of the setup wizard — before the tutorial cards, before
 * anything is written to the device: is this a genuine KeepKey?
 *
 * THE CLAIM THIS SCREEN MAKES, AND THE ONE IT DOES NOT. The device reports
 * SHA-256(meta_descriptor + app_code), which equals the full-file hash of the
 * released .bin and, because the meta descriptor covers the signature slots,
 * pins the exact signed artifact. It also reports its bootloader hash. We look
 * both up in release tables shipped with this app.
 *
 * That is corroboration, not proof: the device self-reports the hashes. What
 * actually refuses to run unsigned firmware silently is the bootloader's
 * signature check, on the device, at every power-on. The headline is earned
 * by a release match; the "How this is checked" panel keeps the limits and
 * the commands to check it yourself one click away.
 *
 * A brand-new device runs factory firmware too old to report a hash. Its
 * bootloader still reports one, so a known bootloader is enough to say
 * "genuine" — the factory firmware is replaced in the next step anyway.
 */
import { useState } from "react"
import { Box } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { authenticityVerdict } from "../../shared/firmware-authenticity"
import { PreflightList, PreflightStyles, type PreflightRow } from "./preflight/PreflightConsole"
import { OledText, SpinningDevice } from "./v3"

function openUrl(url: string) {
	// target="_blank" is a dead click in Electrobun.
	rpcRequest("openUrl", { url }).catch(() => {})
}

/** Hash as a hairline key/value row: truncated, with a Copy button. */
function HashRow({ label, value }: { label: string; value: string }) {
	const uiText = useUiTranslation()
	const [copied, setCopied] = useState(false)
	const copy = () => {
		navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
	}
	return (
		<div>
			<dt>{label}</dt>
			<dd title={value}>{value.slice(0, 12)}…{value.slice(-8)}</dd>
			<button type="button" className="kk-pf-copy" onClick={copy}>{copied ? uiText("Copied") : uiText("Copy")}</button>
		</div>
	)
}

export function FirmwareAuthenticity({	firmwareHash,
	firmwareRelease,
	firmwareVerified,
	bootloaderHash,
	bootloaderVerified,
	bootloaderRelease,
	firmwareSignaturesVerified,
	installFirmware,
	installBootloader,
	onContinue,
	onInstallOfficialFirmware,
	continueDisabled,
	holdsWallet,
}: {
	firmwareHash?: string
	firmwareRelease?: string
	firmwareVerified?: boolean
	bootloaderHash?: string
	bootloaderVerified?: boolean
	bootloaderRelease?: string
	firmwareSignaturesVerified?: boolean
	installFirmware?: { version: string; signed: boolean }
	installBootloader?: { version: string; signed: boolean }
	onContinue: () => void
	onInstallOfficialFirmware?: () => void
	continueDisabled?: boolean
	/** A returning owner's KeepKey: this screen must not read as new-device setup. */
	holdsWallet?: boolean
}) {
  const uiText = useUiTranslation()

	const verdict = authenticityVerdict(firmwareHash, firmwareVerified, bootloaderVerified)
	const passed = verdict === "verified" || verdict === "genuine"
	const showOfficialInstall = verdict === "unrecognized" && !!onInstallOfficialFirmware

	const headline = passed
		? "Genuine KeepKey"
		: verdict === "unrecognized" ? "Firmware not in the release list" : "This KeepKey's firmware is too old to check here"

	const subline = verdict === "verified"
		? firmwareSignaturesVerified
			? `Firmware${firmwareRelease ? ` ${firmwareRelease}` : ""} is signed by KeepKey. Desktop verified its release signatures.`
			: `Firmware${firmwareRelease ? ` ${firmwareRelease}` : ""} matches an official KeepKey release.`
		: verdict === "genuine"
			? `Its bootloader${bootloaderRelease ? ` ${bootloaderRelease}` : ""} matches an official KeepKey release.`
			: verdict === "unrecognized"
				? "This may be a custom, Bitcoin-only, or modified build. Compare its hash with the build you expected, and confirm the device showed no warning at startup."
				// Support ticket 2026-10-01: a returning owner read "can't be checked" as
				// "my wallet is about to be wiped" and stopped. Say what is and isn't changed.
				: "Older firmware can't report its fingerprint. Your wallet on the device is not changed by this screen. Next, Desktop updates the firmware (you'll confirm on the device), and then it can be checked."

	const unlisted = verdict === "unrecognized"
	const release = firmwareRelease?.replace(/^v/, "")
	const title = verdict === "verified" ? uiText("Official firmware {{version}}", { version: release || "" }).trim()
		: unlisted ? uiText("Unlisted firmware") : headline

	// Every check the old screen made is still a row; one status mark each.
	const rows: PreflightRow[] = []
	if (bootloaderVerified === true) {
		rows.push({ key: "bl", status: "ok", title: uiText("Official bootloader {{version}} · checked by Desktop", { version: bootloaderRelease || "" }) })
	} else if (bootloaderVerified === false) {
		rows.push({ key: "bl", status: "warn", title: uiText("Bootloader not in the release list"),
			detail: "Not in the release list. Compare its hash with the bootloader you expected." })
	}
	if (verdict === "verified") {
		rows.push({ key: "fw", status: "ok", title: firmwareSignaturesVerified ? "Firmware signed by KeepKey" : "Firmware",
			detail: firmwareSignaturesVerified
				? `${firmwareRelease ? `Release ${firmwareRelease} carries` : "Carries"} three valid KeepKey release signatures.`
				: `Official KeepKey release${firmwareRelease ? ` ${firmwareRelease}` : ""}.` })
	} else if (verdict === "genuine") {
		// The factory firmware reports nothing to check, but what Desktop is about
		// to install is in hand: its release signatures are verified right here.
		const signedInstalls = [
			installFirmware?.signed && `firmware ${installFirmware.version}`,
			installBootloader?.signed && `bootloader ${installBootloader.version}`,
		].filter(Boolean) as string[]
		rows.push(signedInstalls.length
			? { key: "fw", status: "ok", title: "Update signed by KeepKey",
				detail: `Next, Desktop installs ${signedInstalls.join(" and ")}. Their KeepKey release signatures verified.` }
			: { key: "fw", status: "ok", title: "Firmware",
				detail: "Your KeepKey ships with factory firmware. Desktop installs the latest official firmware next." })
	} else if (unlisted) {
		rows.push({ key: "fw", status: "warn", title: uiText("Not in KeepKey's release list"), detail: uiText("Compare its hash with the build you expected.") })
	}
	rows.push({ key: "sig", status: passed ? "ok" : "warn", title: uiText("Signature check runs on the device"),
		detail: uiText("Your KeepKey warns at startup if the firmware isn't signed by KeepKey.") })
	if (passed && !holdsWallet) {
		rows.push({ key: "phrase", status: "ok", title: "Recovery phrase",
			detail: "Created on your KeepKey and shown only on its screen. It never leaves the device." })
	}

	const continueLabel = unlisted ? uiText("Continue with this build") : verdict === "unreported" ? uiText("Continue to update") : passed && !holdsWallet ? uiText("Set up my KeepKey") : uiText("Continue")
	const bootloaderLabel = `Bootloader${bootloaderVerified === true ? ` · official${bootloaderRelease ? ` ${bootloaderRelease}` : ""}` : bootloaderVerified === false ? " · unrecognized" : ""}`

	return (
		<div className="kk-pf kk-pf-flat" role="group" aria-label={title} style={{ width: "100%" }}>
			<PreflightStyles />
			{/* ── Left: verdict, what the device shows, checklist, decision ── */}
			<div className="kk-pf-left">
				<div className="kk-pf-kicker">{uiText("Check your firmware")}</div>
				<div>
					<h2 className="kk-pf-title">{title}</h2>
					<p className="kk-pf-sub">{unlisted ? uiText("A custom, Bitcoin-only or test build") : subline}</p>
				</div>
				{/* The user compares this with what the device showed: it stays still. */}
				{unlisted ? (
					<div className="kk-pf-device">
						<SpinningDevice motion="still" scale={0.66} screen={<OledText kicker="UNOFFICIAL FIRMWARE" headline={firmwareHash ? firmwareHash.slice(0, 8) : undefined} />} />
						<div className="kk-pf-cap">{uiText("Did your KeepKey show this at startup?")}</div>
					</div>
				) : verdict !== "unreported" && (
					<div className="kk-pf-device">
						<SpinningDevice motion="still" scale={0.66} screen={<OledText kicker="KEEPKEY" headline={firmwareRelease || (bootloaderRelease ? `bootloader ${bootloaderRelease}` : undefined)} />} />
						<div className="kk-pf-cap">{uiText("No warning at startup")}</div>
					</div>
				)}
				<PreflightList rows={rows} />
				<div className="kk-pf-actions kk-pf-wrap">
					{showOfficialInstall && (
						<button type="button" className="kk-pf-go" disabled={continueDisabled} onClick={onInstallOfficialFirmware}>{uiText("Install official firmware")}</button>
					)}
					<button type="button" className={showOfficialInstall ? "kk-pf-outline" : "kk-pf-go"} disabled={continueDisabled} onClick={onContinue}>{continueLabel}</button>
				</div>
			</div>

			{/* ── Right: how it is checked, hashes, the do-it-yourself path ── */}
			<div className="kk-pf-right">
				<h3 className="kk-pf-h">{uiText("How this is checked")}</h3>
				{/* Said once, here; the full limits sentence is kept word for word. */}
				<p className="kk-pf-lede" style={{ fontSize: 13.5 }}>
					{uiText("Your KeepKey reports the hashes of its bootloader and firmware. Desktop compares them with KeepKey's published releases, using a list shipped with the app. This is a cross-check, not independent proof. The signature check that actually guards your device runs on the device itself.")}
				</p>
				{(firmwareHash || bootloaderHash) && (
					<dl className="kk-pf-kv">
						{firmwareHash && <HashRow label={uiText("Firmware · reported by device")} value={firmwareHash} />}
						{bootloaderHash && <HashRow label={bootloaderLabel} value={bootloaderHash} />}
					</dl>
				)}
				{verdict === "verified" && firmwareRelease && (
					<button type="button" className="kk-pf-link"
						onClick={() => openUrl(`https://github.com/keepkey/keepkey-firmware/releases/tag/${firmwareRelease.replace(/-bitcoin-only$/, "")}`)}>{uiText("Open the")}{" "}{firmwareRelease}{" "}{uiText("release")}</button>
				)}
				{/* The limits and the do-it-yourself path stay one click away. */}
				<details className="kk-pf-tech">
					<summary>{uiText("Technical details")}</summary>
					<Box display="flex" flexDirection="column" gap="3" mt="3" fontSize="12px" color="var(--text-1)" lineHeight="1.55">
						<Box display="flex" gap="4" flexWrap="wrap">
							<button type="button" className="kk-pf-link"
								onClick={() => openUrl("https://github.com/keepkey/keepkey-firmware#verifying-published-binaries")}>{uiText("How to reproduce the build")}</button>
						</Box>
						{/* Two commands, two links in the chain. Shipping only one of them is
						    how people end up comparing a payload hash to a device hash and
						    concluding their wallet is compromised. */}
						<Box>
							<Box fontFamily="var(--font-mono)" color="var(--text-0)">{uiText("sha256sum firmware.keepkey.bin")}</Box>
							<Box color="var(--text-2)" mb="2">{uiText("Run on the release binary. It must match the firmware hash shown here.")}</Box>
							<Box fontFamily="var(--font-mono)" color="var(--text-0)">{uiText("tail -c +257 firmware.keepkey.bin | sha256sum")}</Box>
							<Box color="var(--text-2)">{uiText("Run on the release and your own build to compare unsigned app code. This is")}{" "}<b>{uiText("not")}</b>{" "}{uiText("the device-reported hash.")}</Box>
						</Box>
					</Box>
				</details>
			</div>
		</div>
	)
}
