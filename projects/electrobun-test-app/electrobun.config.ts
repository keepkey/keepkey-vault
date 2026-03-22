import type { ElectrobunConfig } from "electrobun";

const isWindows = process.platform === "win32";

export default {
	app: {
		name: "electrobun-test",
		identifier: "com.keepkey.electrobun-test",
		version: "0.0.1",
		urlSchemes: ["keepkey-test"],
	},
	build: {
		buildFolder: "_build",
		bun: {
			// Same externals as vault — these are loaded at runtime, not bundled
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
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
		},
		win: {
			bundleCEF: false,
			icon: "../keepkey-vault/icon.png",
		},
	},
	release: {
		baseUrl: "https://example.com",
	},
} satisfies ElectrobunConfig;
