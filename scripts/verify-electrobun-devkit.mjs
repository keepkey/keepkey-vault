#!/usr/bin/env node
// Refuse an Electrobun devkit that is not our fork's pinned version for this host,
// before Hutch is pointed at it (HUTCH_ELECTROBUN_DEVKIT_ROOT).
// Usage: node scripts/verify-electrobun-devkit.mjs <devkit-dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: verify-electrobun-devkit.mjs <devkit-dir>");
const manifestPath = join(root, "native-devkit.json");
if (!existsSync(manifestPath)) throw new Error(`${manifestPath} missing: no Electrobun devkit at ${root}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const hutchConfig = readFileSync(new URL("../projects/keepkey-vault/hutch.config.ts", import.meta.url), "utf8");
const pinned = hutchConfig.match(/electrobun:\s*\{\s*version:\s*"([^"]+)"/)?.[1];
if (!pinned) throw new Error("projects/keepkey-vault/hutch.config.ts pins no electrobun version");

const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
const problems = [];
if (manifest.product?.name !== "electrobun") problems.push(`product ${manifest.product?.name}`);
if (manifest.product?.version !== pinned) problems.push(`version ${manifest.product?.version}, hutch.config.ts pins ${pinned}`);
if (manifest.target?.os !== os || manifest.target?.arch !== process.arch) {
	problems.push(`built for ${manifest.target?.os}-${manifest.target?.arch}, this host is ${os}-${process.arch}`);
}
for (const [key, file] of Object.entries(manifest.layout?.runtime ?? {})) {
	// Vault bundles neither WGPU nor CEF; every other runtime file must be there.
	if (key.startsWith("wgpu") || key === "nativeWrapperCef") continue;
	for (const f of [file].flat()) if (!existsSync(join(root, f))) problems.push(`runtime.${key} ${f} missing`);
}
if (problems.length) {
	console.error(`ERROR: Electrobun devkit at ${root} is unusable:\n  ${problems.join("\n  ")}`);
	process.exit(1);
}
console.log(`Electrobun devkit ${pinned} ${os}-${process.arch} at ${root}`);
