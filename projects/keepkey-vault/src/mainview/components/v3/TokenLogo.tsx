import { useState, type CSSProperties, type HTMLAttributes } from 'react';
import type { TokenLike } from './types';

interface TokenLogoProps extends HTMLAttributes<HTMLDivElement> {
	token: TokenLike;
	size?: number;
	/** Adds the brand-tinted ambient ring (used on featured / orbital tokens). */
	ring?: boolean;
}

/** Token logo with graceful fallback to a coloured gradient circle + glyph.
 *  Mirrors the study's TokenLogo: image is loaded into an ink-2 disc; on
 *  load failure it swaps to a brand-coloured gradient with the token's glyph. */
export function TokenLogo({ token, size = 40, ring = false, style, ...rest }: TokenLogoProps) {
	const [failed, setFailed] = useState(!token.logo);
	const ringStyle: CSSProperties = ring
		? { boxShadow: `0 0 0 1px var(--line), 0 6px 18px -8px ${token.color}` }
		: {};

	if (failed) {
		return (
			<div
				{...rest}
				style={{
					width: size,
					height: size,
					borderRadius: '50%',
					background: `linear-gradient(180deg, ${token.color}, color-mix(in oklab, ${token.color} 55%, black))`,
					display: 'grid',
					placeItems: 'center',
					color: 'white',
					fontWeight: 600,
					fontSize: size * 0.42,
					flexShrink: 0,
					...ringStyle,
					...style,
				}}
			>
				{token.glyph ?? token.sym.charAt(0)}
			</div>
		);
	}

	return (
		<div
			{...rest}
			style={{
				width: size,
				height: size,
				borderRadius: '50%',
				background: 'var(--ink-2)',
				overflow: 'hidden',
				display: 'grid',
				placeItems: 'center',
				flexShrink: 0,
				...ringStyle,
				...style,
			}}
		>
			<img
				src={token.logo ?? undefined}
				alt={token.sym}
				onError={() => setFailed(true)}
				style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
			/>
		</div>
	);
}
