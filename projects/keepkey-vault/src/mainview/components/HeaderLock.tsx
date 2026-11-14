import { useUiTranslation } from "../i18n/ui"

/** KeepKey auto-locked with the portfolio still on screen: a padlock in the
 * header status line, click to unlock. An unlock error turns it red and is its tooltip. */
export function HeaderLock({ unlocking, unlockError, onUnlock }: {
	unlocking: boolean; unlockError: string | null; onUnlock?: () => void
}) {
	const uiText = useUiTranslation()
	return (
		<button type="button" onClick={onUnlock} disabled={unlocking}
			style={{ all: "unset", cursor: "pointer", display: "inline-flex", color: unlockError ? "var(--red, #e5484d)" : "var(--gold)", opacity: unlocking ? 0.5 : 1 }}
			title={unlockError || uiText("KeepKey locked")} aria-label={uiText("KeepKey locked")}>
			<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
				<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
				<path d="M7 11V7a5 5 0 0 1 10 0v4" />
			</svg>
		</button>
	)
}
