# Firmware Build Guide (v7.11.0+ with Solana)

## Quick Start

```bash
cd projects/keepkey-vault-v11-solana   # or whichever worktree has firmware
make firmware-build                     # Docker build → artifacts/firmware/
make firmware-flash FW_PATH=artifacts/firmware/firmware.keepkey.<label>.bin
```

## Prerequisites

- **Docker** — all builds happen inside `kktech/firmware:v15`
- **Device in bootloader mode** — hold button while plugging in (for flashing only)
- **Firmware submodules initialized** — `make firmware-init` handles this automatically

## Build Targets

| Target | What It Does |
|--------|-------------|
| `make firmware-init` | Init firmware submodules (auto-recovers empty worktrees) |
| `make firmware-build` | Release build via Docker, outputs labeled artifacts |
| `make firmware-build-debug` | Debug build with symbols + debug-link enabled |
| `make firmware-collect` | Create `firmware-latest.bin` symlink to latest build |
| `make firmware-flash FW_PATH=<path>` | Flash binary to device (bootloader mode required) |
| `make firmware-dev` | Build + collect in one step |
| `make firmware-info` | Query connected device for firmware version/signing status |
| `make firmware-clean` | Remove all build artifacts |

## How the Build Works

### Pipeline

```
make firmware-build
  |
  v
firmware-init  (git submodule update --init for 6 deps)
  |
  v
scripts/build/docker/device/release.sh
  |
  v
docker run kktech/firmware:v15
  |-- cmake -C cmake/caches/device.cmake -DCMAKE_BUILD_TYPE=MinSizeRel
  |-- make                (ARM Cortex-M3 cross-compile)
  |-- cp bin/*.bin bin/*.elf -> modules/keepkey-firmware/bin/
  v
Copy to artifacts/firmware/firmware.keepkey.<label>.bin
```

### Docker Image: `kktech/firmware:v15`

This image contains the full ARM cross-compilation toolchain:

| Component | Version | Purpose |
|-----------|---------|---------|
| `arm-none-eabi-gcc` | 10-2020-q4 | ARM Cortex-M3 cross-compiler |
| `protoc` | 3.5.1 | Protobuf compiler |
| `nanopb` | 0.3.9.8 | Nanopb C protobuf generator |
| `libopencm3` | docker-v9 | ARM Cortex-M library (pre-built) |
| `cmake` | 3.9+ | Build system |
| `clang/gcc/g++` | system | Host compilers (emulator builds) |

**The image must be v15.** Older versions (v8) lack the correct libopencm3 build with `cortex-m-generic.ld`.

### Artifact Labeling

Build artifacts are labeled: `firmware.keepkey.solana-{commit}-{date}-{time}`

Example: `firmware.keepkey.solana-fb4bfe30-20260306-155927.bin`

Variables from Makefile:
```makefile
FW_BRANCH := $(shell cd $(FW_DIR) && git branch --show-current)
FW_COMMIT := $(shell cd $(FW_DIR) && git rev-parse --short HEAD)
FW_TIMESTAMP := $(shell date +%Y%m%d-%H%M%S)
FW_LABEL := solana-$(FW_COMMIT)-$(FW_TIMESTAMP)
```

### Build Types

| Type | Script | CMake Flag | Binary Size | Use Case |
|------|--------|-----------|-------------|----------|
| Release | `device/release.sh` | `-DCMAKE_BUILD_TYPE=MinSizeRel` | ~523KB | Production flashing |
| Debug | `device/debug.sh` | `-DCMAKE_BUILD_TYPE=Debug -DKK_DEBUG_LINK=ON` | ~1MB | Development/debugging |
| Emulator | `emulator/debug.sh` | `-DKK_EMULATOR=ON` (clang, native) | N/A | Host-side testing |

## Changing the Firmware Version

Edit `modules/keepkey-firmware/CMakeLists.txt` line 5:

```cmake
project(
  KeepKeyFirmware
  VERSION 7.11.0        # <-- change this
  LANGUAGES C CXX ASM)
```

Verify after build:
```bash
strings firmware.keepkey.*.bin | grep VERSION
# Output: VERSION7.11.0
```

## Submodule Dependencies

`make firmware-init` initializes these (skips `deps/python-keepkey` to avoid dangling refs):

| Submodule | Purpose |
|-----------|---------|
| `deps/device-protocol` | Protobuf message definitions (includes `messages-solana.proto`) |
| `deps/crypto/hw-crypto` | Cryptographic primitives (Ed25519, secp256k1, etc.) |
| `deps/googletest` | Unit testing framework |
| `deps/qrenc/QR-Code-generator` | QR code generation for on-device display |
| `deps/sca-hardening/SecAESSTM32` | Side-channel attack hardening |
| `code-signing-keys` | Code signing key material |

### Git Worktree Recovery

Nested git worktrees sometimes leave submodule directories empty. `firmware-init` detects and recovers:

```bash
# For each submodule: if .git exists but dir is empty, force checkout
if [ -f "$sm/.git" ] && [ $(ls -A "$sm" | grep -cv '^\.git$') -eq 0 ]; then
    cd "$sm" && git checkout HEAD -- .
fi
```

## Solana Firmware Files

The Solana implementation adds these files to the firmware:

