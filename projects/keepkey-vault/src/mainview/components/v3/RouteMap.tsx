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
import { useEffect, useId, useState, type ReactNode } from "react";
import { AssetIcon } from "../AssetIcon";
import { getAssetIcon } from "../../../shared/assetLookup";

interface TokenSlot {
	iconUrl?: string;
	caip?: string;
	/** Native network asset for a token/network badge; identical CAIPs omit it. */
	chainCaip?: string;
	color?: string;
	glyph?: string;
}

interface RouteMapProps {
	from: TokenSlot;
	to: TokenSlot;
	/** Integration label (e.g. "THORChain", "Mayachain", "Relay", "0x",
	 *  "ChainFlip", "Bebop"). Falls back to "ROUTE" when unknown. */
	integration?: string;
	/** Hide the text when a neighboring provider badge already names it. */
	showIntegrationLabel?: boolean;
	/** Branded animation for the center node — see swapper-animations.ts.
	 *  When omitted, a small glyph-ring fallback renders in its place. */
	centerImageUrl?: string;
	/** A still of the same art, shown instead of the animation when the user
	 *  asks for reduced motion (the animation never enters the DOM then). */
	centerStillUrl?: string;
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

function RouteToken({ slot, x }: { slot: TokenSlot; x: number }) {
	const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
	// The official logo: the asset's own URL, else the one its CAIP resolves to.
	const source = slot.iconUrl || (slot.caip ? getAssetIcon(slot.caip) : undefined);
	const image = source && !failedImages.has(source) ? source : undefined;
	// The official logo alone, no disc behind it.
	return <>
		{image ? (
			// SVG <image> bypasses WKWebView's views:// handler. HTML images
			// inside foreignObject use the same loader as the rest of the app.
			<foreignObject x={x - 20} y="70" width="40" height="40">
				<img src={image} alt="" onError={() => setFailedImages(previous => new Set(previous).add(image))}
					style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }} />
			</foreignObject>
		) : <>
			<circle cx={x} cy="90" r="20" fill={slot.color || "var(--ink-3)"} />
			<text x={x} y="95" fill="white" fontSize="14" textAnchor="middle" fontWeight="600">{slot.glyph || "?"}</text>
		</>}
		{slot.chainCaip && slot.chainCaip !== slot.caip && (
			<foreignObject x={x + 8} y="100" width="18" height="18">
				<AssetIcon caip={slot.chainCaip} size={18} />
			</foreignObject>
		)}
	</>;
}

function useReducedMotion() {
	const query = "(prefers-reduced-motion: reduce)";
	const [reduced, setReduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
	useEffect(() => {
		const media = window.matchMedia?.(query);
		if (!media) return;
		const changed = () => setReduced(media.matches);
		changed();
		if (media.addEventListener) media.addEventListener("change", changed);
		else media.addListener?.(changed);
		return () => {
			if (media.removeEventListener) media.removeEventListener("change", changed);
			else media.removeListener?.(changed);
		};
	}, []);
	return reduced;
}

export function RouteMap({ from, to, integration, showIntegrationLabel = true, centerImageUrl, centerStillUrl, animate = true, caption }: RouteMapProps) {
	const [failedCenterImages, setFailedCenterImages] = useState<Set<string>>(() => new Set());
	const reducedMotion = useReducedMotion();
	const gradientId = `routeMapLine-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
					<linearGradient id={gradientId} x1="0" x2="1">
						<stop offset="0%" stopColor={from.color || "var(--text-3)"} />
						<stop offset="100%" stopColor={to.color || "var(--text-3)"} />
					</linearGradient>
				</defs>

				{/* Dashed background line — gives the curve a subtle "track" feel */}
				<path d={path} stroke="var(--ink-4)" strokeWidth="2" fill="none" strokeDasharray="3 4" />

				{/* Solid color gradient line — the "real" route */}
				<path d={path} stroke={`url(#${gradientId})`} strokeWidth="2" fill="none" opacity="0.7" />

				{/* From-token node (left) */}
				<RouteToken slot={from} x={60} />

				{/* Animated traveling dot — drawn before the centerpiece so it visually
				    "enters" the swapper as it passes through the middle of the curve. */}
				{animate && !reducedMotion && (
					// Hidden until the motion starts: a renderer that does not run SMIL
					// would otherwise leave it at the SVG origin, off the route.
					<circle r="5" fill="var(--gold)" visibility="hidden">
						<set attributeName="visibility" to="visible" begin="0s" />
						<animateMotion dur="2.4s" repeatCount="indefinite" path={path} />
					</circle>
				)}

				{/* Centerpiece — branded swap animation when available, glyph ring otherwise.
				    Sized 128px so it reads as the hero of the route. */}
				{/* The art is the screen's signature: animated normally, its still
				    under reduced motion, a glyph only when neither loads. No heavy ring. */}
				{(() => {
					const art = !reducedMotion ? centerImageUrl : centerStillUrl;
					return art && !failedCenterImages.has(art) ? (
					<>
						{/* foreignObject <img>, not SVG <image>: WKWebView's SVG image
						    loader bypasses the custom views:// scheme handler, so local
						    bundle assets (the gif) render as a broken-image glyph. */}
						<foreignObject x={cx - half} y={cy - half} width={centerSize} height={centerSize}>
							<img
								src={art}
								alt=""
								onError={() => setFailedCenterImages(previous => new Set(previous).add(art))}
								style={{ width: "100%", height: "100%", display: "block", objectFit: "cover", borderRadius: "50%" }}
							/>
						</foreignObject>
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
				);
				})()}

				{/* Integration label below the centerpiece */}
				{showIntegrationLabel && integration && (
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
				<RouteToken slot={to} x={540} />
			</svg>

			{caption && (
				<div style={{ marginTop: 6, textAlign: "center", fontSize: 10, color: "var(--text-3)", letterSpacing: "0.04em" }}>
					{caption}
				</div>
			)}
		</div>
	);
}
