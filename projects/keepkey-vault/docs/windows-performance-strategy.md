# Windows Performance Strategy

## The Problem

First launch on Windows takes 56 seconds. Second launch takes 1.1 seconds.
The delta is Windows Defender scanning 13,332 files (67MB) in `node_modules/`
the first time bun.exe opens them. Defender caches results, so subsequent
launches are fast.

## Current State (v1.2.6)

| Metric | Value |
|--------|-------|
| Files in bundle | 13,332 |
| JS files | 10,180 |
| Native .node binaries | 5 |
| Bundle size | 67 MB |
| First launch (Defender cold) | ~56s |
| Second launch (Defender warm) | ~1.1s |
| Time in our code (imports) | 3ms |
| Time in device I/O | 2s |

## Quick Wins (Shipped in This PR)

### 1. Strip unused swagger ecosystem from bundle

swagger-client pulls in the entire `@swagger-api` ecosystem — parsers for
AsyncAPI, API Design Systems, Arazzo, OpenAPI 2/3.1/3.2, JSON Schema drafts
4/6/7/2019/2020, YAML adapters. We only use OpenAPI 3.0 JSON.

**Blocked from collection**: 30 unused `@swagger-api` packages added to
`DEV_BLOCKLIST` so they're never collected.

**Stripped from bundle**: 6 spec-version packages + `web-streams-polyfill` +
`types-ramda` added to `STRIP_DIRS`.

**Estimated impact**: ~1,500 fewer files, ~5MB smaller bundle.

### 2. Strip web-streams-polyfill

Bun has native `ReadableStream`/`WritableStream`. The polyfill (2.7MB) is
never used at runtime.

### 3. Strip types-ramda

TypeScript type definitions. Not needed at runtime.

## Medium-Term Optimizations (Future PRs)

### 4. Replace pioneer-client with thin fetch wrapper

`@pioneer-platform/pioneer-client` exists to parse a swagger spec at runtime
and generate an API client. This pulls in swagger-client + the entire
@swagger-api ecosystem (~13MB, ~3500 files).

A hand-written fetch wrapper that calls the 5-6 Pioneer API endpoints we
actually use would eliminate this entire dependency tree. The swagger spec
is stable and rarely changes.

**Impact**: ~3,500 fewer files, ~16MB smaller bundle.

### 5. Pre-bundle pure-JS externals

Use `bun build --target=bun` to compile the 286 external packages into a
single `vendor.js` file. Native `.node` binaries stay as individual files.

**Impact**: ~10,000 JS files become 1 file. Defender scans 1 file instead
of 10,000. First launch from ~40s to ~5-8s estimated.

**Risk**: Changes how `require()` resolves at runtime. Needs thorough testing.

### 6. Split app into bootstrap + feature packs

Separate entry points:
- `bootstrap.js`: logger, config, window creation (~10 files)
- `core.js`: engine, db, auth, chains (~50 files)
- `features.js`: txbuilder, reports, camera, zcash (~200 files)

Electrobun loads bootstrap first, defers the rest.

**Risk**: Requires Electrobun changes or custom Worker-based loading.

## Long-Term (Architectural)

### 7. Vendor or replace ramda/ramda-adjunct

ramda (3.3MB) + ramda-adjunct (3.8MB) are utility libraries used by
swagger-client. If we replace pioneer-client (#4), these go away too.

### 8. Flatten osmojs/cosmjs-types

osmojs (3.5MB) + cosmjs-types (2.1MB) ship large proto directories.
Many are unused. Could be vendored with only the message types we need.

## Decision Matrix

| Optimization | Files Saved | Size Saved | Risk | Effort |
|--------------|------------|------------|------|--------|
| Strip unused swagger (this PR) | ~1,500 | ~5MB | Low | Done |
| Replace pioneer-client | ~3,500 | ~16MB | Medium | 1-2 days |
| Pre-bundle externals | ~10,000 | 0 (same bytes) | High | 2-3 days |
| Bootstrap split | ~10,000 | 0 | High | 3-5 days |
| Vendor cosmjs/osmojs | ~500 | ~5MB | Medium | 1 day |
