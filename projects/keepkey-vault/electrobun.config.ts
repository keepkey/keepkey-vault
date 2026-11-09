import type { ElectrobunConfig } from "electrobun";
import { existsSync } from "node:fs";
import { isAbsolute, relative } from 'node:path';
import pkg from "./package.json";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const arch = process.arch; // 'arm64' or 'x64'
if (isMac) console.log(`[electrobun] Building for macOS ${arch}`);
const certifiedEmulatorSource = isWindows
	? "emulator-bundle/libkkemu.dll"
	: isMac ? "emulator-bundle/libkkemu.dylib" : null;
// Local Developer-ID builds stage a signed copy after verifying the immutable
// certified artifact. CI/unsigned builds continue to embed the certified bytes
// directly. Keeping the signed copy separate preserves source hash verification.
const emulatorSource = process.env.KEEPKEY_EMULATOR_SOURCE || certifiedEmulatorSource;
const emulatorCopy = emulatorSource && existsSync(emulatorSource)
	? { [emulatorSource]: `emulator/${emulatorSource.split('/').pop()}` }
	: {};

const moneroPlatform = `${process.platform}-${process.arch}`;
const moneroSidecar = isWindows ? "monero-cli.exe" : "monero-cli";
const moneroRpc = isWindows ? "monero-wallet-rpc.exe" : "monero-wallet-rpc";
const moneroVendor = `monero-cli/vendor/${moneroPlatform}`;
// Electrobun resolves copy keys relative to the project, even for absolute inputs.
const toolSource = (path: string) => isAbsolute(path) ? relative(process.cwd(), path) : path;
const moneroCliSource = toolSource(process.env.KEEPKEY_MONERO_CLI_SOURCE || `monero-cli/dist/${moneroSidecar}`);
const moneroRpcSource = toolSource(process.env.KEEPKEY_MONERO_RPC_SOURCE || `${moneroVendor}/${moneroRpc}`);
const moneroMetadataSource = toolSource(process.env.KEEPKEY_MONERO_METADATA_SOURCE || `${moneroVendor}/monero-tools.json`);
const moneroDaemon = isWindows ? 'monerod.exe' : 'monerod';
const moneroDaemonSource = toolSource(process.env.KEEPKEY_MONERO_DAEMON_SOURCE || `${moneroVendor}/${moneroDaemon}`);
const moneroCopy = existsSync(moneroCliSource) && existsSync(moneroRpcSource)
    ? { [moneroCliSource]: moneroSidecar,
        [moneroRpcSource]: `monero-tools/${moneroRpc}`,
        [moneroMetadataSource]: "monero-tools/monero-tools.json",
        ...(existsSync(moneroDaemonSource) ? { [moneroDaemonSource]: `monero-tools/${moneroDaemon}` } : {}),
        [`${moneroVendor}/LICENSE`]: "monero-tools/LICENSE" } : {};
// Development-only research artifacts (build-signed.ts refuses this flag): the receive-only and/or
// signing emulator builds, and the research signing adapter pinned in monero-tools.json.
const includeMoneroResearch = process.env.KEEPKEY_INCLUDE_MONERO_EMULATOR === '1';
const moneroDeviceCopy = includeMoneroResearch && existsSync('monero-device-bundle/libmonero_device_proof.dylib') && existsSync('monero-device-bundle/libmonero_core_verify.dylib')
    ? { 'monero-device-bundle': 'monero-device' } : {};
