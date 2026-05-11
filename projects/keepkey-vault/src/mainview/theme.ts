import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

/* The existing kk.* token names stay so we don't have to rewrite ~50 components
   in one motion. Their *values* are bridged to the v3 study palette so the app
   re-tints in place: graphite surfaces, cream text, muted gold + mint accents
   instead of pure black + #FFD700. Pure CSS variable consumption (via inline
   var(--ink-0) etc.) lives in src/mainview/styles/tokens.css; this file is the
   bridge for screens still rendered through Chakra. */

const FONT_SANS  = "'Space Grotesk', -apple-system, system-ui, sans-serif"
const FONT_MONO  = "'Geist Mono', ui-monospace, monospace"
const FONT_SERIF = "'Instrument Serif', serif"

const config = defineConfig({
	globalCss: {
		"html, body": {
			fontFamily: FONT_SANS,
			letterSpacing: "-0.005em",
			fontFeatureSettings: '"ss01", "cv11"',
		},
	},
	theme: {
		tokens: {
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
