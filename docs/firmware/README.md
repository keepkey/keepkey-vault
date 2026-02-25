# Firmware Build & Flash Guide

## Prerequisites

- Docker (for build container `kktech/firmware:v15`)
- KeepKey device in bootloader mode (hold button while plugging in)

## Building Firmware

```bash
make firmware-build
# Equivalent to:
# cd modules/keepkey-firmware && ./scripts/build/docker/device/release.sh
```

This runs the build inside Docker. Output binaries appear in:
- `modules/keepkey-firmware/build/` — compiled firmware binaries
- `firmware.keepkey.bin` — the flashable firmware image
- `blupdater.bin` — bootloader updater

## Flashing Firmware

### Via CLI
```bash
# Device must be in bootloader mode
make firmware-flash FW_PATH=path/to/firmware.keepkey.bin

# Or directly:
make cli ARGS="firmware path/to/firmware.keepkey.bin"
```

### Entering Bootloader Mode
1. Unplug the KeepKey
2. Hold the button on the device
3. Plug it in while holding the button
4. Release when you see the bootloader screen

## Firmware Architecture

```
modules/keepkey-firmware/
├── CMakeLists.txt              # Top-level build
├── lib/
│   ├── firmware/
│   │   ├── CMakeLists.txt      # Firmware sources list
│   │   ├── messagemap.def      # Protobuf message → handler mapping
│   │   ├── fsm.c               # Main finite state machine
│   │   ├── fsm_msg_common.h    # Common message handlers
│   │   ├── fsm_msg_crypto.h    # Crypto-specific handlers
│   │   ├── coins.c             # UTXO coin definitions
│   │   └── <coin>.c            # Per-coin implementations
│   ├── board/                  # STM32F205 board support
│   └── transport/              # USB transport layer
├── include/
│   └── keepkey/firmware/
│       ├── coins.def           # UTXO coin table
│       └── <coin>.h            # Per-coin headers
└── scripts/
    └── build/docker/           # Docker build scripts
```

## Key Concepts

### Message Flow
```
USB packet → transport layer → protobuf decode → messagemap.def lookup → FSM handler
FSM handler → crypto operation → protobuf encode → transport layer → USB packet
```

### Adding a New Message
1. Define in `modules/device-protocol/messages-<coin>.proto`
2. Add enum value in `modules/device-protocol/messages.proto`
3. Map in `lib/firmware/messagemap.def`
4. Implement handler in `lib/firmware/fsm_msg_<coin>.h`

### Supported Curves
- `secp256k1` — Bitcoin, Ethereum, TRON, most coins
- `ed25519` — Solana, TON, Cosmos (some variants)
- `nist256p1` — rarely used

## Troubleshooting

### Build fails with Docker error
Ensure Docker is running and the `kktech/firmware:v15` image is available:
```bash
docker pull kktech/firmware:v15
```

### Device not responding after flash
Power cycle the device (unplug and replug). If still unresponsive, enter bootloader mode and re-flash.

### HID doesn't work in bootloader
This is expected. The bootloader does not respond to Initialize messages via HID. Use WebUSB transport for bootloader operations.
