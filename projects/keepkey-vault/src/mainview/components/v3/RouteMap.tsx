/**
 * Animated route visualization for the swap Confirm screen.
 *
 * Shows the from-token, the integration that's actually executing the swap
 * (THORChain / Mayachain / Relay / 0x / ChainFlip / ShapeShift / Bebop /
 * etc.), and the to-token, connected by a soft gradient curve. A gold dot
 * travels along the path on a 2.4s loop to read as "your value moves
 * through this routing layer."
 *
 * The integration node label is dynamic: the dialog passes the resolved
 * integration name (or the swapper when it's a single-route quote). We
 * pull a 1-3 letter glyph from the integration's display name so the
 * center node always has a readable mark even for long names.
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
	/* Multi-word: take first letter of each word, max 3 letters. */
	const words = cleaned.split(/[\s\-_/]+/).filter(Boolean);
	if (words.length > 1) return words.slice(0, 3).map(w => w[0]).join("");
	/* Long single word: first 3 letters. */
	return cleaned.slice(0, 3);
}

export function RouteMap({ from, to, integration, animate = true, caption }: RouteMapProps) {
	const path = "M 50 40 Q 200 10 300 40 T 550 40";
	const glyph = integrationGlyph(integration);

	return (
		<div style={{ width: "100%" }}>
			<svg width="100%" height="80" viewBox="0 0 600 80" style={{ display: "block" }}>
				<defs>
					<linearGradient id="routeMapLine" x1="0" x2="1">
						<stop offset="0%" stopColor={from.color || "var(--text-3)"} />
						<stop offset="100%" stopColor={to.color || "var(--text-3)"} />
					</linearGradient>
				</defs>

				{/* Dashed background line — gives the curve a subtle "track" feel */}
				<path d={path} stroke="var(--ink-4)" strokeWidth="2" fill="none" strokeDasharray="3 4" />

				{/* Solid color gradient line — the "real" route */}
				<path d={path} stroke="url(#routeMapLine)" strokeWidth="2" fill="none" opacity="0.7" />

				{/* From-token node (left) */}
				<circle cx="50" cy="40" r="15" fill="var(--ink-2)" stroke="var(--ink-4)" strokeWidth="1" />
				{from.iconUrl ? (
					<image href={from.iconUrl} x="36" y="26" width="28" height="28" clipPath="circle(14px at 14px 14px)" />
				) : (
					<>
						<circle cx="50" cy="40" r="14" fill={from.color || "var(--ink-3)"} />
						<text x="50" y="44" fill="white" fontSize="10" textAnchor="middle" fontWeight="600">{from.glyph || "?"}</text>
					</>
				)}

				{/* Integration node (center) — gold ring + glyph */}
				<circle cx="300" cy="40" r="11" fill="var(--ink-3)" stroke="var(--gold)" strokeWidth="1.5" />
				<text
					x="300"
					y="43"
					fill="var(--gold)"
					fontSize="9"
					textAnchor="middle"
					fontWeight="700"
					fontFamily="var(--font-sans)"
				>
					{glyph}
				</text>
				{integration && (
					<text
						x="300"
						y="68"
						fill="var(--text-3)"
						fontSize="9"
						textAnchor="middle"
						fontFamily="var(--font-mono)"
						letterSpacing="0.06em"
					>
						{integration.toUpperCase()}
					</text>
				)}

				{/* To-token node (right) */}
				<circle cx="550" cy="40" r="15" fill="var(--ink-2)" stroke="var(--ink-4)" strokeWidth="1" />
				{to.iconUrl ? (
					<image href={to.iconUrl} x="536" y="26" width="28" height="28" clipPath="circle(14px at 14px 14px)" />
				) : (
					<>
						<circle cx="550" cy="40" r="14" fill={to.color || "var(--ink-3)"} />
						<text x="550" y="44" fill="white" fontSize="10" textAnchor="middle" fontWeight="600">{to.glyph || "?"}</text>
					</>
				)}

				{/* Animated traveling dot — gold, 2.4s loop, follows the curve */}
				{animate && (
					<circle r="4" fill="var(--gold)">
						<animateMotion dur="2.4s" repeatCount="indefinite" path={path} />
					</circle>
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
