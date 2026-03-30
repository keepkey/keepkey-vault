# macOS 12 / Intel Validation

This document is the release checklist for the macOS 12 Intel support path.

The goal is to catch the two known regressions without requiring a physical macOS 12 Intel machine:

1. `bun` missing JIT entitlements, which causes an immediate crash before the app boots.
2. A bad `libNativeWrapper.dylib` provenance path, which can reintroduce the `safe_resignKeyWindow` crash on focus changes.

## Required Provenance

The x86_64 Electrobun runtime must come from an approved fork artifact, not the default upstream `blackboardsh/electrobun` release tarball.

Configure CI with:

```text
ELECTROBUN_X64_CORE_URL
ELECTROBUN_X64_CORE_SHA256
```

`ELECTROBUN_X64_CORE_SHA256` should be the checksum of the exact tarball used to source:

- `launcher`
- `bun`
- `libNativeWrapper.dylib`
- `libasar.dylib`

If those variables are not configured, CI intentionally skips the x64 variant rather than publishing an unverified Intel artifact.

## Static Validation From An Artifact

These checks work on an extracted `.app.tar.zst` or `.dmg` output.

### 1. Extract the app

```bash
TAR_ZST=projects/keepkey-vault/artifacts/stable-macos-x64-keepkey-vault.app.tar.zst
WORK=$(mktemp -d)
zstd -d "$TAR_ZST" -o "$WORK/app.tar" --force
tar xf "$WORK/app.tar" -C "$WORK/"
APP=$(find "$WORK" -maxdepth 1 -name "*.app" | head -1)
```

### 2. Confirm version metadata

```bash
defaults read "$APP/Contents/Info" CFBundleShortVersionString
cat "$APP/Contents/Resources/version.json"
```

Expected release value: `1.2.11`

### 3. Confirm architecture

```bash
for BIN in launcher bun libNativeWrapper.dylib libasar.dylib; do
  TARGET=$(find "$APP" -name "$BIN" -type f | head -1)
  [ -n "$TARGET" ] && echo "$BIN: $(lipo -archs "$TARGET")"
done
```

Expected for Intel artifact: every listed binary reports `x86_64`.

### 4. Confirm Bun entitlements

```bash
codesign -d --entitlements :- "$APP/Contents/MacOS/bun" 2>/dev/null
codesign -d --entitlements :- "$APP/Contents/MacOS/launcher" 2>/dev/null
```

Both outputs must include:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`
- `com.apple.security.cs.allow-dyld-environment-variables`

If `bun` does not show the JIT entitlements, the artifact is not releasable.

### 5. Confirm codesign validity

```bash
codesign --verify --deep --strict "$APP"
spctl -a -vv "$APP"
```

### 6. Confirm Intel bundle policy

```bash
find "$APP" -name "zcash-cli" -type f
```

Expected for the Intel artifact: no result.

## CI Expectations

The macOS workflow should:

1. Build the ARM64 artifact.
2. Prune and re-sign the app bundle.
3. Create the x64 variant only from `ELECTROBUN_X64_CORE_URL`.
4. Verify the downloaded tarball against `ELECTROBUN_X64_CORE_SHA256`.
5. Verify `launcher`, `bun`, `libNativeWrapper.dylib`, and `libasar.dylib` are all `x86_64`.
6. Verify `bun` entitlements in the swapped x64 app before packaging.

## If A macOS 12 Intel Machine Is Available

Do one manual smoke test before release:

1. Launch app.
2. Connect device and reach main dashboard.
3. Background and refocus app several times.
4. Open QR scanner and a second window if relevant.

If the app loses focus without crashing and boots cleanly, that validates the runtime path that static checks cannot fully prove.
