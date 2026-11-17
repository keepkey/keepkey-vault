import type { ElectrobunConfig } from "electrobun";
import { existsSync as existsFromCwd } from "node:fs";
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from "node:url";
import pkg from "./package.json";
import { verifiedHostAdapterFile } from "./monero-cli/src/host-adapter";
import { checkMoneroCoreVerifierDirectory, moneroCoreVerifierArtifact } from './src/bun/monero-core-verifier-artifact';

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const arch = process.arch; // 'arm64' or 'x64'
// Hutch evaluates this file and reads the result from stdout, so log to stderr only.
// It also runs it from a scratch directory (.cottontail-tmp/electrobun/<pid>), while
// copy sources resolve against the project: check paths against this file's folder.
const projectDir = dirname(fileURLToPath(import.meta.url));
const existsSync = (path: string) => existsFromCwd(isAbsolute(path) ? path : join(projectDir, path));
// Hutch resolves copy keys against the project even when the input is absolute.
const toolSource = (path: string) => isAbsolute(path) ? relative(projectDir, path) : path;
if (isMac) console.error(`[electrobun] Building for macOS ${arch}`);
const certifiedEmulatorSource = isWindows
	? "emulator-bundle/libkkemu.dll"
	: isMac ? "emulator-bundle/libkkemu.dylib" : null;
// Local Developer-ID builds stage a signed copy after verifying the immutable
// certified artifact. CI/unsigned builds continue to embed the certified bytes
// directly. Keeping the signed copy separate preserves source hash verification.
const selectedEmulatorSource = process.env.KEEPKEY_EMULATOR_SOURCE || certifiedEmulatorSource;
const emulatorSource = selectedEmulatorSource ? toolSource(selectedEmulatorSource) : null;
const emulatorCopy = emulatorSource && existsSync(emulatorSource)
	? { [emulatorSource]: `emulator/${emulatorSource.split('/').pop()}`,
		...(process.env.KEEPKEY_EMULATOR_RECEIPT_SOURCE ? {
			[toolSource(process.env.KEEPKEY_EMULATOR_RECEIPT_SOURCE)]: 'emulator/nu7-emulator-receipt.json',
		} : {}) }
	: {};

const moneroPlatform = `${process.platform}-${process.arch}`;
const moneroSidecar = isWindows ? "monero-cli.exe" : "monero-cli";
const moneroRpc = isWindows ? "monero-wallet-rpc.exe" : "monero-wallet-rpc";
const moneroVendor = `monero-cli/vendor/${moneroPlatform}`;
const zcashSidecar = isWindows ? 'zcash-cli.exe' : 'zcash-cli';
const zcashCliSource = toolSource(process.env.KEEPKEY_ZCASH_CLI_SOURCE || `zcash-cli/target/release/${zcashSidecar}`);
const moneroCliSource = toolSource(process.env.KEEPKEY_MONERO_CLI_SOURCE || `monero-cli/dist/${moneroSidecar}`);
const moneroRpcSource = toolSource(process.env.KEEPKEY_MONERO_RPC_SOURCE || `${moneroVendor}/${moneroRpc}`);
const moneroMetadataSource = toolSource(process.env.KEEPKEY_MONERO_METADATA_SOURCE || `${moneroVendor}/monero-tools.json`);
const moneroAdapterSource = toolSource(process.env.KEEPKEY_MONERO_ADAPTER_SOURCE || `${moneroVendor}/monero-host-adapter`);
const verifiedMoneroAdapter = existsSync(moneroAdapterSource)
    ? verifiedHostAdapterFile(join(projectDir, moneroAdapterSource), join(projectDir, moneroMetadataSource), moneroPlatform) : null;
if (existsSync(moneroAdapterSource) && !verifiedMoneroAdapter) throw new Error('The Monero host adapter does not match its reviewed metadata');
const moneroDaemon = isWindows ? 'monerod.exe' : 'monerod';
const moneroDaemonSource = toolSource(process.env.KEEPKEY_MONERO_DAEMON_SOURCE || `${moneroVendor}/${moneroDaemon}`);
const moneroCopy = existsSync(moneroCliSource) && existsSync(moneroRpcSource)
    ? { [moneroCliSource]: moneroSidecar,
        [moneroRpcSource]: `monero-tools/${moneroRpc}`,
        [moneroMetadataSource]: "monero-tools/monero-tools.json",
        ...(verifiedMoneroAdapter ? { [moneroAdapterSource]: "monero-tools/monero-host-adapter",
            'monero-cli/host-adapter-LICENSES.txt': 'monero-tools/HOST-ADAPTER-LICENSES.txt' } : {}),
        ...(existsSync(moneroDaemonSource) ? { [moneroDaemonSource]: `monero-tools/${moneroDaemon}` } : {}),
        [`${moneroVendor}/LICENSE`]: "monero-tools/LICENSE" } : {};
