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
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
