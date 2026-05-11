import type { DeviceState } from './types';
import kkGif from '../../assets/swap/kk.gif';

interface KeepKeyDeviceProps {
	state?: DeviceState;
	/** Width in px. Height is derived from the gif's native 16:9 aspect. */
	size?: number;
	/** Legacy props — preserved for API compat. The real device gif renders
	 *  its own screen contents, so these labels are now ignored when the gif
	 *  is shown (idle/success keep the abstract SVG). The surrounding layout
	 *  is responsible for showing the human-readable label adjacent to the
	 *  device illustration. */
	signingLabel?: string;
	signingDetail?: string;
}

/* Native gif aspect (240×135 source). */
const GIF_ASPECT = 240 / 135;

/** KeepKey device illustration with two render modes:
 *  - For interactive states (`signing`, `active`) we render the real device
 *    gif — finger-press animation included — wrapped in a state-tinted glow.
 *  - For abstract states (`idle`, `success`) we keep the SVG illustration
 *    so an icon-sized presence still works in non-interactive layouts.
 */
export function KeepKeyDevice({
	state = 'idle',
	size = 32,
}: KeepKeyDeviceProps) {
	const isInteractive = state === 'signing' || state === 'active';

	if (isInteractive) {
		const w = size;
		const h = Math.round(size / GIF_ASPECT);
		const glowColor = state === 'signing'
			? 'rgba(233,196,106,0.45)'
			: 'rgba(139,227,196,0.35)';
		const ringColor = state === 'signing'
			? 'rgba(233,196,106,0.35)'
			: 'rgba(139,227,196,0.30)';

		return (
			<div
				style={{
					width: w,
					height: h,
					position: 'relative',
					borderRadius: 12,
					overflow: 'hidden',
					boxShadow:
						`0 0 ${size * 0.25}px ${glowColor}, ` +
						`inset 0 0 0 1px ${ringColor}`,
					background: 'var(--ink-1)',
					transition: 'box-shadow 0.4s ease',
				}}
			>
				<img
					src={kkGif}
					alt="KeepKey device"
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						display: 'block',
					}}
				/>
			</div>
		);
	}

	/* Abstract SVG for idle / success — kept compact, no inner text overlays. */
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
				filter: state !== 'idle' ? `drop-shadow(0 0 ${size * 0.08}px ${c.glow})` : 'none',
				transition: 'filter 0.4s ease',
			}}
		>
			<svg viewBox="0 0 90 40" width={w} height={h} fill="none" overflow="visible" style={{ position: 'absolute', inset: 0 }}>
				<rect x="68" y="-2.5" width="10" height="3.5" rx="1.2"
					fill="var(--ink-3)" stroke={c.stroke} strokeWidth="0.8"/>
				<rect x="1.5" y="1.5" width="77" height="37" rx="3.5"
					stroke={c.stroke} strokeWidth="1.4"
					fill="var(--ink-2)" style={{ transition: 'stroke 0.4s' }}/>
				<rect x="4" y="4" width="72" height="32" rx="2"
					fill="var(--ink-0)" stroke={c.stroke} strokeWidth="0.6" opacity="0.9"/>
				<circle cx="73" cy="35" r="0.7" fill={c.stroke} opacity="0.5"/>

				{state === 'success' && (
					<path d="M30 22 L37 29 L52 13" stroke={c.stroke} strokeWidth="2.2"
						fill="none" strokeLinecap="round" strokeLinejoin="round">
						<animate attributeName="stroke-dasharray" from="0 60" to="60 0"
							dur="0.5s" fill="freeze"/>
					</path>
				)}
			</svg>
		</div>
	);
}
