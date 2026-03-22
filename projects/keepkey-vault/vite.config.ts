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
				// Fixed filenames — no content hashes. This is a desktop app loaded
				// via Electrobun's views:// protocol, not a browser. Content-hashed
				// filenames cause WebView2 cache poisoning on upgrade: the cached
				// index.html references the old hash, the new file has a different
				// hash, the JS never loads, and the window stays blank.
				// See retro-alpha1-2026-03-21.md for the full evidence chain.
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
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
