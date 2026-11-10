import { createSystem, defaultConfig, defineConfig, defineRecipe } from "@chakra-ui/react";

/* The existing kk.* token names stay so we don't have to rewrite ~50 components
   in one motion. Their *values* are bridged to the v3 study palette so the app
   re-tints in place: graphite surfaces, cream text, muted gold + mint accents
   instead of pure black + #FFD700. Pure CSS variable consumption (via inline
   var(--ink-0) etc.) lives in src/mainview/styles/tokens.css; this file is the
   bridge for screens still rendered through Chakra. */

const FONT_MONO  = "'Geist Mono', ui-monospace, monospace"
const FONT_SANS  = FONT_MONO  // mono is now the app-wide default
const FONT_SERIF = FONT_MONO  // serif usages collapse to mono too


/* Button recipe tuned for the dark app shell.

   Chakra renders in light mode here, so the stock recipe drew light-gray
   outline borders and near-white hover fills on a near-black UI (the "white
   box" around "Scan Bitcoin QR"). These overrides keep the same variant and
   size NAMES, so the ~450 existing <Button> call sites pick them up without
   edits, while explicit style props at a call site still win.

   Sizes follow the app's compact mono type scale (11-14px) on a 4px grid:
     2xs 24px · xs 28px · sm 32px · md 36px · lg 44px
   Tinted gold/teal/rose and primary-gold actions live in
   components/ui/ActionButton.tsx. */
const buttonRecipe = defineRecipe({
	base: {
		fontFamily: FONT_MONO,
		fontWeight: "600",
		letterSpacing: "0.02em",
		borderRadius: "control",
		gap: "1.5",
		transitionProperty: "background, border-color, color, opacity, box-shadow",
		transitionDuration: "0.15s",
		_disabled: { opacity: 0.45, cursor: "not-allowed" },
	},
	variants: {
		size: {
			"2xs": { h: "6", minW: "6", px: "2", fontSize: "10px", textStyle: "none" },
			xs: { h: "7", minW: "7", px: "2.5", fontSize: "11px", textStyle: "none" },
			sm: { h: "8", minW: "8", px: "3.5", fontSize: "12px", textStyle: "none" },
			md: { h: "9", minW: "9", px: "4", fontSize: "13px", textStyle: "none" },
			lg: { h: "11", minW: "11", px: "6", fontSize: "14px", textStyle: "none" },
		},
		variant: {
			solid: {
				bg: "var(--ink-3)",
				color: "var(--text-0)",
				borderColor: "var(--line-2)",
				_hover: { bg: "var(--ink-4)" },
				_expanded: { bg: "var(--ink-4)" },
			},
			subtle: {
				bg: "rgba(255,255,255,0.04)",
				color: "var(--text-1)",
				borderColor: "transparent",
				_hover: { bg: "rgba(255,255,255,0.08)" },
				_expanded: { bg: "rgba(255,255,255,0.08)" },
			},
			surface: {
				bg: "rgba(255,255,255,0.04)",
				color: "var(--text-1)",
				borderColor: "var(--line)",
				shadow: "none",
				_hover: { bg: "rgba(255,255,255,0.08)" },
				_expanded: { bg: "rgba(255,255,255,0.08)" },
			},
			outline: {
				bg: "transparent",
				color: "var(--text-1)",
				borderColor: "var(--line-2)",
				_hover: { bg: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.18)" },
				_expanded: { bg: "rgba(255,255,255,0.05)" },
			},
			ghost: {
				bg: "transparent",
				color: "var(--text-1)",
				borderColor: "transparent",
				_hover: { bg: "rgba(255,255,255,0.06)" },
				_expanded: { bg: "rgba(255,255,255,0.06)" },
			},
			plain: {
				color: "var(--text-1)",
				_hover: { color: "var(--text-0)" },
			},
		},
	},
});

const config = defineConfig({
	globalCss: {
		"html, body": {
			fontFamily: FONT_SANS,
			letterSpacing: "-0.005em",
			fontFeatureSettings: '"ss01", "cv11"',
		},
	},
	theme: {
		recipes: {
			button: buttonRecipe,
		},
		tokens: {
			/* Shared radii: controls (buttons, inputs, chips) vs. cards and panels. */
			radii: {
				control: { value: "10px" },
				card: { value: "16px" },
				panel: { value: "22px" },
			},
			fonts: {
				heading: { value: FONT_SANS },
				body:    { value: FONT_SANS },
				mono:    { value: FONT_MONO },
				serif:   { value: FONT_SERIF },
			},
			colors: {
				/* Gold ramp — desaturated study palette. The 500 slot stays the
				   "primary" gold and matches kk.gold. */
				gold: {
					50:  { value: "#FBF3D9" },
					100: { value: "#F8EBC0" },
					200: { value: "#F4DFA2" },
					300: { value: "#F0D484" },
					400: { value: "#ECCB76" },
					500: { value: "#E9C46A" }, // --gold
					600: { value: "#D9B25A" },
					700: { value: "#BF9A4A" },
					800: { value: "#A0813C" },
					900: { value: "#7A622D" },
				},
				kk: {
					/* Surfaces */
					bg:          { value: "#0b0b0e" }, // --ink-0
					cardBg:      { value: "#101015" }, // --ink-1
					cardBgHover: { value: "#16161d" }, // --ink-2
					border:      { value: "#1c1c25" }, // --ink-3 (used as visible line)
					borderAlt:   { value: "#25252f" }, // --ink-4

					/* Brand */
					gold:      { value: "#e9c46a" },   // --gold
					goldHover: { value: "#f2d27e" },   // --gold-2

					/* Status accents — softened, no alarm-bell red */
					highlight: { value: "#e08c7b" },   // --rose
					success:   { value: "#8be3c4" },   // --teal
					warning:   { value: "#e9c46a" },   // --gold (same as primary, calmer than orange)
					error:     { value: "#e08c7b" },   // --rose

					/* Text */
					textPrimary:   { value: "#f5f4ef" }, // --text-0
					textSecondary: { value: "#c8c7be" }, // --text-1
					textMuted:     { value: "#8a8a82" }, // --text-2
				},
			},
		},
		semanticTokens: {
			colors: {
				bg:                { value: "#0b0b0e" },
				"bg.subtle":       { value: "#101015" },
				"bg.muted":        { value: "#16161d" },
				fg:                { value: "#f5f4ef" },
				"fg.muted":        { value: "#c8c7be" },
				border:            { value: "#1c1c25" },
				"border.emphasized": { value: "#25252f" },
			},
		},
	},
});

export const system = createSystem(defaultConfig, config);
