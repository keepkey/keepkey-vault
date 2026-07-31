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
DEVICE_PROTOCOL_BUILD_STAMP := $(STAMP_DIR)/device-protocol-build.stamp
DEVICE_PROTOCOL_INPUTS := $(shell find modules/device-protocol -maxdepth 1 -name '*.proto' -o -name 'package.json' 2>/dev/null)
ZCASH_CLI_STAMP := $(STAMP_DIR)/zcash-cli.stamp
ZCASH_CLI_SOURCES := $(shell find $(PROJECT_DIR)/zcash-cli/src -name '*.rs' 2>/dev/null) $(PROJECT_DIR)/zcash-cli/Cargo.toml

# Auto-load .env if present (only export signing-related vars to sub-processes)
ifneq (,$(wildcard .env))
include .env
export ELECTROBUN_DEVELOPER_ID ELECTROBUN_TEAMID ELECTROBUN_APPLEID ELECTROBUN_APPLEIDPASS
endif

.PHONY: install dev dev-hmr build build-stable build-canary build-signed prune-bundle dmg clean help vault sign-check verify verify-entitlements publish release upload-dmg upload-all-dmgs sign-release sign-release-intel verify-arch submodules modules-install modules-build modules-clean audit build-zcash-cli build-zcash-cli-debug build-zcash-cli-intel test test-unit test-rest test-sign-gating test-zcash-cli test-emu build-intel build-signed-intel build-electrobun-x64-core publish-electrobun-x64-core build-electrobun-linux-x64-core publish-electrobun-linux-x64-core preflight build-emulator build-emulator-windows clean-emulator test-emu-python

# --- Submodules (auto-init on fresh worktrees/clones) ---

$(STAMP_DIR):
	@mkdir -p $(STAMP_DIR)

$(SUBMODULES_STAMP): .gitmodules | $(STAMP_DIR)
	@git submodule update --init modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/electrobun
	@# Fetch Vault runtime/build submodules so upstream-behind checks see latest commits.
	@# Firmware is emulator-only for Vault releases and is intentionally not a gate here.
	@for mod in modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/electrobun; do \
		git -C "$$mod" fetch --all --prune 2>/dev/null || true; \
	done
	@touch $@

submodules: $(SUBMODULES_STAMP)

# --- Device Protocol Build ---

$(DEVICE_PROTOCOL_BUILD_STAMP): $(DEVICE_PROTOCOL_INPUTS) $(SUBMODULES_STAMP) | $(STAMP_DIR)
	@echo "=== device-protocol: installing + building ==="
	cd modules/device-protocol && npm install
	cd modules/device-protocol && npm run build
	@test -f modules/device-protocol/lib/messages_pb.js || (echo "ERROR: device-protocol build failed (messages_pb.js missing)"; exit 1)
	@touch $@

# --- Module Builds (hdwallet + proto-tx-builder from source) ---

$(PROTO_INSTALL_STAMP): modules/proto-tx-builder/package.json modules/proto-tx-builder/yarn.lock $(SUBMODULES_STAMP) | $(STAMP_DIR)
	@# Init the nested osmosis-frontend submodule (provides Cosmos/Osmosis proto codegen)
	cd modules/proto-tx-builder && git submodule update --init osmosis-frontend
	cd modules/proto-tx-builder && yarn install --frozen-lockfile
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

modules-build: $(HDWALLET_BUILD_STAMP) $(PROTO_BUILD_STAMP) $(DEVICE_PROTOCOL_BUILD_STAMP)

