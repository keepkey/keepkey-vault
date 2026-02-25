PROJECT_DIR := projects/keepkey-vault
VERSION := $(shell grep '"version"' $(PROJECT_DIR)/package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
ARCH := $(shell uname -m)
DMG_NAME := KeepKey-Vault-$(VERSION)-$(ARCH).dmg

# Auto-load .env if present (only export signing-related vars to sub-processes)
ifneq (,$(wildcard .env))
include .env
export ELECTROBUN_DEVELOPER_ID ELECTROBUN_TEAMID ELECTROBUN_APPLEID ELECTROBUN_APPLEIDPASS
endif

.PHONY: install dev dev-hmr build build-stable build-canary build-signed prune-bundle dmg clean help vault sign-check verify publish release submodules modules-install modules-build modules-clean audit cli-install cli cli-build cli-test cli-test-live cli-test-all firmware-build firmware-build-debug firmware-collect firmware-flash firmware-dev firmware-info firmware-download firmware-sync firmware-clean firmware-init

# --- Submodules (auto-init on fresh worktrees/clones) ---

submodules:
	@git submodule update --init

# --- Module Builds (hdwallet + proto-tx-builder from source) ---

modules-install: submodules
	cd modules/proto-tx-builder && bun install
	cd modules/hdwallet && yarn install

modules-build: modules-install
	cd modules/hdwallet && yarn build

modules-clean:
	cd modules/proto-tx-builder && rm -rf dist node_modules
	cd modules/hdwallet && yarn clean 2>/dev/null || (rm -rf packages/*/dist node_modules)

# --- Vault ---

install: modules-build
	cd $(PROJECT_DIR) && bun install

vault: install dev

dev: install
	cd $(PROJECT_DIR) && bun run dev

dev-hmr: install
	-lsof -ti :5173 | xargs kill -9 2>/dev/null || true
	-pkill -f "electrobun dev" 2>/dev/null || true
	cd $(PROJECT_DIR) && bun run dev:hmr

build: install
	cd $(PROJECT_DIR) && bun run build

build-stable: install
	cd $(PROJECT_DIR) && bun run build:stable

build-canary: install
	cd $(PROJECT_DIR) && bun run build:canary

# Prune the app bundle after Electrobun build (strips nested node_modules, .d.ts, etc.)
prune-bundle:
	cd $(PROJECT_DIR) && bun scripts/prune-app-bundle.ts

# Full signed build: electrobun build → prune → extract from tar → create DMG → sign + notarize DMG
build-signed: sign-check build-stable prune-bundle dmg
	@echo ""
	@echo "=== Build complete ==="
	@echo "DMG: $(PROJECT_DIR)/artifacts/$(DMG_NAME)"
	@ls -lh $(PROJECT_DIR)/artifacts/$(DMG_NAME)

# Create a proper DMG from the fully-extracted app (workaround for Electrobun self-extractor bug)
dmg:
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
	DMG_OUT="$(PROJECT_DIR)/artifacts/$(DMG_NAME)"; \
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

# --- CLI ---

cli-install: modules-build
	cd projects/keepkey-cli && bun install
	@# hdwallet packages declare node-hid + usb as peerDependencies.
	@# Bun's file: links create symlinks that resolve from hdwallet's real path,
	@# so we ensure these peer deps are findable from modules/hdwallet/node_modules/.
	@mkdir -p modules/hdwallet/node_modules
	@test -e modules/hdwallet/node_modules/node-hid || ln -s ../../../projects/keepkey-cli/node_modules/node-hid modules/hdwallet/node_modules/node-hid
	@test -e modules/hdwallet/node_modules/usb || ln -s ../../../projects/keepkey-cli/node_modules/usb modules/hdwallet/node_modules/usb

cli: cli-install
	cd projects/keepkey-cli && bun run src/index.ts $(ARGS)

cli-build: cli-install
	cd projects/keepkey-cli && bun build --compile src/index.ts --outfile dist/keepkey

cli-test: cli-install
	cd projects/keepkey-cli && bun test __tests__/unit.test.ts

cli-test-live: cli-install
	cd projects/keepkey-cli && bun test __tests__/live-device.test.ts

cli-test-all: cli-install
	cd projects/keepkey-cli && bun test __tests__/

# --- Firmware (Solana feature branch) ---

FW_DIR := modules/keepkey-firmware
FW_ARTIFACTS := artifacts/firmware
FW_BRANCH := $(shell cd $(FW_DIR) && git branch --show-current 2>/dev/null || echo "unknown")
FW_COMMIT := $(shell cd $(FW_DIR) && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
FW_TIMESTAMP := $(shell date +%Y%m%d-%H%M%S)
FW_LABEL := solana-$(FW_COMMIT)-$(FW_TIMESTAMP)

# Init firmware submodules (skips python-keepkey which has dangling ref)
# Workaround: git worktrees + nested submodules sometimes leave working trees empty,
# so we force-checkout each submodule after init.
firmware-init:
	@echo "Initializing firmware submodules..."
	cd $(FW_DIR) && git submodule update --init code-signing-keys deps/crypto/hw-crypto deps/device-protocol deps/googletest deps/qrenc/QR-Code-generator deps/sca-hardening/SecAESSTM32
	@# Force-checkout worktrees that may be empty due to nested worktree bug
	@for sm in code-signing-keys deps/crypto/hw-crypto deps/device-protocol deps/googletest deps/qrenc/QR-Code-generator deps/sca-hardening/SecAESSTM32; do \
		if [ -f "$(FW_DIR)/$$sm/.git" ] && [ $$(ls -A "$(FW_DIR)/$$sm" | grep -cv '^\.git$$') -eq 0 ]; then \
			echo "  Recovering empty worktree: $$sm"; \
			cd "$(FW_DIR)/$$sm" && git checkout HEAD -- . && cd -; \
		fi; \
	done
	@echo "Firmware submodules ready."

# Build release firmware via Docker → labeled artifacts
firmware-build: firmware-init
	@echo "Building firmware (release) from $(FW_BRANCH) @ $(FW_COMMIT)..."
	cd $(FW_DIR) && ./scripts/build/docker/device/release.sh
	@mkdir -p $(FW_ARTIFACTS)
	@cp $(FW_DIR)/bin/firmware.keepkey.bin $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL).bin
	@cp $(FW_DIR)/bin/firmware.keepkey.elf $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL).elf 2>/dev/null || true
	@echo ""
	@echo "=== Firmware build complete ==="
	@echo "  Branch:  $(FW_BRANCH)"
	@echo "  Commit:  $(FW_COMMIT)"
	@echo "  Artifacts:"
	@ls -lh $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL).*
	@echo ""
	@echo "Flash with:  make firmware-flash FW_PATH=$(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL).bin"

# Build debug firmware via Docker → labeled artifacts
firmware-build-debug: firmware-init
	@echo "Building firmware (debug) from $(FW_BRANCH) @ $(FW_COMMIT)..."
	cd $(FW_DIR) && ./scripts/build/docker/device/debug.sh
	@mkdir -p $(FW_ARTIFACTS)
	@cp $(FW_DIR)/bin/firmware.keepkey.bin $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL)-debug.bin
	@cp $(FW_DIR)/bin/firmware.keepkey.elf $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL)-debug.elf 2>/dev/null || true
	@echo ""
	@echo "=== Firmware debug build complete ==="
	@ls -lh $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL)-debug.*

# Copy latest build to a convenience symlink
firmware-collect:
	@mkdir -p $(FW_ARTIFACTS)
	@if [ -f $(FW_DIR)/bin/firmware.keepkey.bin ]; then \
		cp $(FW_DIR)/bin/firmware.keepkey.bin $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL).bin; \
		ln -sf firmware.keepkey.$(FW_LABEL).bin $(FW_ARTIFACTS)/firmware-latest.bin; \
		echo "Collected: $(FW_ARTIFACTS)/firmware.keepkey.$(FW_LABEL).bin"; \
		echo "Symlink:   $(FW_ARTIFACTS)/firmware-latest.bin"; \
	else \
		echo "ERROR: No firmware binary found. Run 'make firmware-build' first."; \
		exit 1; \
	fi

# Flash firmware binary to device (device must be in bootloader mode)
firmware-flash: cli-install
	@if [ -z "$(FW_PATH)" ]; then \
		if [ -L $(FW_ARTIFACTS)/firmware-latest.bin ]; then \
			echo "Flashing latest build: $$(readlink $(FW_ARTIFACTS)/firmware-latest.bin)"; \
			cd projects/keepkey-cli && bun run src/index.ts firmware ../../$(FW_ARTIFACTS)/firmware-latest.bin; \
		else \
			echo "Usage: make firmware-flash FW_PATH=<path-to-firmware.bin>"; \
			echo "  or run 'make firmware-build' first to create firmware-latest.bin"; \
			exit 1; \
		fi; \
	else \
		cd projects/keepkey-cli && bun run src/index.ts firmware $(FW_PATH); \
	fi

# Full dev cycle: build → collect → flash
firmware-dev: firmware-build firmware-collect
	@echo ""
	@echo "=== Firmware ready for flash ==="
	@echo "  make firmware-flash"
	@echo "  (put device in bootloader mode: hold button while plugging in)"

firmware-info: cli-install
	cd projects/keepkey-cli && bun run src/index.ts firmware-info

firmware-download:
	bun firmware/download.ts

firmware-sync:
	bun firmware/download.ts --sync

firmware-clean:
	rm -rf $(FW_DIR)/bin $(FW_ARTIFACTS)
	@echo "Firmware build artifacts cleaned."

# --- Clean ---

clean: modules-clean
	cd $(PROJECT_DIR) && rm -rf dist node_modules build artifacts
	cd projects/keepkey-cli && rm -rf node_modules dist 2>/dev/null || true

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
	@APP=$$(find $(PROJECT_DIR)/build -name "*.app" -maxdepth 2 | head -1); \
	if [ -z "$$APP" ]; then echo "No .app bundle found in build/"; exit 1; fi; \
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

help:
	@echo "KeepKey Vault v11 - Electrobun Desktop App"
	@echo ""
	@echo "  make vault          - Install deps + build and run in dev mode"
	@echo "  make install        - Build modules + install vault dependencies"
	@echo "  make dev            - Build and run in dev mode"
	@echo "  make dev-hmr        - Dev mode with Vite HMR"
	@echo "  make build          - Development build (no signing)"
	@echo "  make build-stable   - Production build (signs + notarizes via Electrobun)"
	@echo "  make build-signed   - Full pipeline: build → extract → DMG → sign → notarize"
	@echo "  make prune-bundle   - Prune app bundle (strip nested deps, .d.ts, etc.)"
	@echo "  make dmg            - Create DMG from existing build artifacts"
	@echo "  make modules-build  - Build hdwallet + proto-tx-builder from source"
	@echo "  make modules-clean  - Clean module build artifacts"
	@echo "  make audit          - Generate dependency manifest + SBOM"
	@echo "  make sign-check     - Verify signing env vars are configured"
	@echo "  make verify         - Verify .app bundle signature + Gatekeeper"
	@echo "  make publish        - Show distribution artifacts"
	@echo "  make release        - Build, sign, and publish GitHub release"
	@echo "  make clean          - Remove all build artifacts and node_modules"
	@echo ""
	@echo "  CLI:"
	@echo "  make cli ARGS=<cmd> - Run keepkey-cli (e.g. make cli ARGS=features)"
	@echo "  make cli-build      - Compile standalone keepkey binary"
	@echo "  make cli-test       - Run CLI unit tests (no device needed)"
	@echo "  make cli-test-live  - Run CLI live device tests (KeepKey required)"
	@echo "  make cli-test-all   - Run all CLI tests"
	@echo ""
	@echo "  Firmware (Solana):"
	@echo "  make firmware-init       - Init firmware submodules"
	@echo "  make firmware-build      - Build release firmware via Docker → artifacts/firmware/"
	@echo "  make firmware-build-debug - Build debug firmware via Docker"
	@echo "  make firmware-collect    - Copy latest build to artifacts/ with label"
	@echo "  make firmware-flash      - Flash firmware-latest.bin (or FW_PATH=<bin>)"
	@echo "  make firmware-dev        - Full cycle: build → collect → ready to flash"
	@echo "  make firmware-info       - Device firmware diagnostic (signed/unsigned)"
	@echo "  make firmware-clean      - Remove firmware build artifacts"
	@echo "  make firmware-download   - Download latest official firmware binaries"
	@echo "  make firmware-sync       - Download + update manifest.json from remote"
