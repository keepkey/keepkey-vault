import type { DeviceState } from './types';

interface KeepKeyDeviceProps {
	state?: DeviceState;
	/** Width in px. Height is derived (2:1 aspect, ~real KeepKey 2.2:1). */
	size?: number;
	/** Override the screen content for non-swap variants (send/sign-message/verify-address). */
	signingLabel?: string;
	signingDetail?: string;
}

/** Horizontal-rectangle KeepKey illustration with idle / active / signing /
 *  success states. Side button protrudes from the top-right. The screen fills
 *  the entire face — driven by the new study language. */
export function KeepKeyDevice({
	state = 'idle',
	size = 32,
	signingLabel = 'CONFIRM',
	signingDetail = 'SWAP',
}: KeepKeyDeviceProps) {
	const palette: Record<DeviceState, { stroke: string; glow: string }> = {
		idle:    { stroke: 'var(--text-2)',  glow: 'transparent' },
		active:  { stroke: 'var(--teal)',    glow: 'rgba(139,227,196,0.3)' },
		signing: { stroke: 'var(--gold)',    glow: 'rgba(233,196,106,0.45)' },
		success: { stroke: 'var(--teal-2)',  glow: 'rgba(168,239,210,0.4)' },
	};
	const c = palette[state];
	const w = size;
	const h = size * 0.5;

	return (
		<div
			style={{
				width: w,
				height: h,
				position: 'relative',
				filter: state !== 'idle' ? `drop-shadow(0 0 10px ${c.glow})` : 'none',
				transition: 'filter 0.4s ease',
			}}
		>
			<svg viewBox="0 0 90 40" width={w} height={h} fill="none" overflow="visible">
				{/* Side button protruding from top-right edge */}
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

				{state === 'idle' && (
					<text x="40" y="22" fill="var(--text-2)" fontSize="4"
						fontFamily="Geist Mono" textAnchor="middle">●</text>
				)}
				{state === 'active' && (
					<g>
						<text x="40" y="16" fill={c.stroke} fontSize="4"
							fontFamily="Space Grotesk" fontWeight="600" textAnchor="middle"
							letterSpacing="0.6">READY</text>
						<circle cx="40" cy="25" r="3" stroke={c.stroke} strokeWidth="0.8" fill="none">
							<animate attributeName="r" values="2;4;2" dur="1.6s" repeatCount="indefinite"/>
							<animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite"/>
						</circle>
						<circle cx="40" cy="25" r="1.4" fill={c.stroke}/>
					</g>
				)}
				{state === 'signing' && (
					<g>
						<text x="40" y="13" fill={c.stroke} fontSize="3.8"
							fontFamily="Space Grotesk" textAnchor="middle" fontWeight="700"
							letterSpacing="0.7">{signingLabel}</text>
						<text x="40" y="19" fill="var(--text-2)" fontSize="3"
							fontFamily="Geist Mono" textAnchor="middle">{signingDetail}</text>
						<rect x="14" y="23" width="52" height="2" rx="1" fill="var(--ink-3)"/>
						<rect x="14" y="23" width="52" height="2" rx="1" fill={c.stroke}>
							<animate attributeName="width" values="0;52;0" dur="2s" repeatCount="indefinite"/>
						</rect>
						<text x="40" y="31" fill="var(--text-3)" fontSize="2.7"
							fontFamily="Geist Mono" textAnchor="middle">▶ press button</text>
					</g>
				)}
				{state === 'success' && (
					<g>
						<path d="M30 22 L37 29 L52 13" stroke={c.stroke} strokeWidth="2.2"
							fill="none" strokeLinecap="round" strokeLinejoin="round">
							<animate attributeName="stroke-dasharray" from="0 60" to="60 0"
								dur="0.5s" fill="freeze"/>
						</path>
					</g>
				)}

				{state === 'signing' && (
					<rect x="68" y="-2.5" width="10" height="3.5" rx="1.2"
						fill={c.stroke} opacity="0.6">
						<animate attributeName="opacity" values="0.3;1;0.3"
							dur="1.2s" repeatCount="indefinite"/>
					</rect>
				)}
			</svg>
		</div>
	);
}
