# KeepKey Emulator as Shared Library (.dylib)

## Goal

Build the KeepKey firmware emulator as a shared library (`libkkemu.dylib`) that the
vault loads via Bun FFI. No subprocess, no UDP, no HTTP bridge — the emulator runs
in-process with direct function calls for message I/O.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              KeepKey Vault (Bun)                 │
│                                                  │
│  bun:ffi ←→ libkkemu.dylib                      │
│    kkemu_init(flash_path)                        │
│    kkemu_write(ctx, buf, len, iface)             │
│    kkemu_read(ctx, buf, len, iface)              │
│    kkemu_poll(ctx)                               │
│    kkemu_destroy(ctx)                            │
│                                                  │
│  hdwallet TransportDelegate                      │
│    writeChunk() → kkemu_write()                  │
│    readChunk()  → kkemu_read()                   │
│                                                  │
│  emulator.img (mmap'd flash)                     │
│    ~/.keepkey-vault/emulator/default.img          │
└─────────────────────────────────────────────────┘
```

## C API Surface

```c
#ifndef LIBKKEMU_H
#define LIBKKEMU_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque context — holds all emulator state (shadow_config, session, sockets, flash) */
typedef struct KKemuContext KKemuContext;

/* Interface IDs */
#define KKEMU_IFACE_MAIN  0   /* Normal device communication */
#define KKEMU_IFACE_DEBUG 1   /* DebugLink (read mnemonic, inject PIN, screenshots) */

/* ── Lifecycle ─────────────────────────────────────────────────────── */

/**
 * Create and initialize an emulator instance.
 *
 * @param flash_path  Path to the flash image file (created if absent).
 *                    Pass NULL for "emulator.img" in cwd (legacy behavior).
 * @return Opaque context pointer, or NULL on failure.
 *
 * Internally runs: setup(flash_path) → storage_init() → fsm_init() → layoutHome()
 */
KKemuContext* kkemu_init(const char *flash_path);

/**
 * Shut down and free all resources.
 * Flushes any pending storage writes. Unmaps flash file.
 */
void kkemu_destroy(KKemuContext *ctx);

/* ── Message I/O (replaces UDP sockets) ────────────────────────────── */

/**
 * Write a 64-byte HID report to the emulator.
 *
 * @param iface  KKEMU_IFACE_MAIN or KKEMU_IFACE_DEBUG
 * @param data   Exactly 64 bytes (one HID report)
 * @param len    Must be 64
 * @return 0 on success, -1 on error
 *
 * The message is queued internally. Call kkemu_poll() to process it.
 */
int kkemu_write(KKemuContext *ctx, const uint8_t *data, size_t len, int iface);

/**
 * Read a 64-byte HID report from the emulator's output queue.
 *
 * @param iface  KKEMU_IFACE_MAIN or KKEMU_IFACE_DEBUG
 * @param buf    Buffer of at least 64 bytes
 * @param len    Must be 64
 * @return Number of bytes read (64), or 0 if no message available
 *
 * Non-blocking. Returns 0 immediately if output queue is empty.
 */
int kkemu_read(KKemuContext *ctx, uint8_t *buf, size_t len, int iface);

/* ── Processing ────────────────────────────────────────────────────── */

/**
 * Run one iteration of the firmware event loop.
 *
 * Processes queued input messages, runs FSM handlers, queues output
 * messages, updates animations and display.
 *
 * Call this from your event loop (e.g. setInterval at 10-50ms).
 *
 * @return Number of messages processed, or -1 on error
 */
int kkemu_poll(KKemuContext *ctx);

/* ── Display (optional) ────────────────────────────────────────────── */

/**
 * Get the current OLED framebuffer.
 *
 * @param width   Receives display width (256)
 * @param height  Receives display height (64)
 * @return Pointer to framebuffer (width * height / 8 bytes, 1-bit per pixel).
 *         Valid until next kkemu_poll(). Do not free.
 */
const uint8_t* kkemu_get_display(KKemuContext *ctx, int *width, int *height);

/**
 * Register a callback invoked whenever the display changes.
 * Set to NULL to disable.
 */
typedef void (*kkemu_display_cb)(const uint8_t *framebuffer, int width, int height, void *user_data);
void kkemu_set_display_callback(KKemuContext *ctx, kkemu_display_cb cb, void *user_data);

/* ── Device control (convenience, same as sending protobuf messages) ── */

/**
 * Check if the emulator's storage is initialized (has a seed).
 */
int kkemu_is_initialized(KKemuContext *ctx);

/**
 * Get firmware version string (e.g. "7.14.0").
 * Returns pointer to static string inside ctx. Do not free.
 */
const char* kkemu_get_version(KKemuContext *ctx);

#ifdef __cplusplus
}
#endif

