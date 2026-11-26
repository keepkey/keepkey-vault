import { useUiTranslation } from "../../i18n/ui"
import { useEffect, useState } from "react"
import { Z } from "../../lib/z-index"
import { DocsLink } from "../DocsLink"
import { DOCS_LINKS, watch } from "../../../shared/docs-links"
import type { PairingRequestInfo } from "../../../shared/types"
import { Beam, PreflightList, PreflightStyles, usePreflightScroll, usePreflightShort, type PreflightRow } from "../preflight/PreflightConsole"
import { OledText, SpinningDevice } from "../v3"
import { pairingOrigin } from "../../../shared/pairing-origin"

/** The product name: not translated. */
const KEEPKEY = "KeepKey"

interface PairingApprovalProps {
	request: PairingRequestInfo
	onApprove: () => void
	onReject: () => void
}

/** A neutral app glyph: no disc, no letter. */
function AppGlyph() {
	return (
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 8.5h17" /><path d="M7 6.5h.01M9.5 6.5h.01" />
		</svg>
	)
}

/** P1 "Pairing": connect an app, on the preflight console. */
export function PairingApproval({ request, onApprove, onReject }: PairingApprovalProps) {
	const uiText = useUiTranslation()
	const short = usePreflightShort()
	const leftScroll = usePreflightScroll<HTMLDivElement>()
	const rightScroll = usePreflightScroll<HTMLDivElement>()
	const [imgError, setImgError] = useState(false)
	const icon = !!request.imageUrl && !imgError && /^(https?:|data:image\/)/i.test(request.imageUrl) ? request.imageUrl : null
	const origin = pairingOrigin(request.url)
	const name = (request.name || '').trim() || uiText("An app")

	// Keyboard: Enter connects, Escape declines.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); onApprove() }
			if (e.key === "Escape") { e.preventDefault(); onReject() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [onApprove, onReject])

	// One status mark per row, most severe first (PreflightList sorts).
	const rows: PreflightRow[] = [
		{ key: 'keys', status: 'ok', title: uiText("No keys are shared"), detail: uiText("Your recovery phrase never leaves the KeepKey.") },
		{ key: 'see', status: 'warn', title: uiText("Can see your addresses and balances"), detail: uiText("On the networks you enabled, without asking again.") },
		{ key: 'sign', status: 'ok', title: uiText("Every signature still goes through your KeepKey"), detail: uiText("You review each one here and confirm it on the device.") },
		{ key: 'off', status: 'ok', title: uiText("You can disconnect it"), detail: uiText("Settings → Paired Apps.") },
	]
	if (origin.kind === 'extension') rows.push({ key: 'origin', status: 'warn', attrs: { 'data-pairing-origin': 'extension' },
		title: uiText("KeepKey Vault can’t verify this extension"),
		detail: uiText("The name and icon come from the extension itself. Connect only if you just asked {{app}} to connect.", { app: name }) })
	else if (origin.kind === 'none') rows.push({ key: 'origin', status: 'warn', attrs: { 'data-pairing-origin': 'none' },
		title: uiText("No address given"),
		detail: uiText("The app did not say where it runs. Connect only if you just asked {{app}} to connect.", { app: name }) })

	return (
		<div data-pairing-overlay style={{ position: 'fixed', inset: 0, zIndex: Z.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
			background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
			<PreflightStyles />
			<div className="kk-pf kk-pf-sg" role="dialog" aria-modal="true" aria-label={uiText("Connect an app")} style={{ width: 'min(900px, 94vw)' }}>
				{/* ── Left: who asks, what it means, the KeepKey it reaches ── */}
				<div className="kk-pf-left kk-pf-scroll" ref={leftScroll}>
					<div className="kk-pf-kicker">{uiText("Connect an app")}</div>
					<div className="kk-pf-vers kk-pf-who" aria-label={uiText("From {{from}} to {{to}}", { from: name, to: KEEPKEY })}>
						<span className="kk-pf-app" style={{ fontSize: 15, color: 'var(--text-0)', fontWeight: 600 }}>
							{icon
								? <img src={icon} alt="" width={28} height={28} style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'contain', flex: 'none' }} onError={() => setImgError(true)} />
								: <span style={{ color: 'var(--text-1)', display: 'inline-grid', flex: 'none' }}><AppGlyph /></span>}
							<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-pairing-name>{name}</span>
						</span>
						<Beam />
						<span className="kk-pf-acct" style={{ fontSize: 22 }}><span>{KEEPKEY}</span></span>
					</div>
					<p className="kk-pf-lede">
						{uiText("{{app}} wants to see your addresses and ask you to sign. Every signature still needs your KeepKey.", { app: name })}
					</p>
					<div style={{ display: 'grid', gap: 10, justifyItems: 'start' }}>
						<SpinningDevice motion="still" scale={short ? 0.66 : 0.8} label={KEEPKEY} screen={<OledText kicker="KEEPKEY" headline={uiText("Ready")} />} />
						<span className="kk-pf-cap" style={{ maxWidth: 'none' }}>{uiText("Nothing to confirm on the device to connect. Its signatures still need it.")}</span>
					</div>
					<div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
						<DocsLink href={DOCS_LINKS.settingsPairing} />
						<DocsLink href={watch('course-11-app-connections')} label={uiText("Watch video")} />
					</div>
				</div>

				{/* ── Right: what it can and cannot do, right above the decision ── */}
				<div className="kk-pf-right kk-pf-split">
					<div className="kk-pf-body kk-pf-scroll" ref={rightScroll}>
						<PreflightList rows={rows} />
						<details className="kk-pf-tech" data-pairing-tech>
							<summary>{uiText("Technical details")}</summary>
							<dl className="kk-pf-facts" style={{ marginTop: 8 }}>
								<div><dt>{uiText("Name sent by the app")}</dt><dd>{request.name || '—'}</dd></div>
								<div><dt>{uiText("Address sent by the app")}</dt><dd data-pairing-url>{request.url || '—'}</dd></div>
								{origin.extensionId && <div><dt>{uiText("Extension ID")}</dt><dd>{origin.extensionId}</dd></div>}
								{request.imageUrl && <div><dt>{uiText("Icon")}</dt><dd>{request.imageUrl}</dd></div>}
							</dl>
							<p className="kk-pf-note" style={{ marginTop: 8 }}>{uiText("These come from the app's request. KeepKey Vault doesn’t verify these.")}</p>
						</details>
					</div>
					<div className="kk-pf-foot">
						<div className="kk-pf-actions">
							<button type="button" className="kk-pf-cancel" onClick={onReject}>{uiText("Decline")}</button>
							<button type="button" className="kk-pf-go" onClick={onApprove}>{uiText("Connect app")}</button>
						</div>
						<div className="kk-pf-hint">{uiText("Enter to connect · Esc to decline")}</div>
					</div>
				</div>
			</div>
		</div>
	)
}
