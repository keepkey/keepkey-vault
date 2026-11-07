---
name: keepkey-password-migration
description: Migrate or rotate website passwords with KeepKey Vault and its BEX. Use for password profile inventory, cache rehydration, user-reported Chrome Checkup findings, or guided Google/GitHub/Microsoft password changes. Password values stay outside agent output.
---

# KeepKey password migration

Use the paired local Vault API. Its independent Password Manager feature flag defaults off; enable it in Vault settings only when the user wants to test. Monero enablement is unrelated. The user unlocks the bank with KeepKey.

Run `bun <repo>/projects/keepkey-vault/scripts/password-agent-cli.ts help` for the CLI. This skill ships in `<repo>/skills/keepkey-password-migration`. `KEEPKEY_PASSWORD_AGENT_TOKEN_FILE` selects an owner-only pairing token file; never print its contents. Pair only if no valid pairing exists.

1. Fetch `profiles [service] [exact-account]`, then `helper <service>`. Helpers are compact, versioned site recipes from the running build. If unsupported, inspect the service's actual account settings before proposing a recipe.
2. Distinguish `cache.state` (local plaintext expired, same website password) from `rotation` (website password needs changing). A new assignment is a candidate until verified. Inventory filters do not imply Chrome credential discovery.
3. Use `call password_TOOL JSON` with the latest `expectedRevision` for mutations. Generate a small bank with physical approval; assign the exact login origin/account. Use `password_rehydrate` to refill an existing location; never rotate just because cache expired.
4. Stage with `password_rotation` action `prepare`. Run `save-backup NEWFILE` to persist the encrypted manifest and acknowledge that revision. Keep the backup with the seed recovery plan: the seed alone does not identify the random bank or its assigned locations. Do not export backups into conversation output.
5. Resolve the intended browser/profile with `browser-call bex_browsers {}` and safe tab metadata. Never read an inbox to identify an account. Follow the versioned service helper and preserve any existing submitted rotation before starting another.
6. Mark the rotation `submitted` **before** the website can accept a new password. Discover fields with `password_fill_targets`, then request each exact `browser`, `tabId`, `documentToken`, `ref` through `password_fill_request`. The user approves each fill in native Vault. Poll `password_operation_status`. Do not use `bex_type`, clipboard, screenshots, reveal calls, or diagnostic reads to transport a password.
7. The user handles existing-password authentication, passkeys, and MFA. Fill the staged new/confirmation fields through approved requests; review the intended account and submit the change when authorized. Some sites may react to field events. On ambiguous submission retain both locations, mark reconciliation needed, and do not cancel.
8. Verify a fresh sign-in with the staged password. A previously authenticated session is insufficient. Final activation requires the native Vault verification control; there is no agent activation API. Save a new encrypted backup after activation.

Chrome does not provide ordinary extensions its full saved-password inventory or private compromise API. Users can inspect Chrome Password Manager → Checkup and explicitly report findings via `password_risk_report` with `source: chrome-password-checkup`. These are user-reported, not automatic scans. Unknown means not assessed. Avoid Chrome CSV exports: they contain plaintext passwords.

If a field, document, account, cache, or device session changes, rediscover and review. Do not work around an expired grant or a disabled feature.
