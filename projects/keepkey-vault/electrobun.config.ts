import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "keepkey-vault",
		identifier: "com.keepkey.vault",
		version: "0.1.0",
	},
	build: {
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
			],
		},
		// Vite builds to dist/, we copy from there
		// build/_ext_modules contains native addons + transitive deps (see scripts/collect-externals.ts)
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"build/_ext_modules": "node_modules",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			// Code signing — requires ELECTROBUN_DEVELOPER_ID, ELECTROBUN_TEAMID env vars
			codesign: true,
			// Notarization — requires ELECTROBUN_APPLEID, ELECTROBUN_APPLEIDPASS env vars
			notarize: true,
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
		baseUrl: "https://github.com/BitHighlander/keepkey-vault-v11/releases/latest/download",
	},
} satisfies ElectrobunConfig;