#endif /* LIBKKEMU_H */
```

## Security: Encrypted Flash with Keychain

### Threat Model

The emulator stores seed material in a 1MB flash image. Without protection,
anyone with the file can extract the mnemonic (trivially if no PIN is set,
or via fast brute-force with the emulator's 10-iteration PBKDF2).

### Defense: In-Memory Only + Keychain Encryption

**Plaintext never touches disk.** The architecture:

```
┌─────────────────────────────────────────────────────┐
│  macOS Keychain (hardware-backed on Apple Silicon)  │
│  Service: "keepkey-vault-emulator"                  │
│  Contains: 32-byte AES-256 encryption key           │
└──────────────────────┬──────────────────────────────┘
                       │ key
                       ▼
┌─────────────────────────────────────────────────────┐
│  ~/.keepkey/emulator/default.enc                    │
│  Format: [IV (12)] [AES-256-GCM ciphertext] [TAG (16)] │
│  Contains: 1MB encrypted flash image                │
└──────────────────────┬──────────────────────────────┘
                       │ decrypt into RAM only
                       ▼
┌─────────────────────────────────────────────────────┐
│  In-process memory (mlock'd, MADV_DONTDUMP)         │
│  1MB buffer — passed to dylib via pointer            │
│  Zeroed (explicit_bzero) on shutdown                 │
│  NEVER written to disk unencrypted                   │
└─────────────────────────────────────────────────────┘
```

### Lifecycle

1. **Pair** — user clicks button → generate 32 random bytes → store in Keychain
2. **Start** — read `.enc` from disk → decrypt with Keychain key → hold in memory
3. **Run** — dylib operates on the memory buffer (emulator_flash_base pointer)
4. **Save** — encrypt memory buffer → write `.enc` to disk (periodic or on-demand)
5. **Stop** — save → zero memory → release

### macOS-Only

Hard dependency on macOS Keychain. The emulator section in settings is hidden
on non-macOS platforms. This is a dev-only feature — production users use
real hardware.

## Flash Image Layout

The flash image (`emulator.img`) is a 1 MB file that mirrors the STM32's flash:

| Sector | Offset     | Size   | Purpose                |
|--------|------------|--------|------------------------|
| 0      | 0x00000    | 16 KiB | Bootstrap (unused in emu) |
| 1      | 0x04000    | 16 KiB | Storage slot A         |
| 2      | 0x08000    | 16 KiB | Storage slot B         |
| 3      | 0x0C000    | 16 KiB | Storage slot C         |
| 4      | 0x10000    | 64 KiB | (unused)               |
| 5-6    | 0x20000    | 256 KiB| Bootloader area        |
| 7+     | 0x60000    | ~640 KiB| Application code area |

Storage slots A/B/C implement wear leveling — only one is "active" at a time
(identified by a magic header). The firmware rotates through them on each write.

### What's in a Storage Slot

Each slot contains a `ConfigFlash` struct:
- **Public section** (plaintext): label, language, PIN hash, policies, U2F counter
- **Secret section** (encrypted): master HD node, BIP-39 mnemonic, PIN, auth data
- **Encryption**: AES-256 using a key derived from the user's PIN
  - No PIN set → secrets stored with a default key (still encrypted struct, but trivially recoverable)

### Storage Location Strategy

```
~/.keepkey-vault/
  emulator/
    default.img          ← default emulator flash (created on first use)
    test-seed-1.img      ← named environments
    test-seed-2.img
```

- **`flash_path` parameter** controls which image file is used
- Creating a new image = fresh device (uninitialized, no seed)
- Copying an image = cloning a device state
- Each image is independent — multiple emulators can run with different seeds
- Images are portable across machines (same byte layout as STM32 flash)

### Security Considerations

1. **Emulator images contain seed material** — the `.sec` section holds the
   encrypted mnemonic. With no PIN or a known PIN, the seed is recoverable.
   Treat `*.img` files like wallet backups.

2. **DebugLink exposes plaintext mnemonic** — when `DEBUG_LINK` is compiled in
   (default for emulator builds), any code with access to the context can read
   the mnemonic via `fsm_msgDebugLinkGetState()`. This is intentional for testing.

3. **File permissions** — images should be created with `0600` (owner read/write only).
   The dylib should enforce this on creation.

4. **No hardware RNG** — the emulator uses `/dev/urandom` instead of the STM32's
   hardware TRNG. This is fine for testing but generated seeds should never be
   used for real funds.

## Firmware Source Changes Required

### Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `tools/emulator/main.cpp` | Extract init/loop into library entry points | ~30 lines |
| `lib/emulator/setup.c` | Accept `flash_path` param instead of hardcoded filename | ~5 lines |
| `lib/emulator/udp.c` | Add ring buffer I/O alongside (or replacing) UDP sockets | ~80 lines |
| `lib/board/udp.c` | `usbPoll()` reads from ring buffer when in dylib mode | ~10 lines |
| `lib/board/usb.c` | `msg_write()` writes to ring buffer when in dylib mode | ~10 lines |
| `tools/emulator/CMakeLists.txt` | Add `SHARED` library target alongside executable | ~15 lines |

### New Files

| File | Purpose |
|------|---------|
| `tools/emulator/libkkemu.h` | Public C API header (above) |
| `tools/emulator/libkkemu.c` | API implementation — thin wrapper around existing firmware functions |
| `lib/emulator/ringbuf.c` | Lock-free ring buffer for message queues (main + debug, in + out = 4 queues) |

### Key Principle

**Minimal firmware changes.** The dylib wrapper should call the same functions that
`main()` calls today. We're not refactoring the firmware — we're wrapping it.

The only structural change is replacing the UDP socket I/O with ring buffer I/O
so the host process can write/read messages directly without network round-trips.

## Bun FFI Integration

```typescript
import { dlopen, FFIType, ptr, toBuffer, toArrayBuffer } from 'bun:ffi'

const lib = dlopen('libkkemu.dylib', {
  kkemu_init:    { args: [FFIType.cstring], returns: FFIType.ptr },
  kkemu_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  kkemu_write:   { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  kkemu_read:    { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  kkemu_poll:    { args: [FFIType.ptr], returns: FFIType.i32 },
  kkemu_get_display: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
})

// hdwallet TransportDelegate implementation
class EmuTransportDelegate {
  private ctx: number  // pointer

  constructor(flashPath: string) {
    this.ctx = lib.symbols.kkemu_init(Buffer.from(flashPath + '\0'))
    if (!this.ctx) throw new Error('Failed to init emulator')
    // Start polling loop
    setInterval(() => lib.symbols.kkemu_poll(this.ctx), 16)  // ~60fps
  }

  async writeChunk(buf: Uint8Array, debugLink: boolean): Promise<void> {
    const rc = lib.symbols.kkemu_write(this.ctx, ptr(buf), buf.length, debugLink ? 1 : 0)
    if (rc !== 0) throw new Error('kkemu_write failed')
  }

  async readChunk(debugLink: boolean): Promise<Uint8Array> {
    const buf = new Uint8Array(64)
    // Poll until data available (with timeout)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      lib.symbols.kkemu_poll(this.ctx)
      const n = lib.symbols.kkemu_read(this.ctx, ptr(buf), 64, debugLink ? 1 : 0)
      if (n > 0) return buf
      await Bun.sleep(5)
    }
    throw new Error('kkemu_read timeout')
  }

  async disconnect(): Promise<void> {
    lib.symbols.kkemu_destroy(this.ctx)
    this.ctx = 0
  }
}
```

## Build System

### CMake (in firmware repo)

```cmake
# Shared library target
add_library(kkemu_shared SHARED
  tools/emulator/libkkemu.c
  lib/emulator/ringbuf.c
)
target_link_libraries(kkemu_shared
  kkfirmware kkboard kkvariant kktransport kkrand
  trezorcrypto c m
)
set_target_properties(kkemu_shared PROPERTIES
  OUTPUT_NAME "kkemu"
  VERSION ${FIRMWARE_VERSION}
)

# Standalone binary (uses the same library)
add_executable(kkemu tools/emulator/main.cpp)
target_link_libraries(kkemu kkemu_shared)
```

### Build Commands

```bash
cd modules/keepkey-firmware
mkdir -p build && cd build
cmake .. -C ../cmake/caches/emulator.cmake -DBUILD_SHARED=ON
make kkemu_shared   # produces libkkemu.dylib
make kkemu          # produces kkemu binary (optional, for standalone testing)
```

### Vault Integration

```json
// projects/keepkey-vault/package.json
{
  "scripts": {
    "build:emulator": "cd ../../modules/keepkey-firmware && make -C build kkemu_shared"
  }
}
```

The `.dylib` gets copied to the vault's native modules directory during build.

## Implementation Order

1. **Ring buffer** — `lib/emulator/ringbuf.c` (standalone, testable)
2. **libkkemu API** — `tools/emulator/libkkemu.c` + `.h` (wraps existing functions)
3. **CMake target** — build as `.dylib`
4. **Bun FFI wrapper** — `src/bun/emulator.ts` (TransportDelegate using FFI)
5. **Engine integration** — emulator as transport option in engine-controller
6. **Settings UI** — emulator section in DeviceSettingsDrawer

## Open Questions

1. **DebugLink in production builds?** — useful for testing (read OLED, inject PIN)
   but exposes mnemonic. Maybe compile two variants: `libkkemu.dylib` (with debug)
   and `libkkemu-release.dylib` (without)?

2. **Thread safety** — all firmware code is single-threaded. The dylib must only be
   called from one thread. Bun's main thread is fine since everything is async/callback.

3. **Multiple instances** — the firmware uses many static globals. Supporting multiple
   emulator instances simultaneously would require significant refactoring. Start with
   one instance (the common case).

4. **OLED rendering in vault UI** — the display callback could stream framebuffer data
   to the frontend, rendering the emulator's screen in a `<canvas>`. Nice for debugging
   but not required for V1.
