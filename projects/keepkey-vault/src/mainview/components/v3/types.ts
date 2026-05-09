/* Narrow prop types for v3 primitives. Decoupled from existing app types
   on purpose — callers adapt their own data into these shapes when threading
   the new components in. */

export type DeviceState = 'idle' | 'active' | 'signing' | 'success';

export interface TokenLike {
	sym: string;
	name?: string;
	network?: string;
	color: string;
	glyph?: string;
	logo?: string | null;
	chain?: string;
	addr?: string;
}

export interface NetworkLike {
	name: string;
	color: string;
	logo?: string | null;
	chain?: string;
	sym: string;
	glyph?: string;
	native?: { amount: number } | null;
	tokens: Array<{ sym: string; usd: number }>;
	usd: number;
}

export type IconName =
	| 'arrowDown' | 'arrowUp' | 'swap' | 'back' | 'close' | 'plus'
	| 'copy' | 'eye' | 'eyeOff' | 'refresh' | 'edit' | 'shield'
	| 'gear' | 'apps' | 'external' | 'check' | 'clock' | 'bolt'
	| 'arrowRight' | 'chevronDown' | 'sparkle' | 'device';
