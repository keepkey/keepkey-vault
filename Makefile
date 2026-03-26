PROJECT_DIR := projects/keepkey-vault
VERSION := $(shell grep '"version"' $(PROJECT_DIR)/package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
ARCH := $(shell uname -m)
DMG_NAME := KeepKey-Vault-$(VERSION)-$(ARCH).dmg
STAMP_DIR := .make
SUBMODULES_STAMP := $(STAMP_DIR)/submodules.stamp
PROTO_INSTALL_STAMP := $(STAMP_DIR)/proto-install.stamp
HDWALLET_INSTALL_STAMP := $(STAMP_DIR)/hdwallet-install.stamp
HDWALLET_BUILD_STAMP := $(STAMP_DIR)/hdwallet-build.stamp
VAULT_INSTALL_STAMP := $(STAMP_DIR)/vault-install.stamp
HDWALLET_BUILD_INPUTS := $(shell find modules/hdwallet/packages -type f \( -name '*.ts' -o -name '*.tsx' -o -name 'package.json' -o -name 'tsconfig.json' \))
PROTO_BUILD_STAMP := $(STAMP_DIR)/proto-build.stamp
PROTO_BUILD_INPUTS := $(shell find modules/proto-tx-builder/src -type f \( -name '*.ts' -o -name '*.js' \) 2>/dev/null) modules/proto-tx-builder/tsconfig.json
ZCASH_CLI_STAMP := $(STAMP_DIR)/zcash-cli.stamp
ZCASH_CLI_SOURCES := $(shell find $(PROJECT_DIR)/zcash-cli/src -name '*.rs' 2>/dev/null) $(PROJECT_DIR)/zcash-cli/Cargo.toml

# Auto-load .env if present (only export signing-related vars to sub-processes)
ifneq (,$(wildcard .env))
include .env
export ELECTROBUN_DEVELOPER_ID ELECTROBUN_TEAMID ELECTROBUN_APPLEID ELECTROBUN_APPLEIDPASS
endif

.PHONY: install dev dev-hmr build build-stable build-canary build-signed prune-bundle dmg clean help vault sign-check verify publish release upload-dmg upload-all-dmgs sign-release verify-arch submodules modules-install modules-build modules-clean audit build-zcash-cli build-zcash-cli-debug build-zcash-cli-intel test test-unit test-rest test-zcash-cli build-intel build-signed-intel

# --- Submodules (auto-init on fresh worktrees/clones) ---

$(STAMP_DIR):
	@mkdir -p $(STAMP_DIR)

$(SUBMODULES_STAMP): .gitmodules | $(STAMP_DIR)
	@git submodule update --init
	@touch $@

submodules: $(SUBMODULES_STAMP)

# --- Module Builds (hdwallet + proto-tx-builder from source) ---

$(PROTO_INSTALL_STAMP): modules/proto-tx-builder/package.json modules/proto-tx-builder/yarn.lock $(SUBMODULES_STAMP) | $(STAMP_DIR)
	cd modules/proto-tx-builder && bun install
	@# Init the nested osmosis-frontend submodule (provides Cosmos/Osmosis proto codegen)
	cd modules/proto-tx-builder && git submodule update --init osmosis-frontend
	@touch $@

$(PROTO_BUILD_STAMP): $(PROTO_BUILD_INPUTS) $(PROTO_INSTALL_STAMP) | $(STAMP_DIR)
	@echo "=== proto-tx-builder: building ==="
	cd modules/proto-tx-builder && npx tsc -p .
	@test -f modules/proto-tx-builder/dist/index.js || (echo "ERROR: proto-tx-builder/dist/index.js missing after build"; exit 1)
	@touch $@

$(HDWALLET_INSTALL_STAMP): modules/hdwallet/package.json modules/hdwallet/yarn.lock $(SUBMODULES_STAMP) | $(STAMP_DIR)
	cd modules/hdwallet && yarn install
	@touch $@

modules-install: $(PROTO_INSTALL_STAMP) $(HDWALLET_INSTALL_STAMP)

$(HDWALLET_BUILD_STAMP): modules/hdwallet/tsconfig.json $(HDWALLET_BUILD_INPUTS) $(HDWALLET_INSTALL_STAMP) | $(STAMP_DIR)
	cd modules/hdwallet && yarn tsc --build
	@touch $@

modules-build: $(HDWALLET_BUILD_STAMP) $(PROTO_BUILD_STAMP)

modules-clean:
	cd modules/proto-tx-builder && rm -rf dist node_modules
	cd modules/hdwallet && yarn clean 2>/dev/null || (rm -rf packages/*/dist node_modules)
	rm -rf $(STAMP_DIR)

# --- Zcash CLI Sidecar (Rust) ---
# The stamp tracks source changes — rebuild + retest only when .rs or Cargo.toml change.
# FAIL FAST: cargo test runs BEFORE the binary is considered ready.

$(ZCASH_CLI_STAMP): $(ZCASH_CLI_SOURCES) | $(STAMP_DIR)
	@echo "=== Zcash CLI: testing ==="
	cd $(PROJECT_DIR)/zcash-cli && cargo test
	@echo "=== Zcash CLI: building (release) ==="
	cd $(PROJECT_DIR)/zcash-cli && cargo build --release
ifdef ELECTROBUN_DEVELOPER_ID
	@echo "Signing zcash-cli binary..."
	codesign --force --verbose --timestamp \
		--sign "Developer ID Application: $(ELECTROBUN_DEVELOPER_ID) ($(ELECTROBUN_TEAMID))" \
		--options runtime \
		$(PROJECT_DIR)/zcash-cli/target/release/zcash-cli
endif
	@touch $@

build-zcash-cli: $(ZCASH_CLI_STAMP)

test-zcash-cli:
	cd $(PROJECT_DIR)/zcash-cli && cargo test

build-zcash-cli-debug:
	cd $(PROJECT_DIR)/zcash-cli && cargo test
	cd $(PROJECT_DIR)/zcash-cli && cargo build

# Cross-compile zcash-cli for Intel Mac from Apple Silicon
build-zcash-cli-intel:
	@echo "=== Zcash CLI: cross-compiling for x86_64-apple-darwin ==="
	cd $(PROJECT_DIR)/zcash-cli && cargo build --release --target x86_64-apple-darwin
ifdef ELECTROBUN_DEVELOPER_ID
	@echo "Signing zcash-cli (Intel) binary..."
	codesign --force --verbose --timestamp \
		--sign "Developer ID Application: $(ELECTROBUN_DEVELOPER_ID) ($(ELECTROBUN_TEAMID))" \
		--options runtime \
		$(PROJECT_DIR)/zcash-cli/target/x86_64-apple-darwin/release/zcash-cli
endif
	@echo "=== Intel zcash-cli ready at $(PROJECT_DIR)/zcash-cli/target/x86_64-apple-darwin/release/zcash-cli ==="

# --- Architecture Verification ---
# Verify that the binaries in the tar.zst match the expected architecture.
# Prevents mislabeled DMGs (e.g. ARM64 binaries in an x86_64-named DMG).
# Usage: make verify-arch                    (auto-detects from uname -m)
#        make verify-arch EXPECTED_ARCH=x86_64  (explicit override)
EXPECTED_ARCH ?= $(ARCH)

verify-arch:
	@echo "Verifying artifact architecture (expecting $(EXPECTED_ARCH))..."
	@TAR_ZST=$$(find $(PROJECT_DIR)/artifacts -name "*.app.tar.zst" | head -1); \
	if [ -z "$$TAR_ZST" ]; then echo "ERROR: No .app.tar.zst found in artifacts/"; exit 1; fi; \
	TMPDIR=$$(mktemp -d); \
	trap 'rm -rf "$$TMPDIR"' EXIT; \
	zstd -d "$$TAR_ZST" -o "$$TMPDIR/app.tar" --force 2>/dev/null; \
	LAUNCHER=$$(tar tf "$$TMPDIR/app.tar" | grep "MacOS/launcher$$" | head -1); \
	BUN_BIN=$$(tar tf "$$TMPDIR/app.tar" | grep "MacOS/bun$$" | head -1); \
	if [ -z "$$LAUNCHER" ]; then echo "ERROR: No launcher binary found in archive"; exit 1; fi; \
	tar xf "$$TMPDIR/app.tar" -C "$$TMPDIR/" "$$LAUNCHER"; \
	if [ -n "$$BUN_BIN" ]; then tar xf "$$TMPDIR/app.tar" -C "$$TMPDIR/" "$$BUN_BIN"; fi; \
	FAIL=0; \
	for BIN in "$$TMPDIR/$$LAUNCHER" "$$TMPDIR/$$BUN_BIN"; do \
		[ -f "$$BIN" ] || continue; \
		ACTUAL=$$(lipo -archs "$$BIN" 2>/dev/null); \
		NAME=$$(basename "$$BIN"); \
		echo "  $$NAME: $$ACTUAL"; \
		if [ "$$ACTUAL" != "$(EXPECTED_ARCH)" ]; then \
			echo ""; \
			echo "ERROR: Architecture mismatch! $$NAME is $$ACTUAL but expected $(EXPECTED_ARCH)"; \
			FAIL=1; \
		fi; \
	done; \
	if [ "$$FAIL" = "1" ]; then \
		echo ""; \
		echo "The artifact contains binaries for the wrong architecture."; \
		echo "Use CI macOS runners for correct architecture builds:"; \
		echo "  macos-13 → x86_64 (Intel)"; \
		echo "  macos-14 → arm64  (Apple Silicon)"; \
		echo ""; \
		echo "To sign CI-built artifacts locally: make sign-release"; \
		exit 1; \
	fi; \
	echo "Architecture verified: $(EXPECTED_ARCH)"

# --- Intel Mac Build (DEPRECATED) ---
# WARNING: arch -x86_64 does NOT make Bun/Electrobun produce x86_64 output.
# Bun is ARM64-only — the resulting binary will STILL be ARM64 regardless.
# Use CI (macos-13 runner) for real Intel builds, then sign locally with:
#   make sign-release
INTEL_DMG_NAME := KeepKey-Vault-$(VERSION)-x86_64.dmg

build-intel:
	@echo ""
	@echo "ERROR: build-intel is DEPRECATED and does NOT produce x86_64 binaries."
	@echo ""
	@echo "Bun and Electrobun are ARM64-only on Apple Silicon. The arch -x86_64"
	@echo "wrapper has no effect — the output is still ARM64, just mislabeled."
	@echo ""
	@echo "For real Intel Mac builds:"
	@echo "  1. Push to a release/* branch or v* tag (CI creates draft release)"
	@echo "     Or trigger manually:  gh workflow run build.yml"
	@echo "  2. Sign the CI artifacts locally:  make sign-release"
	@echo ""
	@exit 1

build-signed-intel:
	@echo ""
	@echo "ERROR: build-signed-intel is DEPRECATED. See 'make build-intel' for details."
	@echo "Use:  make sign-release"
	@echo ""
	@exit 1

# --- Vault ---

$(VAULT_INSTALL_STAMP): $(PROJECT_DIR)/package.json $(PROJECT_DIR)/scripts/patch-electrobun.sh $(PROTO_BUILD_STAMP) $(HDWALLET_BUILD_STAMP) | $(STAMP_DIR)
	cd $(PROJECT_DIR) && bun install
	@touch $@

install: $(VAULT_INSTALL_STAMP)

vault: install $(ZCASH_CLI_STAMP) dev

dev: install $(ZCASH_CLI_STAMP)
	cd $(PROJECT_DIR) && bun run dev

dev-hmr: install $(ZCASH_CLI_STAMP)
	-lsof -ti :5177 | xargs kill -9 2>/dev/null || true
	-pkill -f "electrobun dev" 2>/dev/null || true
	cd $(PROJECT_DIR) && bun run dev:hmr

build: install build-zcash-cli
	cd $(PROJECT_DIR) && bun run build

build-stable: install build-zcash-cli
	cd $(PROJECT_DIR) && bun run build:stable

build-canary: install
	cd $(PROJECT_DIR) && bun run build:canary

# Prune the app bundle after Electrobun build (strips nested node_modules, .d.ts, etc.)
prune-bundle:
	cd $(PROJECT_DIR) && bun scripts/prune-app-bundle.ts

# Full signed build: electrobun build → audit → prune → extract from tar → create DMG → sign + notarize + staple
# Force-clear zcash-cli stamp so it gets re-signed with Developer ID (stamp may be stale from unsigned build)
build-signed: sign-check
	@rm -f $(ZCASH_CLI_STAMP)
	$(MAKE) build-stable audit prune-bundle dmg
	@echo ""
	@echo "=== Build complete ==="
	@echo "DMG: $(PROJECT_DIR)/artifacts/$(DMG_NAME)"
	@ls -lh $(PROJECT_DIR)/artifacts/$(DMG_NAME)

# Create a proper DMG from the fully-extracted app (workaround for Electrobun self-extractor bug)
dmg: verify-arch
	@echo "Creating DMG from tar.zst artifact..."
	@TAR_ZST=$$(find $(PROJECT_DIR)/artifacts -name "*.app.tar.zst" | head -1); \
	if [ -z "$$TAR_ZST" ]; then echo "ERROR: No .app.tar.zst found in artifacts/"; exit 1; fi; \
	STAGING=$$(mktemp -d); \
	trap 'rm -rf "$$STAGING"' EXIT; \
	echo "Extracting app from $$TAR_ZST..."; \
	zstd -d "$$TAR_ZST" -o "$$STAGING/app.tar" --force; \
	tar xf "$$STAGING/app.tar" -C "$$STAGING/"; \
	rm "$$STAGING/app.tar"; \
	APP=$$(find "$$STAGING" -name "*.app" -maxdepth 1 | head -1); \
	if [ -z "$$APP" ]; then echo "ERROR: No .app found after extraction"; exit 1; fi; \
	echo "Verifying extracted app..."; \
	codesign --verify --deep --strict "$$APP" || (echo "ERROR: codesign verification failed"; exit 1); \
	ln -s /Applications "$$STAGING/Applications"; \
	DMG_OUT="$$(pwd)/$(PROJECT_DIR)/artifacts/$(DMG_NAME)"; \
	rm -f "$$DMG_OUT"; \
	echo "Creating DMG..."; \
	hdiutil create -volname "KeepKey Vault" -srcfolder "$$STAGING" -ov -format UDZO "$$DMG_OUT"; \
	echo "Signing DMG..."; \
	codesign --force --timestamp --sign "Developer ID Application: $$ELECTROBUN_DEVELOPER_ID ($$ELECTROBUN_TEAMID)" "$$DMG_OUT"; \
	echo "Notarizing DMG..."; \
	ZIP_TMP=$$(mktemp).zip; \
	(cd "$$(dirname "$$DMG_OUT")" && zip -q "$$ZIP_TMP" "$$(basename "$$DMG_OUT")"); \
	xcrun notarytool submit --apple-id "$$ELECTROBUN_APPLEID" --password "$$ELECTROBUN_APPLEIDPASS" --team-id "$$ELECTROBUN_TEAMID" --wait "$$ZIP_TMP"; \
	rm -f "$$ZIP_TMP"; \
	echo "Stapling notarization ticket..."; \
	xcrun stapler staple "$$DMG_OUT"; \
	echo "DMG ready: $$DMG_OUT"

# --- Testing ---

test: test-zcash-cli test-unit

test-unit:
	cd $(PROJECT_DIR) && bun test __tests__/swap-parsing.test.ts __tests__/engine-state-machine.test.ts __tests__/wizard-messaging.test.ts

test-integration: test-rest

test-rest:
	cd $(PROJECT_DIR) && bun test __tests__/rest-api.test.ts

clean: modules-clean
	cd $(PROJECT_DIR) && rm -rf dist node_modules build _build artifacts

# --- Audit & SBOM ---

audit:
	cd $(PROJECT_DIR) && bun scripts/audit-deps.ts

# --- Code Signing ---

sign-check:
	@echo "Checking signing environment..."
	@test -n "$$ELECTROBUN_DEVELOPER_ID" || (echo "ERROR: ELECTROBUN_DEVELOPER_ID not set" && exit 1)
	@test -n "$$ELECTROBUN_TEAMID" || (echo "ERROR: ELECTROBUN_TEAMID not set" && exit 1)
	@test -n "$$ELECTROBUN_APPLEID" || (echo "ERROR: ELECTROBUN_APPLEID not set" && exit 1)
	@test -n "$$ELECTROBUN_APPLEIDPASS" || (echo "ERROR: ELECTROBUN_APPLEIDPASS not set" && exit 1)
	@echo "All signing env vars present."
	@echo "  DEVELOPER_ID: $$ELECTROBUN_DEVELOPER_ID"
	@echo "  TEAM_ID:      $$ELECTROBUN_TEAMID"
	@echo "  APPLE_ID:     $$ELECTROBUN_APPLEID"
	@security find-identity -v -p codesigning | grep "$$ELECTROBUN_DEVELOPER_ID" || echo "WARNING: Certificate not found in keychain"

verify:
	@APP=$$(find $(PROJECT_DIR)/_build -name "*.app" -maxdepth 2 | head -1); \
	if [ -z "$$APP" ]; then echo "No .app bundle found in _build/"; exit 1; fi; \
	echo "Verifying: $$APP"; \
	echo "--- codesign ---"; \
	codesign --verify --deep --strict "$$APP" && echo "codesign: PASS" || echo "codesign: FAIL"; \
	echo "--- spctl (Gatekeeper) ---"; \
	spctl --assess --type exec "$$APP" && echo "spctl: PASS" || echo "spctl: FAIL"; \
	echo "--- entitlements ---"; \
	codesign -d --entitlements :- "$$APP" 2>/dev/null || echo "(no entitlements found)"

# --- Publishing ---

GITHUB_REPO ?= keepkey/keepkey-vault

publish:
	@echo "Artifacts:"
	@ls -lh $(PROJECT_DIR)/artifacts/$(DMG_NAME) 2>/dev/null || echo "No DMG found. Run 'make build-signed' first."

# Upload signed macOS DMG to existing CI-created draft release
upload-dmg: sign-check
	@echo "Uploading signed DMG to draft release v$(VERSION)..."
	@test -f $(PROJECT_DIR)/artifacts/$(DMG_NAME) || (echo "ERROR: DMG not found. Run 'make build-signed' first." && exit 1)
	@echo "Checking for existing draft release v$(VERSION)..."
	@gh release view v$(VERSION) --repo $(GITHUB_REPO) >/dev/null 2>&1 || \
		(echo "ERROR: No release v$(VERSION) found. Wait for CI to create the draft, or run 'make release' to create one." && exit 1)
	gh release upload v$(VERSION) \
		--repo $(GITHUB_REPO) \
		--clobber \
		$(PROJECT_DIR)/artifacts/$(DMG_NAME)
	@UPDATE_JSON=$$(ls $(PROJECT_DIR)/artifacts/stable-*-update.json 2>/dev/null | head -1); \
	TAR_ZST=$$(ls $(PROJECT_DIR)/artifacts/stable-*-keepkey-vault.app.tar.zst 2>/dev/null | head -1); \
	if [ -n "$$UPDATE_JSON" ]; then gh release upload v$(VERSION) --repo $(GITHUB_REPO) --clobber "$$UPDATE_JSON"; fi; \
	if [ -n "$$TAR_ZST" ]; then gh release upload v$(VERSION) --repo $(GITHUB_REPO) --clobber "$$TAR_ZST"; fi
	@echo "DMG uploaded to https://github.com/$(GITHUB_REPO)/releases/tag/v$(VERSION)"

# Full release: build signed + create new GitHub release (if CI hasn't already)
release: sign-check build-signed
	@echo "Creating GitHub release v$(VERSION)..."
	@test -f $(PROJECT_DIR)/artifacts/$(DMG_NAME) || (echo "ERROR: DMG not found: $(DMG_NAME)" && exit 1)
	@UPDATE_JSON=$$(ls $(PROJECT_DIR)/artifacts/stable-*-update.json 2>/dev/null | head -1); \
	TAR_ZST=$$(ls $(PROJECT_DIR)/artifacts/stable-*-keepkey-vault.app.tar.zst 2>/dev/null | head -1); \
	if [ -z "$$UPDATE_JSON" ] || [ -z "$$TAR_ZST" ]; then \
		echo "WARNING: Missing update artifacts (update.json or tar.zst) — release will not support auto-updates"; \
	fi; \
	gh release create v$(VERSION) \
		--repo $(GITHUB_REPO) \
		--title "KeepKey Vault v$(VERSION)" \
		--generate-notes \
		$(PROJECT_DIR)/artifacts/$(DMG_NAME) \
		$$UPDATE_JSON $$TAR_ZST
	@echo "Release v$(VERSION) published to $(GITHUB_REPO)"

# Sign CI-built macOS artifacts and upload to draft release.
# Downloads both arm64 and x64 tar.zst from CI, signs all binaries,
# re-packs signed tar.zst (auto-update), creates DMGs, notarizes, and uploads.
# Requires: draft release v$(VERSION) created by CI (push to release/* or v* tag).
# Usage: make sign-release
sign-release: sign-check
	@echo "=== Signing macOS release v$(VERSION) ==="
	@# Verify draft release exists before doing any work
	@gh release view v$(VERSION) --repo $(GITHUB_REPO) >/dev/null 2>&1 || \
		(echo "ERROR: No release v$(VERSION) found." && \
		 echo "Create one by pushing to a release/* branch or v* tag, or run:" && \
		 echo "  gh workflow run build.yml --repo $(GITHUB_REPO)" && exit 1)
	@# Clean stale artifacts from previous runs to prevent uploading old files
	@rm -f $(PROJECT_DIR)/artifacts/KeepKey-Vault-$(VERSION)-*.dmg
	@rm -f $(PROJECT_DIR)/artifacts/stable-macos-*-keepkey-vault.app.tar.zst
	@mkdir -p $(PROJECT_DIR)/artifacts/ci-arm64 $(PROJECT_DIR)/artifacts/ci-x64
	@echo "Downloading CI-built macOS artifacts..."
	@gh release download v$(VERSION) --repo $(GITHUB_REPO) \
		--pattern "stable-macos-arm64-keepkey-vault.app.tar.zst" \
		--dir $(PROJECT_DIR)/artifacts/ci-arm64 --clobber 2>/dev/null && \
		echo "  Downloaded arm64 artifact" || echo "  No arm64 artifact found"
	@gh release download v$(VERSION) --repo $(GITHUB_REPO) \
		--pattern "stable-macos-x64-keepkey-vault.app.tar.zst" \
		--dir $(PROJECT_DIR)/artifacts/ci-x64 --clobber 2>/dev/null && \
		echo "  Downloaded x64 artifact" || echo "  No x64 artifact found"
	@# Fail if neither artifact was found
	@if [ ! -f $(PROJECT_DIR)/artifacts/ci-arm64/stable-macos-arm64-keepkey-vault.app.tar.zst ] && \
	    [ ! -f $(PROJECT_DIR)/artifacts/ci-x64/stable-macos-x64-keepkey-vault.app.tar.zst ]; then \
		echo ""; \
		echo "ERROR: No CI macOS artifacts found on release v$(VERSION)."; \
		echo "Ensure CI has completed and uploaded artifacts before running sign-release."; \
		rm -rf $(PROJECT_DIR)/artifacts/ci-arm64 $(PROJECT_DIR)/artifacts/ci-x64; \
		exit 1; \
	fi
	@echo ""
	@# Process arm64
	@if [ -f $(PROJECT_DIR)/artifacts/ci-arm64/stable-macos-arm64-keepkey-vault.app.tar.zst ]; then \
		echo "--- Signing arm64 artifact ---"; \
		$(MAKE) _sign-one-dmg \
			_SRC_TAR="$$(pwd)/$(PROJECT_DIR)/artifacts/ci-arm64/stable-macos-arm64-keepkey-vault.app.tar.zst" \
			_DMG_ARCH=arm64; \
	fi
	@# Process x64
	@if [ -f $(PROJECT_DIR)/artifacts/ci-x64/stable-macos-x64-keepkey-vault.app.tar.zst ]; then \
		echo "--- Signing x86_64 artifact ---"; \
		$(MAKE) _sign-one-dmg \
			_SRC_TAR="$$(pwd)/$(PROJECT_DIR)/artifacts/ci-x64/stable-macos-x64-keepkey-vault.app.tar.zst" \
			_DMG_ARCH=x86_64; \
	fi
	@echo ""
	@# Verify at least one DMG was produced in this run
	@PRODUCED=0; \
	for DMG in $(PROJECT_DIR)/artifacts/KeepKey-Vault-$(VERSION)-*.dmg; do \
		[ -f "$$DMG" ] && PRODUCED=1; \
	done; \
	if [ "$$PRODUCED" = "0" ]; then \
		echo "ERROR: No DMGs were produced — signing may have failed."; \
		rm -rf $(PROJECT_DIR)/artifacts/ci-arm64 $(PROJECT_DIR)/artifacts/ci-x64; \
		exit 1; \
	fi
	@echo "=== Uploading signed artifacts ==="
	@for DMG in $(PROJECT_DIR)/artifacts/KeepKey-Vault-$(VERSION)-*.dmg; do \
		[ -f "$$DMG" ] || continue; \
		echo "  Uploading $$(basename $$DMG)..."; \
		gh release upload v$(VERSION) --repo $(GITHUB_REPO) --clobber "$$DMG"; \
	done
	@for TAR in $(PROJECT_DIR)/artifacts/stable-macos-*-keepkey-vault.app.tar.zst; do \
		[ -f "$$TAR" ] || continue; \
		echo "  Uploading $$(basename $$TAR) (signed auto-update payload)..."; \
		gh release upload v$(VERSION) --repo $(GITHUB_REPO) --clobber "$$TAR"; \
	done
	@echo ""
	@echo "=== Release v$(VERSION) signed and uploaded ==="
	@echo "https://github.com/$(GITHUB_REPO)/releases/tag/v$(VERSION)"
	@# Cleanup CI temp dirs
	@rm -rf $(PROJECT_DIR)/artifacts/ci-arm64 $(PROJECT_DIR)/artifacts/ci-x64

# Internal: sign a single tar.zst, produce a signed tar.zst (auto-update) and DMG
# Args: _SRC_TAR (path to tar.zst), _DMG_ARCH (arm64 or x86_64)
_sign-one-dmg:
	@test -f "$(_SRC_TAR)" || (echo "ERROR: $(_SRC_TAR) not found"; exit 1)
	@STAGING=$$(mktemp -d); \
	trap 'rm -rf "$$STAGING"' EXIT; \
	echo "  Extracting..."; \
	zstd -d "$(_SRC_TAR)" -o "$$STAGING/app.tar" --force; \
	tar xf "$$STAGING/app.tar" -C "$$STAGING/"; \
	rm "$$STAGING/app.tar"; \
	APP=$$(find "$$STAGING" -name "*.app" -maxdepth 1 | head -1); \
	if [ -z "$$APP" ]; then echo "ERROR: No .app found after extraction"; exit 1; fi; \
	echo "  Verifying architecture ($(_DMG_ARCH))..."; \
	ACTUAL=$$(lipo -archs "$$APP/Contents/MacOS/launcher" 2>/dev/null); \
	if [ "$$ACTUAL" != "$(_DMG_ARCH)" ]; then \
		echo "ERROR: Binary is $$ACTUAL but expected $(_DMG_ARCH)"; exit 1; \
	fi; \
	echo "  Signing Mach-O binaries..."; \
	find "$$APP" -type f -exec sh -c 'file "$$1" 2>/dev/null | grep -q "Mach-O" && \
		codesign --force --timestamp --sign "Developer ID Application: '"$$ELECTROBUN_DEVELOPER_ID"' ('"$$ELECTROBUN_TEAMID"')" \
		--options runtime "$$1" 2>/dev/null' _ {} \; ; \
	echo "  Signing .app bundle with entitlements..."; \
	codesign --force --timestamp \
		--sign "Developer ID Application: $$ELECTROBUN_DEVELOPER_ID ($$ELECTROBUN_TEAMID)" \
		--options runtime \
		--entitlements $(PROJECT_DIR)/entitlements.plist \
		"$$APP"; \
	codesign --verify --deep --strict "$$APP" || (echo "ERROR: Signature verification failed"; exit 1); \
	echo "  Re-packing signed app into tar.zst for auto-update..."; \
	SIGNED_TAR="$$(pwd)/$(PROJECT_DIR)/artifacts/$$(basename $(_SRC_TAR))"; \
	(cd "$$STAGING" && tar cf - "$$(basename $$APP)") | zstd -o "$$SIGNED_TAR" --force; \
	echo "  Signed tar.zst: $$SIGNED_TAR"; \
	ln -s /Applications "$$STAGING/Applications"; \
	DMG_OUT="$$(pwd)/$(PROJECT_DIR)/artifacts/KeepKey-Vault-$(VERSION)-$(_DMG_ARCH).dmg"; \
	rm -f "$$DMG_OUT"; \
	echo "  Creating DMG..."; \
	hdiutil create -volname "KeepKey Vault" -srcfolder "$$STAGING" -ov -format UDZO "$$DMG_OUT"; \
	echo "  Signing DMG..."; \
	codesign --force --timestamp \
		--sign "Developer ID Application: $$ELECTROBUN_DEVELOPER_ID ($$ELECTROBUN_TEAMID)" \
		"$$DMG_OUT"; \
	echo "  Notarizing DMG..."; \
	ZIP_TMP=$$(mktemp).zip; \
	(cd "$$(dirname "$$DMG_OUT")" && zip -q "$$ZIP_TMP" "$$(basename "$$DMG_OUT")"); \
	xcrun notarytool submit --apple-id "$$ELECTROBUN_APPLEID" --password "$$ELECTROBUN_APPLEIDPASS" \
		--team-id "$$ELECTROBUN_TEAMID" --wait "$$ZIP_TMP"; \
	rm -f "$$ZIP_TMP"; \
	echo "  Stapling notarization ticket..."; \
	xcrun stapler staple "$$DMG_OUT"; \
	echo "  Done: $$DMG_OUT"

# Upload all signed DMGs to the draft release
upload-all-dmgs: sign-check
	@echo "Uploading all signed DMGs for v$(VERSION)..."
	@FOUND=0; \
	for DMG in $(PROJECT_DIR)/artifacts/KeepKey-Vault-$(VERSION)-*.dmg; do \
		[ -f "$$DMG" ] || continue; \
		FOUND=1; \
		echo "  Uploading $$(basename $$DMG)..."; \
		gh release upload v$(VERSION) --repo $(GITHUB_REPO) --clobber "$$DMG"; \
	done; \
	if [ "$$FOUND" = "0" ]; then echo "ERROR: No DMGs found. Run 'make build-signed' or 'make sign-release' first."; exit 1; fi
	@echo "DMGs uploaded to https://github.com/$(GITHUB_REPO)/releases/tag/v$(VERSION)"

help:
	@echo "KeepKey Vault v11 - Electrobun Desktop App"
	@echo ""
	@echo "  make vault          - Install deps + build and run in dev mode"
	@echo "  make install        - Build modules + install vault dependencies"
	@echo "  make dev            - Build and run in dev mode"
	@echo "  make dev-hmr        - Dev mode with Vite HMR"
	@echo "  make build          - Development build (no signing)"
	@echo "  make build-stable   - Production build (signs + notarizes via Electrobun)"
	@echo "  make build-signed   - Full pipeline: build → audit → prune → DMG → sign → notarize"
	@echo "  make prune-bundle   - Prune app bundle (strip nested deps, .d.ts, etc.)"
	@echo "  make dmg            - Create DMG from existing build artifacts"
	@echo "  make modules-build  - Build hdwallet + proto-tx-builder from source"
	@echo "  make modules-clean  - Clean module build artifacts"
	@echo "  make verify-arch    - Verify build artifact matches expected architecture"
	@echo "  make sign-release   - Download CI artifacts, sign + repack, upload DMGs + auto-update tar.zst"
	@echo "  make upload-all-dmgs - Upload all signed DMGs to draft release"
	@echo "  make build-zcash-cli      - Test + build Zcash CLI sidecar (release)"
	@echo "  make build-zcash-cli-intel - Cross-compile Zcash CLI for Intel Mac"
	@echo "  make build-zcash-cli-debug - Test + build Zcash CLI sidecar (debug)"
	@echo "  make test-zcash-cli       - Run Zcash CLI unit tests only"
	@echo "  make audit          - Generate dependency manifest + SBOM"
	@echo "  make sign-check     - Verify signing env vars are configured"
	@echo "  make verify         - Verify .app bundle signature + Gatekeeper"
	@echo "  make publish        - Show distribution artifacts"
	@echo "  make release        - Build, sign, and create new GitHub release"
	@echo "  make upload-dmg     - Upload signed DMG to existing CI draft release"
	@echo "  make test           - Run all tests"
	@echo "  make test-rest      - Run REST API integration tests (requires running vault)"
	@echo "  make clean          - Remove all build artifacts and node_modules"
