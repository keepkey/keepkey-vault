import type { CSSProperties } from 'react';
import type { DeviceState } from './types';

interface LogoTileProps {
	src: string;
	alt?: string;
	state?: DeviceState;
	size?: number;
	style?: CSSProperties;
}

/** KeepKey logo tile used in the top nav. The shadow halo is driven by the
 *  current device state — gold during signing, teal while active, none idle. */
export function LogoTile({ src, alt = 'KeepKey', state = 'idle', size = 36, style }: LogoTileProps) {
	const glow =
		state === 'signing' ? '0 0 14px rgba(233,196,106,0.5)' :
		state === 'active'  ? '0 0 12px rgba(139,227,196,0.35)' :
		state === 'success' ? '0 0 14px rgba(168,239,210,0.45)' :
		'none';

	return (
		<div
			style={{
				width: size,
				height: size,
				borderRadius: 9,
				background: '#000',
				border: '1px solid var(--line-2)',
				overflow: 'hidden',
				boxShadow: glow,
				transition: 'box-shadow 0.4s',
				flexShrink: 0,
				...style,
			}}
		>
			<img
				src={src}
				alt={alt}
				style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
			/>
		</div>
	);
}
