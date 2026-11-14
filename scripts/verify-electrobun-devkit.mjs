#!/usr/bin/env node
// Refuse an Electrobun devkit that is not our fork's pinned version for this host,
// before Hutch is pointed at it (HUTCH_ELECTROBUN_DEVKIT_ROOT). native-devkit.json
// carries only a version string, so the build that made the devkit records the
// fork commit next to it, and this must equal the modules/electrobun pin.
// Usage: node scripts/verify-electrobun-devkit.mjs [--record] [--release] <devkit-dir>
//   --record   write the record from modules/electrobun (run right after building)
//   --release  also refuse a devkit built from a fork tree with local changes
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
if (!root) throw new Error("usage: verify-electrobun-devkit.mjs [--record] [--release] <devkit-dir>");
const manifestPath = join(root, "native-devkit.json");
if (!existsSync(manifestPath)) throw new Error(`${manifestPath} missing: no Electrobun devkit at ${root}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const fork = fileURLToPath(new URL("../modules/electrobun", import.meta.url));
const git = (...a) => execFileSync("git", ["-C", fork, ...a], { encoding: "utf8" }).trim();
const pin = git("rev-parse", "HEAD");
const sourcePath = join(root, "keepkey-devkit-source.json");
if (args.includes("--record")) {
	const changes = git("status", "--porcelain");
	writeFileSync(sourcePath, `${JSON.stringify({ commit: pin, dirty: changes !== "", changes: changes ? changes.split("\n") : [] }, null, "\t")}\n`);
}
const source = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf8")) : null;

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
if (!source) problems.push(`${sourcePath} missing: no record of the fork commit this devkit was built from`);
else {
	if (source.commit !== pin) problems.push(`built from fork ${source.commit}, modules/electrobun is pinned at ${pin}`);
	if (source.dirty && args.includes("--release")) {
		problems.push(`built from a fork tree with local changes:\n    ${source.changes.join("\n    ")}`);
	}
}
if (problems.length) {
	console.error(`ERROR: Electrobun devkit at ${root} is unusable:\n  ${problems.join("\n  ")}`);
	process.exit(1);
}
console.log(`Electrobun devkit ${pinned} ${os}-${process.arch} fork ${pin}${source.dirty ? " (local changes)" : ""} at ${root}`);