modules-clean:
	cd modules/proto-tx-builder && rm -rf dist node_modules
	cd modules/hdwallet && yarn clean 2>/dev/null || (rm -rf packages/*/dist node_modules)
	cd modules/device-protocol && rm -rf lib/*.js lib/*.ts lib/*.json node_modules 2>/dev/null || true
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
	@echo "zcash-cli ready for Electrobun packaging:"
	@ls -lh $(PROJECT_DIR)/zcash-cli/target/release/zcash-cli

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

# --- Electrobun x64 Core (macOS 13+, upstream) ---
# Cross-compiles Electrobun core binaries for Intel Mac from ARM64.
# Uses upstream blackboardsh/electrobun (no fork). Targets macOS 13.0+.
# Produces: artifacts/electrobun-core-darwin-x64.tar.gz
# Prerequisites: run `cd modules/electrobun/package && bun install && bun build.ts` once to vendor deps.
#
# IMPORTANT: After bumping the electrobun submodule, rebuild + republish:
#   make publish-electrobun-x64-core
# Then update X64_CORE_TAG in .github/workflows/build.yml to match.

ELECTROBUN_X64_REPO ?= keepkey/keepkey-vault
# Tag format: electrobun-x64-core-vN — increment N when rebuilding
ELECTROBUN_X64_TAG ?= electrobun-x64-core-v1

build-electrobun-x64-core:
	@echo "Cross-compiling Electrobun x64 core from upstream..."
	./scripts/build-electrobun-x64-core.sh

publish-electrobun-x64-core: build-electrobun-x64-core
	@test -f artifacts/electrobun-core-darwin-x64.tar.gz || (echo "ERROR: tarball not found"; exit 1)
	@SUBMOD_VER=$$(cd modules/electrobun && git describe --tags --always 2>/dev/null || git rev-parse --short HEAD); \
	echo "Publishing Electrobun x64 core to $(ELECTROBUN_X64_REPO) (submodule: $$SUBMOD_VER)..."; \
	gh release view $(ELECTROBUN_X64_TAG) --repo $(ELECTROBUN_X64_REPO) >/dev/null 2>&1 && \
		gh release upload $(ELECTROBUN_X64_TAG) --repo $(ELECTROBUN_X64_REPO) --clobber \
			artifacts/electrobun-core-darwin-x64.tar.gz || \
		gh release create $(ELECTROBUN_X64_TAG) --repo $(ELECTROBUN_X64_REPO) \
			--title "Electrobun x64 Core (macOS 13.0+, upstream $$SUBMOD_VER)" \
			--notes "Cross-compiled Electrobun core for macOS 13.0+ Intel. Built from upstream blackboardsh/electrobun $$SUBMOD_VER. Bun 1.3.9. Adhoc-signed." \
			artifacts/electrobun-core-darwin-x64.tar.gz; \
	echo "Published: https://github.com/$(ELECTROBUN_X64_REPO)/releases/tag/$(ELECTROBUN_X64_TAG)"; \
	echo ""; \
	echo "NEXT: Update .github/workflows/build.yml X64_CORE_TAG to $(ELECTROBUN_X64_TAG)"

# --- Electrobun Linux x64 Core (glibc 2.35 floor) ---
# Builds Electrobun's libNativeWrapper.so + friends on Ubuntu 22.04 so the
# resulting Linux Vault bundle works on Debian 12, Ubuntu 22.04, RHEL 9, etc.
# Upstream's prebuilt core ships against glibc 2.38, which excludes those.
#
# Local invocation only works on an actual Ubuntu 22.04 host (or via
# `make publish-electrobun-linux-x64-core` which runs the GH workflow).

ELECTROBUN_LINUX_REPO ?= keepkey/keepkey-vault
ELECTROBUN_LINUX_TAG ?= electrobun-linux-x64-core-v1
# Pin to the upstream electrobun ref that matches the npm runtime version.
ELECTROBUN_LINUX_REF ?= v1.13.1

build-electrobun-linux-x64-core:
	@echo "Building Electrobun Linux x64 core (must run on ubuntu-22.04)..."
	ELECTROBUN_REF=$(ELECTROBUN_LINUX_REF) ./scripts/build-electrobun-linux-x64-core.sh

# Triggers the GitHub workflow that builds + publishes on ubuntu-22.04.
# Direct local publish isn't supported because the .so must be built on Linux.
publish-electrobun-linux-x64-core:
	@echo "Dispatching publish-electrobun-linux-x64-core.yml on $(ELECTROBUN_LINUX_REPO)..."
	gh workflow run publish-electrobun-linux-x64-core.yml \
		--repo $(ELECTROBUN_LINUX_REPO) \
		--field electrobun_ref=$(ELECTROBUN_LINUX_REF) \
		--field release_tag=$(ELECTROBUN_LINUX_TAG)
	@echo "Watch progress: https://github.com/$(ELECTROBUN_LINUX_REPO)/actions/workflows/publish-electrobun-linux-x64-core.yml"
	@echo ""
	@echo "Once published, the main build workflow will pick it up automatically"
	@echo "(see ELECTROBUN_LINUX_CORE_TAG in .github/workflows/build.yml)."

# --- Vault ---

$(VAULT_INSTALL_STAMP): $(PROJECT_DIR)/package.json $(PROJECT_DIR)/scripts/patch-electrobun.sh $(PROTO_BUILD_STAMP) $(HDWALLET_BUILD_STAMP) $(DEVICE_PROTOCOL_BUILD_STAMP) | $(STAMP_DIR)
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
# Force-clear stamps so the release always rebuilds from the pinned source:
#  - zcash-cli: so it gets re-signed with Developer ID (stamp may be stale from an unsigned build)
#  - module build stamps: the proto-tx-builder / hdwallet / device-protocol dist/ output is
#    gitignored and copied into the bundle via file: refs. The stamps track src mtimes, but a
#    submodule `git checkout` to a new pin does NOT reliably bump src mtimes past an existing
#    stamp — so make skips the rebuild and the bundle ships a STALE dist from a previous commit.
#    (This shipped the @cosmjs/stargate Freegrant/Feegrant fallback as a pre-fix build in v1.4.6/1.4.7,
#    breaking every Cosmos tx with "createFeegrantAminoConverters is not a function".)
#    Clearing the stamps forces modules-build from the pinned source before the vault install copies it.
build-signed: sign-check
	@rm -f $(ZCASH_CLI_STAMP) $(PROTO_BUILD_STAMP) $(HDWALLET_BUILD_STAMP) $(DEVICE_PROTOCOL_BUILD_STAMP)
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
	cd $(PROJECT_DIR) && bun test __tests__/evm-signer-verify.test.ts __tests__/swap-parsing.test.ts __tests__/engine-state-machine.test.ts __tests__/device-switch.test.ts __tests__/wizard-messaging.test.ts __tests__/solana-tx.test.ts __tests__/solana-message-parser.test.ts __tests__/solana-instruction-decoder.test.ts __tests__/solana-alt.test.ts __tests__/solana-spl-decimals.test.ts __tests__/ton-build.test.ts __tests__/tron-memo-inject.test.ts __tests__/audit-coverage.test.ts __tests__/chain-scan.test.ts __tests__/recovery-ownership.test.ts src/bun/mcp.test.ts src/bun/txbuilder/hive-ops.test.ts

test-integration: test-rest

test-rest:
	cd $(PROJECT_DIR) && bun test __tests__/rest-api.test.ts

# Proves every REST sign route is gated by the Vault overlay (deterministic
# empty-probe differential). Set RUN_LIVE_SIGN=1 to also drive a real
# /tron/sign-message signature through the overlay (needs a device press).
test-sign-gating:
	cd $(PROJECT_DIR) && bun test __tests__/rest-sign-gating.test.ts

test-emu:
	@test -f $(HOME)/.keepkey/emulator/libkkemu.dylib || \
		(echo "ERROR: emulator not installed. Run: make build-emulator"; exit 1)
	cd $(PROJECT_DIR) && bun test tests/emulator/

# --- Emulator (developer feature) ---
# Build the native emulator from the firmware submodule on the current
# checkout. Two DIFFERENT artifacts come out of this target — keep them
# straight:
#
#   1. libkkemu.dylib  — the in-process FFI library THE VAULT LOADS via
#      bun:ffi. Ring buffers (no sockets), caller-driven kkemu_poll, OLED
#      capture ring for the live screen preview. Installed at
#      ~/.keepkey/emulator/libkkemu.dylib.  ← this is the "vault emulator".
#
#   2. kkemu  — the STANDALONE UDP binary (:11044/:11045). This is the
#      transport the firmware CI uses (python-keepkey UDP tests + OLED
#      screenshot regression). The vault NEVER talks to it; it's here only
#      so `make test-emu-python` can run the same checks locally.
#
# Same firmware source, two transports. The Windows port (below) only needs
# artifact #1 — see `make build-emulator-windows`.
#
# No channels — devs bring their own firmware checkout. Switch revs by
# checking out the target ref in modules/keepkey-firmware before running.

EMU_FW_DIR := modules/keepkey-firmware
EMU_BUILD_DIR := $(EMU_FW_DIR)/build-emu
EMU_INSTALL_DIR := $(HOME)/.keepkey/emulator

build-emulator:
	@echo "=== Building emulator from current $(EMU_FW_DIR) checkout ==="
	@cd $(EMU_FW_DIR) && git rev-parse HEAD | xargs -I{} echo "    Source SHA: {}"
	cd $(EMU_FW_DIR) && git submodule update --init --recursive
	rm -rf $(EMU_BUILD_DIR)
	mkdir -p $(EMU_BUILD_DIR)
	@# KK_DEBUG_LINK=ON: required for the dylib FFI path (DebugLinkDecision parsing).
	@# KK_BUILD_DYLIB=ON: produces libkkemu.dylib alongside standalone kkemu.
	@# Toolchain: nanopb 0.3.9.4 + protoc-gen-nanopb live in pyenv 3.10.15;
	@# protoc is pinned to 3.21.x (from the .toolchain cache if present, else
	@# whatever is on PATH). cmake MUST get NANOPB_DIR/NANOPB_PLUGIN — without
	@# them it falls back to a bogus /root/nanopb default and proto-gen fails.
	cd $(EMU_BUILD_DIR) && \
		PYBIN="$(HOME)/.pyenv/versions/3.10.15/bin"; \
		test -x "$$PYBIN/python" || { echo "ERROR: pyenv 3.10.15 required (pyenv install 3.10.15 + pip install nanopb==0.3.9.4.post3)"; exit 1; }; \
		NANOPB_DIR="$$($$PYBIN/python -c 'import os,nanopb;print(os.path.dirname(nanopb.__file__))')"; \
		PINNED="$(EMU_INSTALL_DIR)/.toolchain/protoc-21.12/bin"; \
		if [ -x "$$PINNED/protoc" ]; then export PATH="$$PINNED:$$PYBIN:$$NANOPB_DIR/generator:$$PATH"; \
		else export PATH="$$PYBIN:$$NANOPB_DIR/generator:$$PATH"; fi; \
		cmake .. -DKK_EMULATOR=ON -DKK_DEBUG_LINK=ON -DKK_BUILD_DYLIB=ON \
			-DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
			-DNANOPB_DIR="$$NANOPB_DIR" \
			-DNANOPB_PLUGIN="$$(command -v protoc-gen-nanopb)" \
			-DCMAKE_C_FLAGS="-DPB_NO_PACKED_STRUCTS=1" \
			-DCMAKE_CXX_FLAGS="-DPB_NO_PACKED_STRUCTS=1" && \
		make -j$$(sysctl -n hw.ncpu) kkemu kkemulator_dylib
	mkdir -p $(EMU_INSTALL_DIR)
	@if [ -f $(EMU_BUILD_DIR)/lib/libkkemu.dylib ]; then \
		cp $(EMU_BUILD_DIR)/lib/libkkemu.dylib $(EMU_INSTALL_DIR)/libkkemu.dylib; \
		codesign --force --sign - $(EMU_INSTALL_DIR)/libkkemu.dylib; \
		echo "    Dylib:  $(EMU_INSTALL_DIR)/libkkemu.dylib (ad-hoc signed)"; \
	else \
		echo "ERROR: libkkemu.dylib missing from build output"; exit 1; \
	fi
	cp $(EMU_BUILD_DIR)/bin/kkemu $(EMU_INSTALL_DIR)/kkemu
	chmod +x $(EMU_INSTALL_DIR)/kkemu
	@echo "    Binary: $(EMU_INSTALL_DIR)/kkemu"
	@echo "=== Emulator installed ==="

# Cross-compile the Windows emulator DLL (libkkemu.dll) from THIS macOS/Linux
# host using MinGW-w64 — no Windows runner needed. Produces artifact #1 above
# (the vault FFI library) as a .dll instead of a .dylib; does NOT build the
# standalone UDP `kkemu` binary (gated out on Windows). Requires mingw-w64:
#   macOS: brew install mingw-w64   |   Linux: apt-get install mingw-w64
build-emulator-windows:
	cd $(EMU_FW_DIR) && git submodule update --init --recursive
	bash scripts/build-emulator-windows.sh

# Run python-keepkey consistency tests against the locally-built kkemu binary.
test-emu-python:
	@test -x $(EMU_INSTALL_DIR)/kkemu || \
		(echo "ERROR: kkemu not found at $(EMU_INSTALL_DIR)/kkemu. Run: make build-emulator"; exit 1)
	@echo "Starting kkemu (UDP 11044/11045)..."
	@$(EMU_INSTALL_DIR)/kkemu & KKPID=$$!; \
	sleep 1; \
	echo "Running python-keepkey tests..."; \
	cd modules/keepkey-firmware/deps/python-keepkey/tests && \
	PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python \
	python3 -m pytest \
		test_basic.py \
		test_msg_getaddress.py \
		test_msg_ethereum_getaddress.py \
		test_msg_ethereum_signtx_xfer.py \
		test_msg_ethereum_erc20_approve.py \
		test_msg_cosmos_getaddress.py \
		test_msg_ethereum_message.py \
		-v 2>&1; \
	EXIT=$$?; \
	kill $$KKPID 2>/dev/null; \
	exit $$EXIT

clean-emulator:
	rm -rf $(EMU_BUILD_DIR)
	rm -f $(EMU_INSTALL_DIR)/libkkemu.dylib $(EMU_INSTALL_DIR)/kkemu

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
		--draft \
		--generate-notes \
		$(PROJECT_DIR)/artifacts/$(DMG_NAME) \
		$$UPDATE_JSON $$TAR_ZST
	@echo "Draft release v$(VERSION) created in $(GITHUB_REPO)"

# Sign CI-built macOS artifacts and upload to draft release.
# Downloads both arm64 and x64 tar.zst from CI, signs all binaries,
# re-packs signed tar.zst (auto-update), creates DMGs, notarizes, and uploads.
# Requires: draft release v$(VERSION) created by CI (push to release/* or v* tag).
# Usage: make sign-release
#
# NOTE: For arm64, prefer `make build-signed` (builds from source locally).
# CI-built arm64 artifacts may fail notarization because the binaries were
# built on a different machine. Use `make sign-release-intel` for x64 only.
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

# Sign Intel (x86_64) macOS release artifact from CI.
# For arm64, use `make build-signed` instead — local builds notarize reliably.
# Usage: make sign-release-intel
sign-release-intel: sign-check
	@echo "=== Signing macOS Intel release v$(VERSION) ==="
	@gh release view v$(VERSION) --repo $(GITHUB_REPO) >/dev/null 2>&1 || \
		(echo "ERROR: No release v$(VERSION) found." && exit 1)
	@# Clean stale x64 artifacts only (preserve arm64 from local build-signed)
	@rm -f $(PROJECT_DIR)/artifacts/KeepKey-Vault-$(VERSION)-x86_64.dmg
	@rm -f $(PROJECT_DIR)/artifacts/stable-macos-x64-keepkey-vault.app.tar.zst
	@mkdir -p $(PROJECT_DIR)/artifacts/ci-x64
	@echo "Downloading CI-built x64 artifact..."
	@gh release download v$(VERSION) --repo $(GITHUB_REPO) \
		--pattern "stable-macos-x64-keepkey-vault.app.tar.zst" \
		--dir $(PROJECT_DIR)/artifacts/ci-x64 --clobber
	@echo ""
	@echo "--- Signing x86_64 artifact ---"
	@$(MAKE) _sign-one-dmg \
		_SRC_TAR="$$(pwd)/$(PROJECT_DIR)/artifacts/ci-x64/stable-macos-x64-keepkey-vault.app.tar.zst" \
		_DMG_ARCH=x86_64
	@echo ""
	@echo "=== Uploading Intel signed artifacts ==="
	@gh release upload v$(VERSION) --repo $(GITHUB_REPO) --clobber \
		$(PROJECT_DIR)/artifacts/KeepKey-Vault-$(VERSION)-x86_64.dmg
	@gh release upload v$(VERSION) --repo $(GITHUB_REPO) --clobber \
		$(PROJECT_DIR)/artifacts/stable-macos-x64-keepkey-vault.app.tar.zst
	@echo ""
	@echo "=== Intel release v$(VERSION) signed and uploaded ==="
	@rm -rf $(PROJECT_DIR)/artifacts/ci-x64

# Internal: sign a single tar.zst, produce a signed tar.zst (auto-update) and DMG
# Args: _SRC_TAR (path to tar.zst), _DMG_ARCH (arm64 or x86_64)
_sign-one-dmg:
	@test -f "$(_SRC_TAR)" || (echo "ERROR: $(_SRC_TAR) not found"; exit 1)
	@set -e; \
	STAGING=$$(mktemp -d); \
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
	./scripts/sign-macos-app.sh "$$APP" "$(PROJECT_DIR)/entitlements.plist"; \
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

# Verify that all MacOS/ executables have required entitlements (allow-jit).
# Use after signing to confirm bun won't crash with SIGTRAP.
verify-entitlements:
	@echo "Verifying entitlements on signed artifacts..."
	@FOUND=0; \
	for TAR_ZST in $(PROJECT_DIR)/artifacts/*-keepkey-vault.app.tar.zst; do \
		[ -f "$$TAR_ZST" ] || continue; \
		FOUND=1; \
		LABEL=$$(basename "$$TAR_ZST" .app.tar.zst); \
		echo "--- $$LABEL ---"; \
		TMPDIR=$$(mktemp -d); \
		trap 'rm -rf "$$TMPDIR"' EXIT; \
		zstd -d "$$TAR_ZST" -o "$$TMPDIR/app.tar" --force 2>/dev/null; \
		tar xf "$$TMPDIR/app.tar" -C "$$TMPDIR/"; \
		rm "$$TMPDIR/app.tar"; \
		APP=$$(find "$$TMPDIR" -name "*.app" -maxdepth 1 | head -1); \
		if [ -z "$$APP" ]; then echo "  ERROR: No .app found"; continue; fi; \
		FAIL=0; \
		for BIN in "$$APP/Contents/MacOS/"*; do \
			[ -f "$$BIN" ] || continue; \
			NAME=$$(basename "$$BIN"); \
			FILE_OUT=$$(file -b "$$BIN" 2>/dev/null); \
			echo "$$FILE_OUT" | grep -q "Mach-O" || continue; \
			if echo "$$FILE_OUT" | grep -q "dynamically linked shared library"; then \
				echo "  SKIP: $$NAME is a shared library"; \
				continue; \
			fi; \
			ENTITLEMENTS_OUT=$$(codesign -d --entitlements :- "$$BIN" 2>&1 || true); \
			if echo "$$ENTITLEMENTS_OUT" | grep -q "invalid entitlements blob"; then \
				echo "  FAIL: $$NAME has invalid entitlements blob"; FAIL=1; \
			elif echo "$$ENTITLEMENTS_OUT" | grep -q "allow-jit"; then \
				echo "  PASS: $$NAME has allow-jit"; \
			else \
				echo "  FAIL: $$NAME missing allow-jit"; FAIL=1; \
			fi; \
		done; \
		rm -rf "$$TMPDIR"; \
		if [ "$$FAIL" = "1" ]; then \
			echo "  ENTITLEMENT CHECK FAILED — bun will crash with SIGTRAP"; \
			exit 1; \
		fi; \
	done; \
	if [ "$$FOUND" = "0" ]; then echo "No tar.zst artifacts found in $(PROJECT_DIR)/artifacts/"; exit 1; fi; \
	echo ""; \
	echo "All MacOS/ binaries have required entitlements."

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
	@echo "  make verify-entitlements - Verify MacOS/ binaries have allow-jit entitlement"
	@echo "  make sign-release   - Download CI artifacts, sign + repack, upload DMGs + auto-update tar.zst"
	@echo "  make upload-all-dmgs - Upload all signed DMGs to draft release"
	@echo "  make build-zcash-cli      - Test + build Zcash CLI sidecar (release)"
	@echo "  make build-electrobun-x64-core  - Cross-compile Electrobun core for Intel Mac (macOS 13+)"
	@echo "  make publish-electrobun-x64-core - Build + publish x64 core release"
	@echo "  make build-zcash-cli-intel - Cross-compile Zcash CLI for Intel Mac"
	@echo "  make build-zcash-cli-debug - Test + build Zcash CLI sidecar (debug)"
	@echo "  make test-zcash-cli       - Run Zcash CLI unit tests only"
	@echo "  make audit          - Generate dependency manifest + SBOM"
	@echo "  make sign-check     - Verify signing env vars are configured"
	@echo "  make verify         - Verify .app bundle signature + Gatekeeper"
	@echo "  make publish        - Show distribution artifacts"
	@echo "  make release        - Build, sign, and create a draft GitHub release"
	@echo "  make upload-dmg     - Upload signed DMG to existing CI draft release"
	@echo "  make test           - Run all tests"
	@echo "  make test-rest      - Run REST API integration tests (requires running vault)"
	@echo "  make clean          - Remove all build artifacts and node_modules"
	@echo "  make preflight      - Pre-release validation (pins, CI, builds, typecheck)"
	@echo ""
	@echo "Emulator (developer feature, macOS only):"
	@echo "  make build-emulator        - Build kkemu+libkkemu from current firmware submodule checkout"
	@echo "                               and install to ~/.keepkey/emulator/"
	@echo "  make test-emu-python       - Run python-keepkey UDP tests against the installed kkemu"
	@echo "  make clean-emulator        - Remove the installed dylib + binary"

# --- Pre-release Validation ---
preflight: submodules
	@echo "╔══════════════════════════════════════════╗"
	@echo "║   PRE-RELEASE VALIDATION                 ║"
	@echo "╚══════════════════════════════════════════╝"
	@echo ""
	@echo "1. SUBMODULE PINS"
	@fail=0; \
	for mod in modules/hdwallet modules/proto-tx-builder modules/device-protocol modules/electrobun; do \
		pinned=$$(git ls-tree HEAD "$$mod" | awk '{print substr($$3,1,12)}'); \
		actual=$$(cd "$$mod" && git rev-parse --short=12 HEAD 2>/dev/null); \
		if [ "$$pinned" = "$$actual" ]; then echo "   ✅ $$mod"; \
		else echo "   ❌ $$mod DRIFT (pin=$$pinned actual=$$actual)"; fail=1; fi; \
	done; \
	echo ""; \
	echo "2. FIRMWARE SUBMODULE"; \
	echo "   ⚠️  Skipped for Vault release gating (emulator/firmware work only)"; \
	echo ""; \
	echo "3. UPSTREAM BEHIND"; \
	for pair in "modules/hdwallet|origin/master" "modules/proto-tx-builder|origin/main" "modules/device-protocol|origin/master" "modules/electrobun|origin/main"; do \
		mod="$${pair%%|*}"; ref="$${pair##*|}"; \
		behind=$$(cd "$$mod" && git rev-list --count HEAD.."$$ref" 2>/dev/null || echo "?"); \
		if [ "$$behind" = "0" ]; then echo "   ✅ $$mod"; \
		else echo "   ⚠️  $$mod: $$behind behind $$ref"; fi; \
	done; \
	echo ""; \
	echo "4. CI STATUS (checks pinned commit, falls back to fork repo for cross-fork PRs)"; \
	for pair in "modules/hdwallet|keepkey/hdwallet|keepkey/hdwallet" "modules/proto-tx-builder|BitHighlander/proto-tx-builder|BitHighlander/proto-tx-builder" "modules/device-protocol|keepkey/device-protocol|keepkey/device-protocol" "modules/electrobun|blackboardsh/electrobun|blackboardsh/electrobun"; do \
		mod=$$(echo "$$pair" | cut -d'|' -f1); \
		repo=$$(echo "$$pair" | cut -d'|' -f2); \
		fork=$$(echo "$$pair" | cut -d'|' -f3); \
		sha=$$(cd "$$mod" && git rev-parse HEAD); \
		total=$$(gh api "repos/$$repo/commits/$$sha/check-runs" --jq '.total_count' 2>/dev/null || echo "0"); \
		if [ "$$total" = "0" ] && [ "$$repo" != "$$fork" ]; then \
			total=$$(gh api "repos/$$fork/commits/$$sha/check-runs" --jq '.total_count' 2>/dev/null || echo "0"); \
			repo="$$fork"; \
		fi; \
		if [ "$$total" = "0" ]; then echo "   ⚠️  $$mod: no CI"; \
		else \
			failed=$$(gh api "repos/$$repo/commits/$$sha/check-runs" --jq '[.check_runs[] | select(.conclusion == "failure")] | length' 2>/dev/null || echo "0"); \
			if [ "$$failed" = "0" ]; then echo "   ✅ $$mod: $$total/$$total green"; \
			else echo "   ❌ $$mod: $$failed/$$total FAILED"; fail=1; fi; \
		fi; \
	done; \
	echo ""; \
	echo "5. LOCAL BUILD ARTIFACTS"; \
	test -f modules/hdwallet/packages/hdwallet-keepkey/dist/typeRegistry.js && echo "   ✅ hdwallet dist/" || { echo "   ❌ hdwallet dist/ — run: make modules-build"; fail=1; }; \
	test -f modules/proto-tx-builder/dist/index.js && echo "   ✅ proto-tx-builder dist/" || { echo "   ❌ proto-tx-builder dist/ — run: make modules-build"; fail=1; }; \
	test -f modules/device-protocol/lib/messages_pb.js && echo "   ✅ device-protocol lib/" || { echo "   ❌ device-protocol lib/ — run: cd modules/device-protocol && npm run build"; fail=1; }; \
	echo ""; \
	echo "6. VAULT TYPECHECK"; \
	errs=$$(cd $(PROJECT_DIR) && npx tsc --noEmit --skipLibCheck 2>&1 | grep "error TS" | grep -v "minimatch" | wc -l | tr -d ' '); \
	if [ "$$errs" = "0" ]; then echo "   ✅ clean"; \
	else echo "   ❌ $$errs type errors"; fail=1; fi; \
	echo ""; \
	echo "════════════════════════════════════════════"; \
	if [ "$$fail" = "0" ]; then echo "✅ ALL GATES PASSED — ready to cut release"; \
	else echo "❌ ISSUES FOUND — fix before release"; exit 1; fi
