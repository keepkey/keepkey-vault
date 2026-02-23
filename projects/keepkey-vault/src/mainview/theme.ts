import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

const config = defineConfig({
	theme: {
		tokens: {
			colors: {
				gold: {
					50: { value: "#FFF9E0" },
					100: { value: "#FFECB3" },
					200: { value: "#FFE082" },
					300: { value: "#FFD54F" },
					400: { value: "#FFCA28" },
					500: { value: "#FFD700" },
					600: { value: "#FFC107" },
					700: { value: "#FFB300" },
					800: { value: "#FFA000" },
					900: { value: "#FF8F00" },
				},
				kk: {
					bg: { value: "#000000" },
					cardBg: { value: "#111111" },
					cardBgHover: { value: "#1A1A1A" },
					border: { value: "#222222" },
					borderAlt: { value: "#3A4A5C" },
					gold: { value: "#FFD700" },
					goldHover: { value: "#FFE135" },
					highlight: { value: "#E94560" },
					textPrimary: { value: "#FFFFFF" },
					textSecondary: { value: "#A0A0A0" },
					textMuted: { value: "#666666" },
					success: { value: "#00C853" },
					warning: { value: "#FFB300" },
					error: { value: "#FF1744" },
				},
			},
		},
		semanticTokens: {
			colors: {
				"bg": { value: "#000000" },
				"bg.subtle": { value: "#111111" },
				"bg.muted": { value: "#1A1A1A" },
				"fg": { value: "#FFFFFF" },
				"fg.muted": { value: "#A0A0A0" },
				"border": { value: "#222222" },
				"border.emphasized": { value: "#3A4A5C" },
			},
		},
	},
});

export const system = createSystem(defaultConfig, config);
