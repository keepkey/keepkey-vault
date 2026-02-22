PROJECT_DIR := projects/keepkey-vault

.PHONY: install dev dev-hmr build build-prod clean help vault

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

help:
	@echo "KeepKey Vault v11 - Electrobun Desktop App"
	@echo ""
	@echo "  make vault      - Install deps + build and run in dev mode"
	@echo "  make install    - Install dependencies"
	@echo "  make dev        - Build and run in dev mode"
	@echo "  make dev-hmr    - Dev mode with Vite HMR"
	@echo "  make build      - Production build"
	@echo "  make build-prod - Production build (prod channel)"
	@echo "  make clean      - Remove build artifacts and node_modules"
