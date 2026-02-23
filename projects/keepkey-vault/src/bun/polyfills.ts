// Polyfill: @keepkey/device-protocol uses google-protobuf which has:
//   this || window || global || self || Function("return this")()
// In Bun's strict ESM worker context, `this` is undefined and `window` doesn't exist.
// This must be imported BEFORE any hdwallet packages.
if (typeof globalThis.window === 'undefined') {
	;(globalThis as any).window = globalThis
}
