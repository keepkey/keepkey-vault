# device-protocol Submodule: Fork Strategy

## Current State

The `modules/device-protocol` submodule intentionally points to
**BitHighlander/device-protocol** (fork), NOT `keepkey/device-protocol` (upstream).

This is because Vault ships support for firmware features that are **not yet publicly released**.
The fork contains proto definitions for unreleased firmware message types. Pushing these upstream
before the firmware ships creates coordination risk and exposes interfaces prematurely.

## What the fork adds over upstream

These proto definitions are in the fork but NOT in `keepkey/device-protocol` master:

- `EthereumTxMetadata` / `EthereumMetadataAck` (EVM clear-signing, msg IDs 115/116)
- `TonSignTx` clear-signing fields (memo, jetton metadata)
- Zcash Orchard shielded transaction protocol (PCZT, msg IDs 1300-1305)
- Zcash transparent shielding protocol messages
- nanopb options for Zcash and TON proto fields
- BIP-85 Success response fix

## Build: lib/ is gitignored

The device-protocol `lib/` directory is in `.gitignore`. The compiled JS protobuf files
(`messages_pb.js`, etc.) must be generated or copied before building.

**The Makefile handles this automatically.** Running `make install` or `make vault` will:
1. Install hdwallet dependencies (which pulls the matching `@keepkey/device-protocol` package)
2. Copy the pre-built `lib/*.js` files from `modules/hdwallet/node_modules/@keepkey/device-protocol/lib/`
   into `modules/device-protocol/lib/`
3. Validate that the submodule origin points to the expected fork

If you see this error:
```
[bundle-backend] FATAL: @keepkey/device-protocol/lib/messages_pb.js is MISSING
```
Run `make device-protocol-lib` or just `make install`.

## Do NOT "fix" the fork reference

If you see that device-protocol points to `BitHighlander/device-protocol` instead of
`keepkey/device-protocol`, this is **intentional**. Do not:
- Change `.gitmodules` to point at `keepkey/device-protocol`
- Repin the submodule to a `keepkey/device-protocol` SHA
- Push proto definitions upstream without coordinating with the firmware release

## Post-Firmware-Release: Upstream Merge Sequence

Once the firmware is publicly released, execute this sequence to reconcile:

### 1. Create upstream PR
```bash
cd modules/device-protocol
git remote add keepkey https://github.com/keepkey/device-protocol.git  # if not already
git fetch keepkey
# Create a PR branch from keepkey/master
git checkout -b merge/vault-v11-protos keepkey/master
git cherry-pick <fork-only-commits>  # or merge, depending on cleanliness
git push keepkey merge/vault-v11-protos
gh pr create --repo keepkey/device-protocol --base master --title "feat: vault v11 protocol additions"
```

### 2. After PR merges, update vault submodule
```bash
cd /path/to/keepkey-vault
# Update .gitmodules to point at keepkey org
git config --file .gitmodules submodule.modules/device-protocol.url https://github.com/keepkey/device-protocol
git submodule sync modules/device-protocol
cd modules/device-protocol
git remote set-url origin https://github.com/keepkey/device-protocol.git
git fetch origin
git checkout origin/master
cd ../..
git add .gitmodules modules/device-protocol
git commit -m "chore: repoint device-protocol submodule to keepkey org"
```

### 3. Verify compatibility
```bash
make clean
make vault        # full rebuild from scratch
make test         # run all tests
```

### 4. Clean up
- Delete the fork branch if no longer needed
- Update this document to reflect the new state