| File | LOC | Purpose |
|------|-----|---------|
| `lib/firmware/solana.c` | 117 | Ed25519 key derivation, Base58 address encoding |
| `lib/firmware/solana_tx.c` | 377 | Transaction parser (compact-u16, accounts, instructions) |
| `lib/firmware/solana_msg.c` | 107 | Off-chain message signing (`\x19Solana Signed Message:\n` prefix) |
| `lib/firmware/fsm_msg_solana.h` | 188 | FSM message handlers for GetAddress, SignTx, SignMessage |
| `include/keepkey/firmware/solana.h` | — | Public function declarations |
| `include/keepkey/firmware/solana_tx.h` | 101 | TX parsing structures |
| `lib/transport/generated/messages-solana.pb.c` | — | Pre-generated nanopb C bindings |
| `lib/transport/generated/messages-solana.pb.h` | — | Pre-generated nanopb C headers |

### Protocol Message IDs

| ID | Message | Direction |
|----|---------|-----------|
| 750 | `SolanaGetAddress` | wire_in |
| 751 | `SolanaAddress` | wire_out |
| 752 | `SolanaSignTx` | wire_in |
| 753 | `SolanaSignedTx` | wire_out |
| 754 | `SolanaSignMessage` | wire_in |
| 755 | `SolanaMessageSignature` | wire_out |

## Regenerating Python Protobuf Files

When `device-protocol` changes (new messages), regenerate python-keepkey pb2 files:

```bash
cd projects/python-keepkey

# Ensure device-protocol submodule has the new proto files
cd device-protocol && git checkout <branch-with-changes> && cd ..

# Generate using the firmware Docker image (protoc 3.5.1)
./docker_build_pb.sh
```

This runs `build_pb.sh` inside `kktech/firmware:v8` which:
1. Iterates all `.proto` files in `device-protocol/`
2. Generates `keepkeylib/messages_*_pb2.py` with `protoc --python_out`
3. Fixes imports to use relative paths (`from . import`)

**The proto list in `build_pb.sh` must include `messages-solana`:**
```bash
for i in messages messages-ethereum ... messages-solana types ; do
```

## Full Stack Build Order

For a clean Solana firmware build from scratch:

```
1. device-protocol   (messages-solana.proto)
   |
2. keepkey-firmware   (C implementation + pre-generated nanopb)
   |   |
   |   +-- deps/device-protocol -> feature-solana branch
   |   +-- deps/python-keepkey  -> feature/solana branch (for emulator tests)
   |
3. python-keepkey     (pb2 files + client methods, for testing)
   |
4. hdwallet           (master already has Solana jspb shims)
   |
5. keepkey-vault      (RPC handlers, UI — future work)
```

## Branch Management (BitHighlander Forks)

All Solana work is staged on BitHighlander forks. Upstream push is blocked.

### Firmware PRs (BitHighlander/keepkey-firmware -> develop)

| PR | Branch | Description |
|----|--------|-------------|
| #8 | `fix/hw-crypto-migration` | Migrate from trezor-firmware to hw-crypto submodule |
| #9 | `fix/pre-generated-protobuf` | Eliminate Python/nanopb build-time dependency |
| #10 | `feature/solana` | Solana GetAddress, SignTx, SignMessage (depends on #8, #9) |

### Device Protocol (BitHighlander/device-protocol)

| Branch | Description |
|--------|-------------|
| `feature-solana` | 1 commit: `messages-solana.proto` (750-755) on top of master |

### Python-KeepKey (BitHighlander/python-keepkey)

| PR | Branch | Base | Description |
|----|--------|------|-------------|
| #3 | `feature/solana` | `fix/combined-cleanup` | pb2 + client methods |

### HDWallet (keepkey/hdwallet)

Solana already merged to `master` — no separate branch needed.

## Unsigned Firmware Storage

Unsigned firmware binaries for testing are stored at:
```
projects/keepkey-vault-v11/firmware/unsigned/
```

Naming convention: `firmware.keepkey.solana-<version>.bin`

Example: `firmware.keepkey.solana-7.11.0.bin`

## Troubleshooting

### Build fails: "No such file: cortex-m-generic.ld"
You're using the wrong Docker image. Must be `kktech/firmware:v15`, not v8.

### Build fails: "ModuleNotFoundError: No module named 'requests'"
The Docker image is missing Python deps. Use `kktech/firmware:v15` which has them pre-installed, or add `pip3 install requests` before cmake.

### Build fails: zxappliquid.c "maybe-uninitialized"
Initialize the `ttoken` variable: `const TokenType *WETH, *ttoken = NULL;`
This is a pre-existing issue in the upstream code with `-Werror` enabled.

### Submodules empty after git worktree checkout
Run `make firmware-init` — it detects and recovers empty worktree directories.

### python-keepkey pb2 files incompatible
The pb2 files must be generated with protoc 3.x (the Docker image has 3.5.1). Protoc 33+ generates a completely different format that is incompatible with the existing `protobuf==3.17.3` Python package.

### Flash fails: device not responding
1. Ensure device is in bootloader mode (hold button while plugging in)
2. The bootloader does NOT respond to HID Initialize messages — use WebUSB
3. Power cycle and retry
