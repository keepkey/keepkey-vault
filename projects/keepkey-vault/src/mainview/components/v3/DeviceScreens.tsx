/**
 * OLED screen contents for SpinningDevice's `screen` slot.
 *
 * The device shell already sets the OLED font, colour, pixel grid and gloss;
 * these only lay out what the KeepKey itself would show, in the style of the
 * Swap and dashboard-loading screens, with type a step larger so it stays
 * legible when the device is drawn small (scale ~0.66). Sizes are in
 * device-face pixels (the face is 380×158 before SpinningDevice's `scale`).
 *
 * Device text arrives as props: it mirrors firmware strings, which are not
 * translated on the device either.
 */
import type { ReactNode } from "react";

/** Kicker / headline / detail — the generic two-or-three line screen. */
export function OledText({ kicker, headline, sub }: { kicker?: ReactNode; headline?: ReactNode; sub?: ReactNode }) {
	return (
		<div style={{ width: "100%", minWidth: 0 }}>
			{kicker && <div style={{ fontSize: 17, opacity: 0.6, letterSpacing: 2, marginBottom: 8 }}>{kicker}</div>}
			{headline && (
				<div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{headline}
				</div>
			)}
			{sub && (
				<div style={{ fontSize: 17, opacity: 0.65, letterSpacing: 1, marginTop: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{sub}
				</div>
			)}
		</div>
	);
}

/** The scrambled PIN matrix: 3×3 digits, centred, as the firmware draws it. */
export function OledPin({ digits }: { digits: readonly number[] }) {
	return (
		<div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
			<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 44px)", rowGap: 2, fontSize: 30, fontWeight: 700, lineHeight: 1.25, textAlign: "center" }}>
				{digits.map((n, i) => <span key={i}>{n}</span>)}
			</div>
		</div>
	);
}

/** The recovery cipher: the alphabet scrambled into 2 rows of 13, mirroring
 *  firmware app_layout.h CIPHER_ROWS. The order here is illustrative; the
 *  device draws a new one for every word. */
export const CIPHER_COLS = 13;
export const CIPHER_ROWS = 2;
const SAMPLE_CIPHER = "QWFPGJLUYARSTDHNEIOZXCVBKM".split("");

export function OledCipher({ letters = SAMPLE_CIPHER }: { letters?: readonly string[] }) {
	return (
		<div style={{ display: "grid", gridTemplateColumns: `repeat(${CIPHER_COLS}, 1fr)`, rowGap: 14, width: "100%", fontSize: 22, fontWeight: 700, textAlign: "center" }}>
			{letters.map((l, i) => <span key={i}>{l}</span>)}
		</div>
	);
}
