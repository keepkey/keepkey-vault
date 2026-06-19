/**
 * Build-time feature flags.
 *
 * These are baked into the frontend bundle by Vite at build time (via
 * `import.meta.env`), so flipping one requires a rebuild — they are NOT
 * user-toggleable at runtime. Frontend-only on purpose: this lives under
 * `mainview/` (not `shared/`) because `import.meta.env` does not exist in the
 * Bun backend bundle.
 *
 * SWAP_SIDEPANEL — gates the native KeepKey swap side panel and every entry
 * point into it (the nav "Swap" tab, the per-asset Swap pill, the global
 * swap-cmd open hook, and swap-resume). OFF by default so stable builds ship
 * without it; the `dev` and `build:canary` scripts set VITE_SWAP_SIDEPANEL=1
 * so those channels get it ON for testing. Once proven, default this to `true`
 * (or remove the flag and its gates).
 */
export const SWAP_SIDEPANEL =
	import.meta.env.VITE_SWAP_SIDEPANEL === "1" ||
	import.meta.env.VITE_SWAP_SIDEPANEL === "true"
