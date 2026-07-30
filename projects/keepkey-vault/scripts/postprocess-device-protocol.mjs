#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const protocolRoot = resolve(process.argv[2] ?? new URL("../../../modules/device-protocol", import.meta.url).pathname)
const libDir = resolve(protocolRoot, "lib")
const unsafeGlobal = "var global = Function('return this')();"
const safeGlobal = "var global = (function(){ return this }).call(null);"

let patched = 0
for (const entry of readdirSync(libDir, { withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith(".js")) continue
	const path = resolve(libDir, entry.name)
	const source = readFileSync(path, "utf8")
	if (!source.includes(unsafeGlobal)) continue
	writeFileSync(path, source.replaceAll(unsafeGlobal, safeGlobal))
	patched++
}

console.log(`[device-protocol] postprocessed ${patched} generated JS file(s)`)
