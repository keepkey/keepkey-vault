# Investigation: Windows Build Failures — Electrobun Upgrade Required

**Date**: 2026-03-21
**Status**: Root cause identified
**Action**: Upgrade electrobun from 1.13.1 → 1.16.0

## Problem

Fresh installs of KeepKey Vault v1.2.4 and v1.2.5 on Windows fail to open a window.
The bun + launcher processes start, the Zig splash screen shows, but the WebView2
window never appears. `app.log` remains empty — `startEventLoop` in `libNativeWrapper.dll`
hangs before initializing logging.

Hot-patching new backend code into an existing v1.2.3 install works because the v1.2.3
install has a `libNativeWrapper.dll` and `main.js` from an earlier build where the
preload script injection was coincidentally working.

## Root Cause

**Electrobun Issue #210**: On Windows, the `nativeWrapper.cpp` fails to resolve `views://`
URLs in the preload script during WebView2 initialization. Instead of loading the file
content (like macOS does via `readViewsFile()`), the Windows code injects the literal
URL string `views://bridge/rpc-bridge.js` into the JavaScript context, causing:

```
SyntaxError: Unexpected end of input index.html:597
```

This means `window.__electrobun` is undefined → RPC bridge never initializes → window
creation appears to hang (the WebView2 loads but can't communicate with the bun backend).

**Fix**: PR #224 (merged into electrobun v1.15.x) applies the same URL resolution pattern
on Windows using `loadViewsFile()`.

## Our Version Gap

| Version | Status |
|---------|--------|
| **1.13.1** (our current) | Has the Windows preload bug |
| 1.14.4 | Bug reported (Issue #210) |
| **1.15.1** | Fix merged (PR #224) |
| **1.16.0** (latest) | Additional Windows fixes for HTML rendering, wgpu |

### Windows-specific fixes between 1.13.1 and 1.16.0:

- `1e979719` Fix Windows preload script views:// URL not resolved to file content
- `c96e9ab4` Fix Windows inline HTML rendering
- `cce84a7a` Fix HTML rendering on webview2 on Windows
- `b37543a9` Fix wgpu on Windows when bundleCEF: false
- `177a36de` Fix wgpu edge cases on Windows
- `4d0609fc` Add no-op stubs for setVisibleOnAllWorkspaces on Windows and Linux
- `848dc8ed` Support `false` in chromiumFlags to skip default flags

## Why v1.2.3 Worked

v1.2.3 was built and installed weeks ago when the WebView2 user data profile was fresh.
The preload script injection bug exists in 1.13.1 but may manifest non-deterministically:
- Works when the preload is cached in the WebView2 profile from a prior successful launch
- Fails on fresh installs or when the profile is cleared/corrupted
- Once it works once, subsequent launches may succeed from cache

This explains the "non-deterministic" window creation we documented in the skill.

## Recommended Fix

1. Upgrade electrobun: `bun add electrobun@1.16.0` (in projects/keepkey-vault)
2. Test fresh install on Windows 10 and 11
3. Verify the `metadata.json` generation still works (may not be needed with newer electrobun)
4. Rebuild and re-sign v1.2.5

## Risk Assessment

- **Medium risk**: Electrobun 1.13.1 → 1.16.0 is a significant jump (3 minor versions)
- Multiple Windows fixes are included, which is exactly what we need
- May introduce new APIs or breaking changes — needs testing
- macOS and Linux should be unaffected (most fixes are Windows-specific)

## References

- [Electrobun Issue #210: Preload script injection truncated](https://github.com/blackboardsh/electrobun/issues/210)
- [Electrobun PR #224: Fix Windows preload views:// URL resolution](https://github.com/blackboardsh/electrobun/pull/224)
- [Electrobun Releases](https://github.com/blackboardsh/electrobun/releases)
- [WebView2 Feedback #4884: Integrity level issues](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4884)
