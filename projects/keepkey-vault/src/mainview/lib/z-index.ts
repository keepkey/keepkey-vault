/** Centralized z-index scale to prevent stacking order conflicts. */
export const Z = {
  nav: 1000,
  drawerBackdrop: 1100,
  drawerPanel: 1200,
  dialog: 1500,
  /** Sits above dialog (asset picker opened from SwapDialog) but below overlay
   *  so PIN/passphrase prompts always trump asset selection. */
  assetPicker: 1700,
  overlay: 2000,
} as const
