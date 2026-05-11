/**
 * 360° spinning KeepKey, built as a 6-face CSS-3D box (no Three.js, no WebGL).
 * Front face is the OLED screen — content is fully customizable via the
 * `screen` slot so the same shell can show "Confirm send / swap quote /
 * computing / completed / pin entry" without forking the geometry.
 *
 * Adapted from the standalone design preview (Spline-style export). Sized to
 * the real device's 93×38×12mm proportions. Stationary floor shadow under a
 * stage rotating around its Y axis on a CSS keyframe.
 */
import type { CSSProperties, ReactNode } from "react";

export interface SpinningDeviceProps {
	/** Seconds for one full revolution. Default 14s — quick enough to read as
	 *  motion, slow enough to read the OLED text on every face. */
	durationSeconds?: number;
	/** Pause the rotation (e.g. on hover). Defaults to spinning. */
	paused?: boolean;
	/** OLED face content. Default: a "CONFIRM SEND" demo screen. Override with
	 *  any JSX — the parent already lives inside an OLED-styled container with
	 *  monospace font, pixel grid, gloss reflection, and `color: var(--ink-0,
	 *  #e8e6dc)` (the warm off-white the real OLED renders). */
	screen?: ReactNode;
	/** Show the "keepkey" wordmark on the back face. Default true. */
	showWordmark?: boolean;
	/** Container style passthrough — width / margin / etc. */
	style?: CSSProperties;
}

const FONT_OLED =
	'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// Real KeepKey is ~93×38×12 mm. Pixel scale picked so the spinner reads at
// ~380px wide on a 900px-wide hero. Caller can scale via `style.width`.
const L = 380; // long axis
const W = 158; // short axis
const D = 44; // thickness

// Anodized aluminum back gradient + sparkle + grain
const MATTE_ALU =
	"linear-gradient(180deg, #6a6a70 0%, #57575c 35%, #46464a 65%, #38383c 100%)";
const ALU_SPARKLE =
	"radial-gradient(ellipse at 30% 35%, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 55%), radial-gradient(ellipse at 75% 70%, rgba(120,140,170,0.06) 0%, rgba(0,0,0,0) 60%)";
const ALU_GRAIN =
	"repeating-linear-gradient(92deg, rgba(255,255,255,0.022) 0px, rgba(255,255,255,0.022) 1px, rgba(0,0,0,0.03) 1px, rgba(0,0,0,0.03) 2px)";

// Glossy black acrylic front shell + diagonal highlight sweep
const GLOSS_BLACK =
	"linear-gradient(180deg, #16161a 0%, #0a0a0c 40%, #050507 100%)";
const GLOSS_HIGHLIGHT =
	"linear-gradient(120deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 28%, rgba(255,255,255,0) 72%, rgba(255,255,255,0.06) 100%)";

// Shell split: thicker glossy half (~55%) + thinner aluminum half on side faces
const SHELL_BLACK = 0.56;

interface FaceProps {
	w: number;
	h: number;
	transform: string;
	children?: ReactNode;
	style?: CSSProperties;
}

function Face({ w, h, transform, children, style }: FaceProps) {
	return (
		<div
			style={{
				position: "absolute",
				left: "50%",
				top: "50%",
				width: w,
				height: h,
				marginLeft: -w / 2,
				marginTop: -h / 2,
				transform,
				backfaceVisibility: "hidden",
				WebkitBackfaceVisibility: "hidden",
				boxSizing: "border-box",
				...style,
			}}
		>
			{children}
		</div>
	);
}

function DefaultDemoScreen() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 18,
				width: "100%",
			}}
		>
			<div style={{ flex: 1 }}>
				<div
					style={{
						fontSize: 11,
						opacity: 0.55,
						letterSpacing: 2,
						marginBottom: 4,
					}}
				>
					CONFIRM SEND
				</div>
				<div
					style={{
						fontSize: 26,
						fontWeight: 700,
						letterSpacing: 0.5,
						lineHeight: 1,
					}}
				>
					0.02400 BTC
				</div>
				<div
					style={{
						fontSize: 10,
						opacity: 0.55,
						letterSpacing: 1,
						marginTop: 6,
					}}
				>
					TO bc1q··7v3x··x4kp
				</div>
				<div
					style={{
						fontSize: 9,
						opacity: 0.4,
						letterSpacing: 1,
						marginTop: 3,
					}}
				>
					FEE 1,240 sats
				</div>
			</div>
			<div
				style={{
					width: 38,
					height: 38,
					borderRadius: "50%",
					border: "1.5px solid rgba(232,230,220,0.85)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					fontSize: 14,
				}}
			>
				▶
			</div>
		</div>
	);
}

