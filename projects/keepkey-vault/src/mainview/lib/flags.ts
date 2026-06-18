/**
 * Feature flags — plain in-code constants. Flip the value and rebuild; there
 * are no env vars and no per-channel build wiring.
 *
 * SWAP_SIDEPANEL — gates the native KeepKey swap side panel and every entry
 * point into it (the nav "Swap" tab, the per-asset Swap pill, the global
 * swap-cmd open hook, and swap-resume). When `false`, the swap surface is fully
 * hidden. Currently ON while the side-panel UX is being proven; flip to `false`
 * for a stable build until then.
 */
export const SWAP_SIDEPANEL = true