// Development-only research artifacts (build-signed.ts refuses this flag): the receive-only and/or
// signing emulator builds. The verified host adapter is packaged separately for normal receive access.
const includeMoneroResearch = process.env.KEEPKEY_INCLUDE_MONERO_EMULATOR === '1';
// Capability signing uses the independently hash-checked Core verifier, without a host prover.
const verifierArtifact = moneroCoreVerifierArtifact();
const moneroVerifierSource = toolSource(process.env.KEEPKEY_MONERO_CORE_VERIFIER_SOURCE || 'monero-device-bundle/libmonero_core_verify.dylib');
const moneroVerifierReceiptSource = process.env.KEEPKEY_MONERO_CORE_VERIFIER_RECEIPT_SOURCE;
const verifiedCoreVerifier = verifierArtifact && existsSync(moneroVerifierSource)
    ? checkMoneroCoreVerifierDirectory(dirname(join(projectDir, moneroVerifierSource)), undefined, !!moneroVerifierReceiptSource) : null;
if (verifierArtifact && existsSync(moneroVerifierSource) && !verifiedCoreVerifier) throw new Error('The Monero Core verifier does not match its reviewed metadata');
const moneroDeviceCopy = verifiedCoreVerifier
    ? { [moneroVerifierSource]: 'monero-device/libmonero_core_verify.dylib',
        'monero-cli/core-verifier-LICENSES.txt': 'monero-device/LICENSES.txt',
        ...(moneroVerifierReceiptSource ? { [toolSource(moneroVerifierReceiptSource)]: 'monero-device/core-verifier-receipt.json' } : {}) } : {};
const moneroEmulatorCopy = {
    ...(includeMoneroResearch && existsSync("monero-emulator-bundle/libkkemu-monero.dylib")
        ? { "monero-emulator-bundle/manifest.json": "monero-emulator/manifest.json",
            "monero-emulator-bundle/libkkemu-monero.dylib": "monero-emulator/libkkemu-monero.dylib" } : {}),
    ...(includeMoneroResearch && existsSync("monero-emulator-bundle/libkkemu-monero-signing.dylib")
        ? { "monero-emulator-bundle/signing-manifest.json": "monero-emulator/signing-manifest.json",
            "monero-emulator-bundle/libkkemu-monero-signing.dylib": "monero-emulator/libkkemu-monero-signing.dylib" } : {}),
};

const zcashCopy = existsSync(zcashCliSource) ? { [zcashCliSource]: zcashSidecar,
    ...(existsSync(`${zcashCliSource}.nu7.json`) ? { [`${zcashCliSource}.nu7.json`]: `${zcashSidecar}.nu7.json` } : {}) } : {};

export default {
	app: {
		name: "keepkey-vault",
		identifier: "com.keepkey.vault",
		version: pkg.version,
		urlSchemes: ["keepkey", "keepkey-vault"],
	},
	build: {
		buildFolder: "_build",
		// Electrobun 2.x: the fork's devkit selects the bundled Bun (1.4.4); bunVersion is gone.
		mainProcess: "bun",
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
			// Zcash privacy engine sidecar (Rust binary -- .exe on Windows). Only Apple
			// Silicon builds it; Vault disables the privacy capability when it is absent,
			// and scripts/verify-release-bundle.ts requires it in the arm64 release.
			...zcashCopy,

		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
			codesign: process.env.CI !== 'true',
			// `make dmg` builds, signs and notarizes the shipped disk image from this
			// app; notarizing the image covers the app inside it. Hutch's own wrapper
			// DMG and app submission would only add Apple round trips.
			notarize: false,
			createDmg: false,
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
				// human-readable prompt copy is set in scripts/patch-bundle.ts.
				"com.apple.security.device.camera": true,
			},
		},
		linux: {
			bundleCEF: false,
			icon: "icon.png",
		},
		win: {
			bundleCEF: false,
			// Hutch refuses Windows PNG icons over 256x256 (PngTooLarge); icon.png is 512.
			icon: "icon.iconset/icon_256x256.png",
		},
	},
	release: {
		baseUrl: "https://github.com/keepkey/keepkey-vault/releases/latest/download",
		// Hutch would otherwise download the current Latest (a 1.x release) during
		// every stable build and diff against it. Vault does not publish patches.
		generatePatch: false,
	},
	scripts: {
		postBuild: "scripts/patch-bundle.ts",
	},
} satisfies ElectrobunConfig;
