# ALPHA-6 Test Retrospective — 2026-03-21

Branch: `release-cycle` @ commit `34b95b1` + local em-dash fix
Version: 1.2.6
Machine: Windows 11 Home 10.0.26200

---

## ALPHA-6 RESULTS: PASS

```
1. Did device-protocol build succeed? ALREADY EXISTED (copied from hdwallet nm)
2. Did collect-externals confirm messages_pb.js present? YES
3. Is messages_pb.js in the installed app? YES
4. Did the installer finish? YES
5. Did a window appear? YES
6. MainWindowHandle: 461552
7. app.log has content? YES — loading index.js, index.css, asset-data.js, splash-bg.png, icon.png
8. backend.log has content? YES — full boot sequence through 16 stages + engine init
9. Was com.keepkey.vault created? YES
```

**First successful Windows launch since the release-cycle branch began.**

---

## Boot Timing (Hard Metrics)

All times from `[PERF]` markers in backend.log. T=0 is BrowserWindow creation.

| Milestone | Time | Delta |
|-----------|------|-------|
| BrowserWindow creation | +0ms | — |
| Window created, deferred init starts | +109ms | 109ms |
| deferredInit start | +110ms | 1ms |
| DB + chains loaded | +120ms | 10ms |
| REST API applied, engine starting | +121ms | 1ms |
| Firmware manifest fetched | +313ms | 192ms (network) |
| WebUSB device scan complete | +803ms | 490ms |
| Device paired | +1565ms | 762ms |
| Device features read | +2303ms | 738ms |
| Engine started | +2304ms | 1ms |
| **Boot complete** | **+2305ms** | 1ms |
| Update check complete | +7787ms | 5482ms (network) |

### Import Phase (before window)

All 16 import stages completed in **3ms** (04:30:54.911 to 04:30:54.914).
This is not the bottleneck.

### Breakdown

| Phase | Duration | % of Boot |
|-------|----------|-----------|
| Imports (16 stages) | 3ms | 0.1% |
| BrowserWindow creation | 109ms | 4.7% |
| DB + chains | 10ms | 0.4% |
| Network (firmware manifest) | 192ms | 8.3% |
| USB device scan | 490ms | 21.3% |
| Device pairing | 762ms | 33.1% |
| Device features/init | 738ms | 32.0% |
| Overhead | 1ms | 0.0% |
| **Total to boot complete** | **2305ms** | **100%** |

### Where the Time Goes

**65% is USB/device communication** (scan + pair + init = 1990ms).
This is hardware I/O — irreducible unless we defer it.

**8% is network** (firmware manifest fetch). Could be deferred or cached.

**5% is window creation** (109ms). Electrobun + WebView2 init.

**0.4% is DB/chains** (10ms). Fast.

**0.1% is imports** (3ms). Negligible.

### Comparison to Demo App

The demo app opens in ~95ms (ALPHA-4: BrowserWindow created at +94ms).
The Vault's window appears at +109ms — only 15ms slower. The perceived
slowness is not window creation but the time between window appearing
and the UI being interactive (waiting for engine/device).

---

## Issues Found and Fixed During ALPHA-6

### 1. PowerShell 5 UTF-8 Parse Failure (FIXED)

`build-windows-production.ps1` contained em-dash characters (U+2014,
`\xe2\x80\x94`) in comments. PowerShell 5 defaults to ANSI encoding
when parsing `.ps1` files and chokes on UTF-8 multi-byte characters,
producing:

```
Missing closing '}' in statement block or type definition.
```

**Fix**: Replaced all em-dashes (`—`) with ASCII double-hyphens (`--`)
in the script. 8 occurrences fixed.

### 2. device-protocol/lib/ Missing (FIXED in prior commit)

`collect-externals.ts` now verifies `messages_pb.js` is present after
copy and fails fatally if missing. The production build script also
inits the device-protocol submodule and attempts to build it.

On this Windows machine, `protoc-gen-js` is not available, so the
build step fails. Workaround: copy `lib/` from
`modules/hdwallet/node_modules/@keepkey/device-protocol/lib/` which
has pre-built protobuf output from `yarn install`.

---

## Optimization Recommendations

### Quick wins (no architecture changes)

1. **Defer firmware manifest fetch** — Don't block boot on network.
   Load cached manifest, update in background. Saves ~192ms.

2. **Defer USB scan until after window paint** — Show the splash/UI
   first, then scan for device. Saves perceived 490ms.

3. **Cache firmware manifest to disk** — Skip network entirely on
   subsequent boots if cache is <1hr old.

### Medium effort

4. **Parallel USB scan + window creation** — Start USB scan before
   BrowserWindow is created. The 109ms window creation overlaps
   with the 490ms USB scan.

5. **Lazy device init** — Don't call `initializeDevice()` until
   the user needs it. Show "Searching for device..." in UI while
   scanning in background.

### Vault vs Demo comparison

| Metric | Demo | Vault | Delta |
|--------|------|-------|-------|
| Window visible | ~95ms | ~109ms | +14ms |
| Boot complete | ~95ms | ~2305ms | +2210ms |
| Cause of delta | — | USB/device I/O | 96% |

The window creation speed is essentially identical. The perceived
slowness is entirely device I/O that happens after window creation.

---

## Over-Install Test (STEP 19)

Not yet performed. Window appeared on fresh install — should proceed
with over-install test next.
