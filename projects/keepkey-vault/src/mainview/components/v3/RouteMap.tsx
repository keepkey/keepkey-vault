/**
 * Animated route visualization for the swap Confirm screen.
 *
 * Shows the from-token, the integration that's actually executing the swap
 * (THORChain / Mayachain / Relay / 0x / ChainFlip / ShapeShift / Bebop /
 * etc.), and the to-token, connected by a soft gradient curve. A gold dot
 * travels along the path on a 2.4s loop to read as "your value moves
 * through this routing layer."
 *
 * The center node is a 128px branded animation (per-swapper GIF) when the
 * caller supplies `centerImageUrl`. We fall back to a small gold-ringed
 * glyph circle so unknown providers still render something readable.
 */
import type { ReactNode } from "react";

interface TokenSlot {
	iconUrl?: string;
	caip?: string;
	color?: string;
	glyph?: string;
}

interface RouteMapProps {
	from: TokenSlot;
	to: TokenSlot;
	/** Integration label (e.g. "THORChain", "Mayachain", "Relay", "0x",
	 *  "ChainFlip", "Bebop"). Falls back to "ROUTE" when unknown. */
	integration?: string;
	/** Branded animation for the center node — see swapper-animations.ts.
	 *  When omitted, a small glyph-ring fallback renders in its place. */
	centerImageUrl?: string;
	/** Disable the traveling dot animation (useful for static screenshots
	 *  / when the user reduces motion). Defaults to enabled. */
	animate?: boolean;
	/** Slot for an optional explanatory caption below the map. */
	caption?: ReactNode;
}

/* Pick a 1-3 letter glyph from an arbitrary integration name. */
function integrationGlyph(name?: string): string {
	if (!name) return "•";
	const cleaned = name.trim().toUpperCase();
	if (cleaned.length <= 3) return cleaned;
	const words = cleaned.split(/[\s\-_/]+/).filter(Boolean);
	if (words.length > 1) return words.slice(0, 3).map(w => w[0]).join("");
	return cleaned.slice(0, 3);
}

export function RouteMap({ from, to, integration, centerImageUrl, animate = true, caption }: RouteMapProps) {
	// 600x180 viewBox: from-token at (60, 90), centerpiece at (300, 90) sized
	// 128x128, to-token at (540, 90), label at y=174.
	const path = "M 60 90 Q 200 30 300 90 T 540 90";
	const glyph = integrationGlyph(integration);
	const centerSize = 128;
	const cx = 300;
	const cy = 90;
	const half = centerSize / 2;

	return (
		<div style={{ width: "100%" }}>
			<svg width="100%" height="180" viewBox="0 0 600 180" style={{ display: "block" }}>
				<defs>
					<linearGradient id="routeMapLine" x1="0" x2="1">
						<stop offset="0%" stopColor={from.color || "var(--text-3)"} />
						<stop offset="100%" stopColor={to.color || "var(--text-3)"} />
					</linearGradient>
					<clipPath id="routeMapCenterClip">
						<circle cx={cx} cy={cy} r={half} />
					</clipPath>
				</defs>

				{/* Dashed background line — gives the curve a subtle "track" feel */}
				<path d={path} stroke="var(--ink-4)" strokeWidth="2" fill="none" strokeDasharray="3 4" />

				{/* Solid color gradient line — the "real" route */}
				<path d={path} stroke="url(#routeMapLine)" strokeWidth="2" fill="none" opacity="0.7" />

				{/* From-token node (left) */}
				<circle cx="60" cy="90" r="22" fill="var(--ink-2)" stroke="var(--ink-4)" strokeWidth="1" />
				{from.iconUrl ? (
					<image href={from.iconUrl} x="40" y="70" width="40" height="40" clipPath="circle(20px at 20px 20px)" />
				) : (
					<>
						<circle cx="60" cy="90" r="20" fill={from.color || "var(--ink-3)"} />
						<text x="60" y="95" fill="white" fontSize="14" textAnchor="middle" fontWeight="600">{from.glyph || "?"}</text>
					</>
				)}

				{/* Animated traveling dot — drawn before the centerpiece so it visually
				    "enters" the swapper as it passes through the middle of the curve. */}
				{animate && (
					<circle r="5" fill="var(--gold)">
						<animateMotion dur="2.4s" repeatCount="indefinite" path={path} />
					</circle>
				)}

				{/* Centerpiece — branded swap animation when available, glyph ring otherwise.
				    Sized 128px so it reads as the hero of the route. */}
				{centerImageUrl ? (
					<>
						{/* Soft halo behind the centerpiece — picks up brand accent */}
						<circle cx={cx} cy={cy} r={half + 2} fill="var(--ink-2)" stroke="var(--gold)" strokeWidth="1" opacity="0.7" />
						<image
							href={centerImageUrl}
							x={cx - half}
							y={cy - half}
							width={centerSize}
							height={centerSize}
							clipPath="url(#routeMapCenterClip)"
							preserveAspectRatio="xMidYMid slice"
						/>
					</>
				) : (
					<>
						<circle cx={cx} cy={cy} r="22" fill="var(--ink-3)" stroke="var(--gold)" strokeWidth="1.5" />
						<text
							x={cx}
							y={cy + 5}
							fill="var(--gold)"
							fontSize="14"
							textAnchor="middle"
							fontWeight="700"
							fontFamily="var(--font-sans)"
						>
							{glyph}
						</text>
					</>
				)}

				{/* Integration label below the centerpiece */}
				{integration && (
					<text
						x={cx}
						y={cy + half + 18}
						fill="var(--text-3)"
						fontSize="11"
						textAnchor="middle"
						fontFamily="var(--font-mono)"
						letterSpacing="0.08em"
					>
						{integration.toUpperCase()}
					</text>
				)}

				{/* To-token node (right) */}
				<circle cx="540" cy="90" r="22" fill="var(--ink-2)" stroke="var(--ink-4)" strokeWidth="1" />
				{to.iconUrl ? (
					<image href={to.iconUrl} x="520" y="70" width="40" height="40" clipPath="circle(20px at 20px 20px)" />
				) : (
					<>
						<circle cx="540" cy="90" r="20" fill={to.color || "var(--ink-3)"} />
						<text x="540" y="95" fill="white" fontSize="14" textAnchor="middle" fontWeight="600">{to.glyph || "?"}</text>
					</>
				)}
			</svg>

			{caption && (
				<div style={{ marginTop: 6, textAlign: "center", fontSize: 10, color: "var(--text-3)", letterSpacing: "0.04em" }}>
					{caption}
				</div>
			)}
		</div>
	);
}
