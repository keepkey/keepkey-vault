# "Scan Screen" QR option — permissions, entitlements, dev vs prod

The QR overlay has three inputs: **camera** (getUserMedia), **image file**, and
**scan screen**. Scan-screen is implemented natively (`src/bun/screen-capture.ts`):
Bun minimizes the window, screenshots every display with the OS screenshot tool,
and the webview decodes the PNGs with jsQR.

## Why not getDisplayMedia in the webview

WKWebView only honors `getDisplayMedia` when the embedding app implements **no**
media-capture delegate. Electrobun implements
`webView:requestMediaCapturePermissionForOrigin:` for the camera, which makes
WebKit auto-deny display capture unless a **private** delegate
(`_webView:requestDisplayCapturePermissionForOrigin:`) is also implemented
(see WebKit's macOS Sonoma change for `getDisplayMedia` in WKWebView). Patching
private WebKit API into Electrobun's native wrapper is fragile; the native
screenshot path works identically on all three platforms.

## macOS (the pain point)

- **Permission**: Screen Recording, System Settings → Privacy & Security →
  Screen Recording. It is **pure TCC** — there is *no* codesign entitlement for
  screen capture (nothing to add to `electrobun.config.ts` `entitlements`).
  The sandbox is not in play (we ship Developer ID + hardened runtime, not MAS).
- **Info.plist**: `NSScreenCaptureUsageDescription` purpose string — injected by
  `scripts/patch-electrobun.sh` (same mechanism as `NSCameraUsageDescription`),
  so dev and prod bundles both get it.
- **Prompting**: `CGPreflightScreenCaptureAccess()` checks silently;
  `CGRequestScreenCaptureAccess()` registers the app in the Screen Recording
  list and shows the system prompt **once**. Both are called via `bun:ffi`
  (CoreGraphics). On refusal we deep-link the exact pane:
  `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`.
- **Relaunch**: after the user grants, macOS requires an app relaunch before the
  in-process preflight reports granted. The UI copy says so.
- **Unauthorized behavior** (verified on macOS 26): `screencapture` exits 1 with
  "could not create image from display" — it no longer silently captures a
  wallpaper-only image, so a permission gap can't produce a bogus "no QR found".
- **Dev builds**: TCC keys the grant to the *responsible process*. `bun dev`
  spawns the launcher from your terminal, so the grant lands on
  **Terminal/iTerm/WebStorm**, not "KeepKey Vault". Grant Screen Recording to
  your terminal once and every dev rebuild works — this also dodges the
  ad-hoc-signing problem where TCC grants die on each rebuild (the code
  directory hash changes). Prod builds are Developer ID signed with a stable
  identity, so the grant sticks.
- **macOS 15+ re-approval**: Sequoia/Tahoe periodically re-confirm screen
  recording grants ("KeepKey Vault can access your screen — continue to
  allow?"). Expected; one-shot capture needs no
  `com.apple.developer.persistent-content-capture` (that's Apple-approved,
  always-on capture apps only).

## Windows

No OS permission gate. Capture uses PowerShell `Graphics.CopyFromScreen` per
monitor. (WebView2 does support `getDisplayMedia`, but the native path keeps one
code path for all platforms.)

## Linux

First available tool wins: `grim` (Wayland), `gnome-screenshot`, `spectacle`,
`import` (X11/ImageMagick). Wayland compositors may show their own one-time
consent dialog. No tool installed → the UI shows an install hint.
