import type { ElectrobunConfig } from "electrobun";

const isWindows = process.platform === "win32";

export default {
	app: {
		name: "keepkey-vault",
		identifier: "com.keepkey.vault",
		version: "1.2.0",
		urlSchemes: ["keepkey"],
	},
	build: {
		buildFolder: "_build",
		bun: {
			// Mark native addons and protobuf-dependent packages as external
			// so Bun loads them at runtime instead of bundling them.
			// Bundling breaks google-protobuf's `this || window` pattern in ESM context.
			external: [
				"@keepkey/hdwallet-core",
				"@keepkey/hdwallet-keepkey",
				"@keepkey/hdwallet-keepkey-nodehid",
				"@keepkey/hdwallet-keepkey-nodewebusb",
				"@keepkey/device-protocol",
				"google-protobuf",
				"node-hid",
				"usb",
				"ethers",
				"@pioneer-platform/pioneer-client",
			],
		},
		// Vite builds to dist/, we copy from there
		// build/_ext_modules contains native addons + transitive deps (see scripts/collect-externals.ts)
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"_build/_ext_modules": "node_modules",
			// Zcash privacy engine sidecar (Rust binary — .exe on Windows)
			[isWindows ? "zcash-cli/target/release/zcash-cli.exe" : "zcash-cli/target/release/zcash-cli"]: isWindows ? "zcash-cli.exe" : "zcash-cli",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			// Code signing — requires ELECTROBUN_DEVELOPER_ID, ELECTROBUN_TEAMID env vars
			// Disabled in CI (no Apple certs on Linux runners)
			codesign: process.env.CI !== 'true',
			// Notarization — requires ELECTROBUN_APPLEID, ELECTROBUN_APPLEIDPASS env vars
			notarize: process.env.CI !== 'true',
			// Entitlements for native USB modules (node-hid, usb, hdwallet)
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