export function SpinningDevice({
	durationSeconds = 14,
	paused = false,
	screen,
	showWordmark = true,
	style,
}: SpinningDeviceProps) {
	return (
		<div
			style={{
				width: "100%",
				aspectRatio: "800 / 420",
				perspective: 2400,
				perspectiveOrigin: "50% 42%",
				position: "relative",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				...style,
			}}
		>
			{/* Stationary floor shadow */}
			<div
				style={{
					position: "absolute",
					bottom: "14%",
					left: "50%",
					width: L * 0.88,
					height: 30,
					marginLeft: -(L * 0.88) / 2,
					background:
						"radial-gradient(ellipse at center, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0) 65%)",
					filter: "blur(7px)",
					pointerEvents: "none",
				}}
			/>

			{/* 3D box stage */}
			<div
				style={{
					position: "relative",
					width: L,
					height: W,
					transformStyle: "preserve-3d",
					animation: `kkSpin360 ${durationSeconds}s linear infinite`,
					animationPlayState: paused ? "paused" : "running",
					willChange: "transform",
				}}
			>
				{/* FRONT — glossy black OLED with caller-provided screen content */}
				<Face w={L} h={W} transform={`translateZ(${D / 2}px)`}>
					<div
						style={{
							width: "100%",
							height: "100%",
							background: GLOSS_BLACK,
							borderRadius: 3,
							boxShadow:
								"inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 0 rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.6)",
							position: "relative",
							overflow: "hidden",
							color: "#e8e6dc",
							fontFamily: FONT_OLED,
							padding: "14px 22px",
							boxSizing: "border-box",
							display: "flex",
							alignItems: "center",
						}}
					>
						{/* OLED pixel grid texture */}
						<div
							style={{
								position: "absolute",
								inset: 0,
								background:
									"repeating-linear-gradient(0deg, rgba(232,230,220,0.035) 0px, rgba(232,230,220,0.035) 1px, transparent 1px, transparent 2px)",
								pointerEvents: "none",
							}}
						/>
						{/* Diagonal gloss reflection sweep */}
						<div
							style={{
								position: "absolute",
								inset: 0,
								background: GLOSS_HIGHLIGHT,
								pointerEvents: "none",
							}}
						/>
						{/* Specular highlight blob */}
						<div
							style={{
								position: "absolute",
								left: "-8%",
								top: "-30%",
								width: "55%",
								height: "90%",
								background:
									"radial-gradient(ellipse at center, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 60%)",
								pointerEvents: "none",
							}}
						/>
						<div
							style={{
								position: "relative",
								width: "100%",
							}}
						>
							{screen ?? <DefaultDemoScreen />}
						</div>
					</div>
				</Face>

				{/* BACK — matte anodized aluminum + etched wordmark */}
				<Face
					w={L}
					h={W}
					transform={`translateZ(${-D / 2}px) rotateY(180deg)`}
				>
					<div
						style={{
							width: "100%",
							height: "100%",
							background: MATTE_ALU,
							borderRadius: 3,
							position: "relative",
							overflow: "hidden",
							boxShadow:
								"inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.5)",
						}}
					>
						<div
							style={{
								position: "absolute",
								inset: 0,
								background: ALU_SPARKLE,
								pointerEvents: "none",
							}}
						/>
						<div
							style={{
								position: "absolute",
								inset: 0,
								background: ALU_GRAIN,
								opacity: 0.55,
								pointerEvents: "none",
							}}
						/>
						{showWordmark && (
							<div
								style={{
									position: "absolute",
									inset: 0,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									fontFamily:
										"-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
									fontWeight: 600,
									fontSize: 38,
									letterSpacing: -1.5,
									color: "rgba(0,0,0,0.42)",
									textShadow: "0 1px 0 rgba(255,255,255,0.18)",
								}}
							>
								keepkey
							</div>
						)}
					</div>
				</Face>

				{/* TOP edge — long horizontal sliver, glossy black + matte aluminum
				    split, with a small button bump near one end. */}
				<Face
					w={L}
					h={D}
					transform={`rotateX(90deg) translateZ(${W / 2}px)`}
				>
					<div
						style={{
							width: "100%",
							height: "100%",
							display: "flex",
							borderRadius: 2,
							overflow: "hidden",
							boxShadow:
								"inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(0,0,0,0.5)",
							position: "relative",
						}}
					>
						<div
							style={{
								width: `${SHELL_BLACK * 100}%`,
								height: "100%",
								background: GLOSS_BLACK,
							}}
						/>
						<div
							style={{
								width: `${(1 - SHELL_BLACK) * 100}%`,
								height: "100%",
								background: MATTE_ALU,
								position: "relative",
							}}
						>
							<div
								style={{
									position: "absolute",
									inset: 0,
									background: ALU_GRAIN,
									opacity: 0.6,
								}}
							/>
						</div>
						{/* Hairline seam */}
						<div
							style={{
								position: "absolute",
								top: 0,
								bottom: 0,
								left: `${SHELL_BLACK * 100}%`,
								width: 1,
								background: "rgba(0,0,0,0.7)",
							}}
						/>
						{/* Confirm button bump — sits ~28% from the right edge */}
						<div
							style={{
								position: "absolute",
								top: "50%",
								left: "72%",
								transform: "translateY(-50%)",
								width: 28,
								height: D * 0.55,
								borderRadius: 2,
								background:
									"linear-gradient(180deg, #4a4a4e 0%, #2a2a2c 100%)",
								boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
							}}
						/>
					</div>
				</Face>

				{/* BOTTOM edge — same split, USB connector cutout near one end */}
				<Face
					w={L}
					h={D}
					transform={`rotateX(-90deg) translateZ(${W / 2}px)`}
				>
					<div
						style={{
							width: "100%",
							height: "100%",
							display: "flex",
							borderRadius: 2,
							overflow: "hidden",
							boxShadow:
								"inset 0 -1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(0,0,0,0.5)",
							position: "relative",
						}}
					>
						<div
							style={{
								width: `${SHELL_BLACK * 100}%`,
								height: "100%",
								background: GLOSS_BLACK,
							}}
						/>
						<div
							style={{
								width: `${(1 - SHELL_BLACK) * 100}%`,
								height: "100%",
								background: MATTE_ALU,
								position: "relative",
							}}
						>
							<div
								style={{
									position: "absolute",
									inset: 0,
									background: ALU_GRAIN,
									opacity: 0.6,
								}}
							/>
						</div>
						<div
							style={{
								position: "absolute",
								top: 0,
								bottom: 0,
								left: `${SHELL_BLACK * 100}%`,
								width: 1,
								background: "rgba(0,0,0,0.7)",
							}}
						/>
						{/* USB-C connector cutout — opposite end from the button */}
						<div
							style={{
								position: "absolute",
								top: "50%",
								left: "10%",
								transform: "translateY(-50%)",
								width: 32,
								height: D * 0.45,
								borderRadius: 4,
								background: "#050507",
								boxShadow:
									"inset 0 1px 2px rgba(0,0,0,0.9), inset 0 0 0 1px rgba(255,255,255,0.05)",
							}}
						/>
					</div>
				</Face>

				{/* LEFT short end — vertical sliver, same shell split */}
				<Face
					w={D}
					h={W}
					transform={`rotateY(-90deg) translateZ(${L / 2}px)`}
				>
					<div
						style={{
							width: "100%",
							height: "100%",
							display: "flex",
							flexDirection: "column",
							borderRadius: 2,
							overflow: "hidden",
							boxShadow:
								"inset 1px 0 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(0,0,0,0.5)",
							position: "relative",
						}}
					>
						<div
							style={{
								width: "100%",
								height: `${SHELL_BLACK * 100}%`,
								background: GLOSS_BLACK,
							}}
						/>
						<div
							style={{
								width: "100%",
								height: `${(1 - SHELL_BLACK) * 100}%`,
								background: MATTE_ALU,
								position: "relative",
							}}
						>
							<div
								style={{
									position: "absolute",
									inset: 0,
									background: ALU_GRAIN,
									opacity: 0.6,
								}}
							/>
						</div>
						<div
							style={{
								position: "absolute",
								left: 0,
								right: 0,
								top: `${SHELL_BLACK * 100}%`,
								height: 1,
								background: "rgba(0,0,0,0.7)",
							}}
						/>
					</div>
				</Face>

				{/* RIGHT short end — mirror of left */}
				<Face
					w={D}
					h={W}
					transform={`rotateY(90deg) translateZ(${L / 2}px)`}
				>
					<div
						style={{
							width: "100%",
							height: "100%",
							display: "flex",
							flexDirection: "column",
							borderRadius: 2,
							overflow: "hidden",
							boxShadow:
								"inset -1px 0 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(0,0,0,0.5)",
							position: "relative",
						}}
					>
						<div
							style={{
								width: "100%",
								height: `${SHELL_BLACK * 100}%`,
								background: GLOSS_BLACK,
							}}
						/>
						<div
							style={{
								width: "100%",
								height: `${(1 - SHELL_BLACK) * 100}%`,
								background: MATTE_ALU,
								position: "relative",
							}}
						>
							<div
								style={{
									position: "absolute",
									inset: 0,
									background: ALU_GRAIN,
									opacity: 0.6,
								}}
							/>
						</div>
						<div
							style={{
								position: "absolute",
								left: 0,
								right: 0,
								top: `${SHELL_BLACK * 100}%`,
								height: 1,
								background: "rgba(0,0,0,0.7)",
							}}
						/>
					</div>
				</Face>
			</div>

			<style>{`@keyframes kkSpin360 { from { transform: rotateY(0deg); } to { transform: rotateY(360deg); } }`}</style>
		</div>
	);
}
