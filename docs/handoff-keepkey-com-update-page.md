# Handoff: keepkey.com "Update Your App" page + download handler

**For:** the keepkey.com agent
**From:** keepkey-vault, PR #284 (`fix/update-page-flow` → develop)
**Date:** 2026-06-22

## What changed in the vault (already done)

KeepKey Vault no longer sends users to the raw GitHub releases page when an update is
available. On **macOS and Windows** it now opens:

```
https://keepkey.com/update?os=<mac|windows|linux>&arch=<arm64|x64>&version=<latest>&current=<installed>
```

(Linux keeps its native in-app auto-updater and does **not** open the page.)

The vault also no longer shows a fake "Downloading…" bar for these platforms, because the
actual download now happens on your page / via your download handler.

### Query params the vault sends

| Param | Example | Meaning | Notes |
|-------|---------|---------|-------|
| `os` | `mac`, `windows`, `linux` | User's OS | Derived from `process.platform` (`darwin`→`mac`, `win32`→`windows`, else `linux`). |
| `arch` | `arm64`, `x64` | CPU arch | From `process.arch`. **Critical for macOS** (Apple Silicon vs Intel) and matters for Windows too. |
| `version` | `1.4.7` | Latest version the user should upgrade to | May be absent if the vault couldn't resolve it — handle gracefully. |
| `current` | `1.4.5` | Version currently installed | May be absent. Use for "you're on X, latest is Y" messaging + analytics. |

**Treat every param as untrusted/optional.** Validate against an allowlist; never echo raw into HTML
(XSS). If `os`/`arch` are missing or unknown, fall back to UA sniffing + show all download options.

## What we need you to build

### 1. The `/update` page

A dedicated "How to update your KeepKey Vault" page. Content:

1. **Step-by-step instructions** (the page's main job):
   - **Quit the old app first.** Vault uses port 1646 and a single device connection — two
     copies running will conflict. Make this step prominent and explicit.
   - Download the correct build (auto-selected from `os`+`arch`, see handler below).
   - Install: macOS = open DMG, drag to Applications, replace existing; Windows = run the
     signed `.exe` installer; Linux = (point at GitHub / package, Linux rarely lands here).
   - Reopen the app.
2. **Auto-detected primary download button** using `os`+`arch` → calls the GET handler in §2.
   Show the resolved target (e.g. "KeepKey Vault 1.4.7 for macOS (Apple Silicon)").
3. **"Other downloads" / manual list** for all OS+arch combos, in case detection is wrong or a
   user is on a different machine.
4. **What's new in this release** — pull release notes (see §3) so users know why to update.
5. **Support options** — link to support (help desk / Discord / Telegram / `support@keepkey.com`),
   and a "having trouble updating?" section.

### 2. The download GET handler (the important bit)

A stable endpoint that 302-redirects to the correct binary so the vault/page never hardcodes
asset filenames (which change every release):

```
GET https://keepkey.com/download?os=<mac|windows|linux>&arch=<arm64|x64>&version=<optional>
  → 302 redirect to the matching GitHub release asset
```

Behavior:
- If `version` omitted → resolve **latest** (respecting stable vs prerelease; default stable).
- Map `os`+`arch` → the right asset name pattern from the GitHub release. Current asset shapes
  (verify against an actual release before shipping — names drift):
  - macOS arm64: `*-arm64*.dmg` / Apple Silicon DMG
  - macOS x64: `*-x64*.dmg` / Intel DMG
  - Windows x64: `*-setup.exe` (signed installer, built on a separate Windows box)
  - Linux: tarball / AppImage as published
- Source of truth: GitHub releases for `keepkey/keepkey-vault`
  (`https://api.github.com/repos/keepkey/keepkey-vault/releases`). Cache the API response
  (rate limits: 60/hr unauthenticated — use a token or cache aggressively, e.g. 5–15 min).
- If no asset matches (unknown arch, asset not yet uploaded for a just-cut release) → redirect to
  the GitHub releases page as a safe fallback, don't 404.

### 3. Release notes / "what's new"

Pull from the GitHub release `body` for the resolved `version` (same API call as the handler).
Render markdown. Fall back to "See full changelog on GitHub" if empty.

## Gotchas / things not to miss

1. **arm64 vs x64 on macOS is the whole point.** Shipping an Intel build to Apple Silicon (or vice
   versa) "works" via Rosetta but is the #1 thing this flow exists to prevent. Get the arch mapping right
   and show the user which one they're getting so they can correct it.
2. **Windows installer is built/signed on a separate Windows box** and may lag a release by a bit.
   If the Windows asset isn't present for `version`, fall back to the latest version that *has* one,
   or to the releases page — don't hand users a 404.
3. **Quit-before-install must be loud.** Port 1646 + single USB/HID device claim means a stale old
   instance will break the new one. This is the most common "update didn't work" support ticket.
4. **macOS "app is damaged / unidentified developer"** — if a build's notarization is off, users hit
   Gatekeeper. Include a short troubleshooting note (right-click → Open, or the notarization is fine
   on signed builds). Confirm current builds are notarized before writing this.
5. **Prerelease channel.** The vault has a "Pre-release Updates" setting. Today the page link doesn't
   carry that flag, so `version` may be a prerelease tag while your "latest" default is stable. Honor
   the explicit `version` param when present; only fall back to stable-latest when it's absent.
6. **Param injection.** `os`/`arch`/`version`/`current` come from a URL — validate against allowlists,
   never interpolate into HTML/shell/redirect targets unescaped.
7. **No-JS / detection failure.** Always render the full manual download list so the page works even if
   `os`/`arch` are missing or JS is disabled.
8. **Linux generally won't arrive here** (native updater handles it), but the handler should still
   answer `os=linux` sanely for anyone who lands on the page directly.
9. **Stable deep link.** Keep `/update` and `/download` URLs permanent — they're now compiled into
   shipped vault binaries and old versions will keep hitting them for years. Don't rename.

## Release content to surface on the page (this release)

Ask the vault team / read the develop changelog for the current cut. Recent themes landing on
develop include: emulator Enable-Policy confirm fix, idempotent device pairing (auth churn fix),
swap side-panel + KeepKey Swap rebrand, portfolio fault-tolerance banners, Zcash NU6.2 fixes,
custom TX fees. Pull the actual GitHub release notes for the published `version` rather than
hardcoding — see §3.

## Quick reference

- Repo for releases/assets: `keepkey/keepkey-vault`
- Vault opens: `https://keepkey.com/update?os=…&arch=…&version=…&current=…`
- Needed: `https://keepkey.com/update` (page) + `https://keepkey.com/download?os=…&arch=…&version=…` (302 handler)
- Vault PR implementing the client side: keepkey/keepkey-vault#284
