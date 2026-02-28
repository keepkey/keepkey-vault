import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
	plugins: [react()],
	root: "src/mainview",
	base: "./",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		rollupOptions: {
			output: {
				manualChunks(id) {
					// Split the large asset data JSON into its own chunk
					if (id.includes("assetData.json")) return "asset-data";
					// Split non-English locale files into lazy chunks
					const localeMatch = id.match(/i18n\/locales\/(\w+)\//);
					if (localeMatch && localeMatch[1] !== "en") {
						return `locale-${localeMatch[1]}`;
					}
				},
			},
		},
	},
	resolve: {
		alias: {
			"@shared": resolve(__dirname, "src/shared"),
		},
	},
	server: {
		port: 5177,
		strictPort: true,
	},
});
