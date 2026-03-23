import type { ElectrobunConfig } from "electrobun";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const arch = process.arch; // 'arm64' or 'x64'
if (isMac) console.log(`[electrobun] Building for macOS ${arch}`);

export default {
	app: {
		name: "keepkey-vault",
		identifier: "com.keepkey.vault",
		version: "1.2.6",
		urlSchemes: ["keepkey"],
	},
	build: {
		buildFolder: "_build",
		bun: {
			// Point at the pre-bundled backend from scripts/bundle-backend.ts.
			// It already inlines ALL deps (@keepkey/*, ethers, protobuf, swagger, etc.)
			// into a single file. Only native addons and proto-tx-builder remain external.
			entrypoint: "_build/_bundled_backend/index.js",
			external: [
				"node-hid",
				"usb",
				"@keepkey/proto-tx-builder",
			],
		},
		// Vite builds to dist/, we copy from there
		// _build/_ext_modules contains ONLY native addons + proto-tx-builder (~23 packages)
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"_build/_ext_modules": "node_modules",
			// Zcash privacy engine sidecar (Rust binary -- .exe on Windows)
			[isWindows ? "zcash-cli/target/release/zcash-cli.exe" : "zcash-cli/target/release/zcash-cli"]: isWindows ? "zcash-cli.exe" : "zcash-cli",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			codesign: process.env.CI !== 'true',
			notarize: process.env.CI !== 'true',
			entitlements: {
				"com.apple.security.cs.allow-jit": true,
				"com.apple.security.cs.allow-unsigned-executable-memory": true,
				"com.apple.security.cs.disable-library-validation": true,
				"com.apple.security.cs.allow-dyld-environment-variables": true,
			},
		},
		linux: {
			bundleCEF: false,
			icon: "icon.png",
		},
		win: {
			bundleCEF: false,
			icon: "icon.png",
		},
	},
	release: {
		baseUrl: "https://github.com/keepkey/keepkey-vault/releases/latest/download",
	},
} satisfies ElectrobunConfig;
