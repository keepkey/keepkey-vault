import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
	plugins: [react()],
	root: "src/mainview",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		rollupOptions: {
			output: {
				manualChunks(id) {
					// Split the large asset data JSON into its own chunk
					if (id.includes("assetData.json")) return "asset-data";
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
		port: 5173,
		strictPort: true,
	},
});