const moneroEmulatorCopy = {
    ...(includeMoneroResearch && existsSync("monero-emulator-bundle/libkkemu-monero.dylib")
        ? { "monero-emulator-bundle/manifest.json": "monero-emulator/manifest.json",
            "monero-emulator-bundle/libkkemu-monero.dylib": "monero-emulator/libkkemu-monero.dylib" } : {}),
    ...(includeMoneroResearch && existsSync("monero-emulator-bundle/libkkemu-monero-signing.dylib")
        ? { "monero-emulator-bundle/signing-manifest.json": "monero-emulator/signing-manifest.json",
            "monero-emulator-bundle/libkkemu-monero-signing.dylib": "monero-emulator/libkkemu-monero-signing.dylib" } : {}),
    ...(includeMoneroResearch && existsSync(`${moneroVendor}/monero-host-adapter`)
        ? { [`${moneroVendor}/monero-host-adapter`]: "monero-tools/monero-host-adapter" } : {}),
};

export default {
	app: {
		name: "keepkey-vault",
		identifier: "com.keepkey.vault",
		version: pkg.version,
		urlSchemes: ["keepkey", "keepkey-vault"],
	},
	build: {
		buildFolder: "_build",
		// Pin Bun to a non-AVX-safe baseline build. Electrobun 1.13.1 defaults to
		// Bun 1.3.9, which sits inside an upstream non-AVX regression window. 1.3.14
		// is the first version combining baseline WebKit + the JSC AVX-gating fix.
		// On Windows this override always fetches bun-windows-x64-baseline.zip.
		// Pairs with the -mcpu=baseline wrapper build (scripts/build-windows-production.ps1).
		// See docs/windows-non-avx-launcher-crash.md §5.
		bunVersion: "1.3.14",
		bun: {
			// Point at the pre-bundled backend from scripts/bundle-backend.ts.
			// It already inlines ALL deps (@keepkey/*, ethers, protobuf, swagger, etc.)
			// into a single file. Only native addons and proto-tx-builder remain external.
			entrypoint: "_build/_bundled_backend/index.js",
			external: [
				"node-hid",
				"usb",
				"google-protobuf",
				"@keepkey/proto-tx-builder",
				"swagger-client",
				"@walletconnect/web3wallet",
				"@walletconnect/core",
				"@walletconnect/types",
				"@walletconnect/utils",
				"@walletconnect/jsonrpc-utils",
			],
		},
		// Vite builds to dist/, we copy from there
		// _build/_ext_modules contains ONLY native addons + proto-tx-builder (~23 packages)
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"_build/_ext_modules": "node_modules",
			// Bundled firmware + bootloader — ships inside the signed/notarized DMG
			// so tampering with any binary breaks Apple's signature. Provides an offline
			// floor when the remote manifest is unreachable. See firmware-bundle/README.md.
			"firmware-bundle": "firmware-bundle",
			"src/bun/fonts": "report-fonts",
			// Release builds preflight this file before Electrobun runs. Keeping the
			// config conditional preserves emulator-free developer builds on Linux.
			...emulatorCopy,
			...moneroCopy,
			...moneroEmulatorCopy,
			...moneroDeviceCopy,
			// Zcash privacy engine sidecar (Rust binary -- .exe on Windows)
			[isWindows ? "zcash-cli/target/release/zcash-cli.exe" : "zcash-cli/target/release/zcash-cli"]: isWindows ? "zcash-cli.exe" : "zcash-cli",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			codesign: process.env.CI !== 'true',
			notarize: process.env.CI !== 'true',
			// CI ships the Intel update archive and discards the ARM disk image.
			createDmg: process.env.CI !== 'true',
			entitlements: {
				"com.apple.security.cs.allow-jit": true,
				"com.apple.security.cs.allow-unsigned-executable-memory": true,
				"com.apple.security.cs.disable-library-validation": true,
				"com.apple.security.cs.allow-dyld-environment-variables": true,
				// QR scanning (QrScannerOverlay -> getUserMedia). Under the hardened
				// runtime the camera is blocked without this entitlement, and macOS
				// kills the process if Info.plist has no NSCameraUsageDescription.
				// Must stay `true`: Electrobun writes a string value straight into
				// entitlements.plist as <string>, which codesign rejects here. The
				// human-readable prompt copy is set in scripts/prune-app-bundle.ts.
				"com.apple.security.device.camera": true,
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
