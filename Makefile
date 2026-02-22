PROJECT_DIR := projects/keepkey-vault

.PHONY: install dev dev-hmr build build-prod clean help vault sign-check verify

install:
	cd $(PROJECT_DIR) && bun install

vault: install dev

dev:
	cd $(PROJECT_DIR) && bun run dev

dev-hmr:
	-lsof -ti :5173 | xargs kill -9 2>/dev/null || true
	-pkill -f "electrobun dev" 2>/dev/null || true
	cd $(PROJECT_DIR) && bun run dev:hmr

build:
	cd $(PROJECT_DIR) && bun run build

build-prod:
	cd $(PROJECT_DIR) && bun run build:prod

clean:
	cd $(PROJECT_DIR) && rm -rf dist node_modules build

# --- Code Signing ---

sign-check:
	@echo "Checking signing environment..."
	@test -n "$$ELECTROBUN_DEVELOPER_ID" || (echo "ERROR: ELECTROBUN_DEVELOPER_ID not set" && exit 1)
	@test -n "$$ELECTROBUN_TEAMID" || (echo "ERROR: ELECTROBUN_TEAMID not set" && exit 1)
	@test -n "$$ELECTROBUN_APPLEID" || (echo "ERROR: ELECTROBUN_APPLEID not set" && exit 1)
	@test -n "$$ELECTROBUN_APPLEIDPASS" || (echo "ERROR: ELECTROBUN_APPLEIDPASS not set" && exit 1)
	@echo "All signing env vars present."
	@security find-identity -v -p codesigning | head -5

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

help:
	@echo "KeepKey Vault v11 - Electrobun Desktop App"
	@echo ""
	@echo "  make vault      - Install deps + build and run in dev mode"
	@echo "  make install    - Install dependencies"
	@echo "  make dev        - Build and run in dev mode"
	@echo "  make dev-hmr    - Dev mode with Vite HMR"
	@echo "  make build      - Production build (with signing if env set)"
	@echo "  make build-prod - Production build (prod channel)"
	@echo "  make sign-check - Verify signing env vars are configured"
	@echo "  make verify     - Verify .app bundle signature + Gatekeeper"
	@echo "  make clean      - Remove build artifacts and node_modules"
