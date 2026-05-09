import type { DeviceState } from './types';

interface KeepKeyDeviceProps {
	state?: DeviceState;
	/** Width in px. Height is derived (2:1 aspect, ~real KeepKey 2.2:1). */
	size?: number;
	/** Optional label rendered as DOM text inside the screen, scaled relative
	 *  to the device size. Use sparingly — short strings only ("CONFIRM",
	 *  "APPROVE", "READY"). The transaction details should live OUTSIDE the
	 *  device illustration in the surrounding layout. */
	signingLabel?: string;
	/** Mono sub-line under the signing label. Same caveat — keep short. */
	signingDetail?: string;
}

/** Horizontal-rectangle KeepKey illustration with idle / active / signing /
 *  success states. Side button protrudes from the top-right. The screen fills
 *  the entire face.
 *
 *  Text overlays are rendered as DOM (not <text> inside the SVG) because some
 *  WebView engines render svg text fontSize as CSS pixels rather than scaling
 *  with viewBox, which makes "CONFIRM" overflow the device frame. DOM text
 *  scales reliably from a single fontSize derived from the device width. */
export function KeepKeyDevice({
	state = 'idle',
	size = 32,
	signingLabel = 'CONFIRM',
	signingDetail,
}: KeepKeyDeviceProps) {
	const palette: Record<DeviceState, { stroke: string; glow: string; text: string }> = {
		idle:    { stroke: 'var(--text-2)',  glow: 'transparent',                text: 'var(--text-3)' },
		active:  { stroke: 'var(--teal)',    glow: 'rgba(139,227,196,0.3)',     text: 'var(--teal)' },
		signing: { stroke: 'var(--gold)',    glow: 'rgba(233,196,106,0.45)',    text: 'var(--gold)' },
		success: { stroke: 'var(--teal-2)',  glow: 'rgba(168,239,210,0.4)',     text: 'var(--teal-2)' },
	};
	const c = palette[state];
	const w = size;
	const h = size * 0.5;

	// DOM text inside the screen — scales with device size so a 32px device
	// gets ~3px text and a 200px device gets ~18px text.
	const labelSize  = Math.max(8, size * 0.085);
	const detailSize = Math.max(7, size * 0.060);

	return (
		<div
			style={{
				width: w,
				height: h,
				position: 'relative',
				filter: state !== 'idle' ? `drop-shadow(0 0 ${size * 0.08}px ${c.glow})` : 'none',
				transition: 'filter 0.4s ease',
			}}
		>
			<svg viewBox="0 0 90 40" width={w} height={h} fill="none" overflow="visible" style={{ position: 'absolute', inset: 0 }}>
				{/* Side button on the top edge */}
				<rect x="68" y="-2.5" width="10" height="3.5" rx="1.2"
					fill="var(--ink-3)" stroke={c.stroke} strokeWidth="0.8"/>
				{/* Body */}
				<rect x="1.5" y="1.5" width="77" height="37" rx="3.5"
					stroke={c.stroke} strokeWidth="1.4"
					fill="var(--ink-2)" style={{ transition: 'stroke 0.4s' }}/>
				{/* Screen — full-face with thin bezel */}
				<rect x="4" y="4" width="72" height="32" rx="2"
					fill="var(--ink-0)" stroke={c.stroke} strokeWidth="0.6" opacity="0.9"/>
				{/* Brand dot bottom-right of bezel */}
				<circle cx="73" cy="35" r="0.7" fill={c.stroke} opacity="0.5"/>

				{state === 'active' && (
					<g>
						<circle cx="40" cy="20" r="3" stroke={c.stroke} strokeWidth="0.8" fill="none">
							<animate attributeName="r" values="2;4;2" dur="1.6s" repeatCount="indefinite"/>
							<animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite"/>
						</circle>
						<circle cx="40" cy="20" r="1.4" fill={c.stroke}/>
					</g>
				)}

				{state === 'signing' && (
					<>
						{/* progress bar at the bottom of the screen */}
						<rect x="14" y="29" width="52" height="2" rx="1" fill="var(--ink-3)"/>
						<rect x="14" y="29" width="52" height="2" rx="1" fill={c.stroke}>
							<animate attributeName="width" values="0;52;0" dur="2s" repeatCount="indefinite"/>
						</rect>
						{/* button-press hint */}
						<rect x="68" y="-2.5" width="10" height="3.5" rx="1.2"
							fill={c.stroke} opacity="0.6">
							<animate attributeName="opacity" values="0.3;1;0.3"
								dur="1.2s" repeatCount="indefinite"/>
						</rect>
					</>
				)}

				{state === 'success' && (
					<path d="M30 22 L37 29 L52 13" stroke={c.stroke} strokeWidth="2.2"
						fill="none" strokeLinecap="round" strokeLinejoin="round">
						<animate attributeName="stroke-dasharray" from="0 60" to="60 0"
							dur="0.5s" fill="freeze"/>
					</path>
				)}
			</svg>

			{/* DOM text overlay positioned over the screen rect (4..76 of 90 in
			    viewBox space → ~4.4%..84% in CSS).
			    Skipped on idle / active / success — those have their own SVG
			    indicators (dot / pulsing target / check mark). */}
			{state === 'signing' && (
				<div
					style={{
						position: 'absolute',
						left:  `${(4 / 90) * 100}%`,
						right: `${(14 / 90) * 100}%`,
						top:   `${(4 / 40) * 100}%`,
						bottom: `${(11 / 40) * 100}%`, // leave room for progress bar
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						justifyContent: 'center',
						gap: Math.max(1, size * 0.012),
						pointerEvents: 'none',
						overflow: 'hidden',
					}}
				>
					<div
						style={{
							fontFamily: 'var(--font-sans)',
							fontWeight: 700,
							fontSize: `${labelSize}px`,
							letterSpacing: '0.08em',
							color: c.text,
							lineHeight: 1,
							whiteSpace: 'nowrap',
						}}
					>
						{signingLabel}
					</div>
					{signingDetail && (
						<div
							style={{
								fontFamily: 'var(--font-mono)',
								fontSize: `${detailSize}px`,
								letterSpacing: '0.04em',
								color: 'var(--text-2)',
								lineHeight: 1,
								whiteSpace: 'nowrap',
								maxWidth: '100%',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
							}}
						>
							{signingDetail}
						</div>
					)}
				</div>
			)}

			{/* "READY" label for active state */}
			{state === 'active' && (
				<div
					style={{
						position: 'absolute',
						left:  `${(4 / 90) * 100}%`,
						right: `${(14 / 90) * 100}%`,
						top:   `${(4 / 40) * 100}%`,
						height: `${(11 / 40) * 100}%`,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						pointerEvents: 'none',
					}}
				>
					<div
						style={{
							fontFamily: 'var(--font-sans)',
							fontWeight: 600,
							fontSize: `${labelSize}px`,
							letterSpacing: '0.12em',
							color: c.text,
							lineHeight: 1,
						}}
					>
						READY
					</div>
				</div>
			)}
		</div>
	);
}
