# Fault-Injection Library — KeepKey Stack Relevance Analysis

## Repository Overview

**Name:** Findus (fault-injection-library)
**Author:** Dr. Matthias Kesenheimer
**License:** GPL v3
**Version:** 1.13.1
**Repository:** `github.com/MKesenheimer/fault-injection-library`
**Hardware:** Pico Glitcher (v1/v2/v3), ChipWhisperer Pro, ChipWhisperer Husky

A Python-based toolchain for performing voltage glitching fault-injection attacks on microcontrollers. The library provides parameter-space exploration, automated campaign management with SQLite-backed databases, web-based visualization, and a genetic algorithm for optimizing attack parameters.

---

## Architecture

```
findus/                     # Core Python library (pip install findus)
├── findus.py               # Database, Serial, PicoGlitcher, Glitcher base classes
├── STM32Bootloader.py      # STM32 UART bootloader protocol (8E1, ACK/NACK framing)
├── DebugInterface.py       # OpenOCD/GDB integration (SWD, JTAG, ST-Link)
├── GlitchState.py          # Response classification enums (Success/Error/Warning/Expected)
├── GeneticAlgorithm.py     # Evolutionary parameter optimization
├── AnalogPlot.py           # ADC voltage trace visualization
├── ProGlitcher.py          # ChipWhisperer Pro driver
├── HuskyGlitcher.py        # ChipWhisperer Husky driver
├── firmware/               # Pico Glitcher MicroPython firmware
│   ├── PicoGlitcher.py     # State machine control, trigger detection
│   ├── PulseGenerator.py   # Glitch waveform generation
│   ├── AD910X.py           # DDS chip for analog pulse shaping
│   ├── FastADC.py          # ADC sampling during glitch
│   ├── Statemachines.py    # RP2040 PIO state machines
│   └── config_v*/          # Hardware version configs (JSON)
├── analyzer/               # Dash web app for campaign visualization
└── helper/                 # Upload, power cycle, database utilities

projects/                   # Target-specific attack implementations
├── stm32l422/              # *** MOST RELEVANT TO KEEPKEY ***
├── stm32f40x/              # STM32F4 bootloader glitching
├── stm32f42x/              # STM32F42x bootloader glitching
├── stm32f412/              # STM32F412 bootloader glitching
├── stm32l05x/              # STM32L0 RDP downgrade
├── nrf52832/               # Nordic nRF52 (AirTag, keyboards)
├── rp2040/                 # Raspberry Pi Pico
├── rp2350/                 # Raspberry Pi Pico 2
├── esp32v1.3/              # Espressif ESP32
├── atmega328p/             # Atmel ATmega328P
├── lpc1311/                # NXP LPC1311
└── stm8s/                  # STM8S series
```

---

## Attack Methodology

### Voltage Glitching Flow

1. Power up target MCU
2. Establish trigger condition (GPIO rising edge, UART byte pattern, edge count)
3. Wait configurable **delay** (nanoseconds) after trigger for vulnerable code window
4. Apply voltage **glitch** (crowbar MOSFET shorts VCC to GND for nanoseconds)
5. Read device response (UART bootloader, SWD debugger, GPIO state)
6. Classify result: `Success` / `Expected` / `Error` / `Warning`
7. Store parameters + result in SQLite database
8. Repeat with randomized or genetically-optimized parameters

### Glitch Types

| Type | Mechanism | Resolution | Use Case |
|------|-----------|------------|----------|
| Crowbar (LP) | IRLML2502 MOSFET shorts VCC→GND | ~5ns | Most targets, sharp edges |
| Crowbar (HP) | SI4134DY MOSFET (66A capacity) | ~10ns | Large decoupling caps |
| Multiplexing | Switch between 4 voltage levels in ~1ns | ~1ns | Precision voltage manipulation |
| Pulse Shaping | AD910X DDS analog waveform | Continuous | Complex glitch profiles |
| Burst | N repeated pulses with configurable spacing | Per-pulse | RDP downgrade on STM32L4 |

### Parameter Space

| Parameter | Typical Range | Purpose |
|-----------|---------------|---------|
| `delay` | 100 – 10,000,000 ns | Time from trigger to glitch |
| `length` | 10 – 10,000 ns | Glitch duration |
| `delay_between` | 100 – 100,000 ns | Inter-pulse spacing (burst mode) |
| `number_of_pulses` | 1 – 18 | Pulse count in burst |

---

## KeepKey-Relevant Targets

### STM32L422 — RDP Downgrade Attack

**Location:** `projects/stm32l422/`
**MCU:** STM32L422 (ARM Cortex-M4, ultra-low-power)
**Attack:** Read-Out Protection (RDP) Level 1 → Level 0 downgrade via voltage glitch

**Why this matters:** The STM32L4 family is used in secure embedded applications. The RDP mechanism protects flash contents (firmware, keys, seeds) from extraction via debug interfaces. This attack bypasses that protection.

#### Attack Flow (stm32l4-rdp-downgrade.py)

```
1. Program target with test firmware + enable RDP Level 1
2. Load RDP-downgrade ELF to RAM via SWD (rdp-downgrade-stm32l422.elf)
   - This program triggers RDP downgrade from Level 1 → Level 0
   - Toggles GPIO PA12 as trigger signal
3. Configure Pico Glitcher:
   - Trigger: rising edge on PA12 (TRIGGER pin)
   - Glitch: burst of 18 pulses
   - Parameters: delay + length randomized per experiment
4. ARM the glitcher, then execute the RAM program
5. Glitch fires during RDP register verification
6. After power cycle, attempt to read flash at 0x08000000 via SWD
7. Classify result:
   - "RDP inactive" → SUCCESS (flash readable)
   - "RDP active" → Expected (protection held)
   - "RDP value modified" → SUCCESS (RDP register corrupted)
8. On success: dump entire flash memory to binary file
```

#### Key Technical Details

- **Target address:** `0x08000000` (flash base)
- **Debug interface:** ST-Link via SWD (`hla_swd` transport)
- **OpenOCD target config:** `target/stm32l4x.cfg`
- **Burst mode:** 18 glitch pulses per attempt
- **Voltage during glitch:** Target powered at 2.2V (reduced from 3.3V) for easier glitching
- **RDP values:** `0xAA` = Level 0 (unprotected), `0xCC` = Level 2 (permanent), anything else = Level 1
- **PCROP monitoring:** Proprietary Code ReadOut Protection bits tracked separately; if set, bootloader masks responses with zeros

#### Physical Connections (LQFP32 package)

| Signal | Pin | STM32 | Purpose |
|--------|-----|-------|---------|
| UART TX | 19 | PA9 | Serial output |
| UART RX | 20 | PA10 | Serial input |
| SWDIO | 23 | PA13 | Debug data |
| SWDCLK | 24 | PA14 | Debug clock |
| LED ERROR | 2 | PC14 | Error indicator |
| LED OK | 3 | PC15 | Status indicator |
| TRIGGER | 22 | PA12 | Glitch trigger output |

#### Companion Script: Register Brute Force (register-brute-force.py)

Steps through addresses 0x8000404 – 0x8000804 in 4-byte increments, loading each address into all CPU registers (r0–r12, PC, SP), single-stepping, and checking for side-effects. Based on [Include Security's Cortex-M0 firmware dumping technique](https://blog.includesecurity.com/2015/11/firmware-dumping-technique-for-an-arm-cortex-m0-soc/).

### STM32F40x — Bootloader Read Memory Bypass

**Location:** `projects/stm32f40x/`
**Attack:** Glitch bootloader during `Read Memory` (0x11) command to bypass RDP check

#### Attack Flow (stm32f4-glitching.py)

```
1. Reset target into bootloader mode
2. Initialize bootloader via UART (send 0x7F, expect ACK 0x79)
3. Send Read Memory command: 0x11 0xEE
   - UART trigger configured on byte 0x11
   - Glitch fires after configurable delay from trigger byte
4. Bootloader checks RDP:
   - Normal: Returns NACK (0x1F) — "RDP active"
   - Glitched: Returns ACK (0x79) — "RDP inactive" → can read memory
5. On ACK: send address (0x08000000) + length (0xFF) + checksums
6. Read 255 bytes of flash memory
7. Repeat with incrementing addresses to dump entire flash
```

#### UART Bootloader Protocol (STM32Bootloader.py)

```
Serial config: 115200 baud, 8E1 (8 data bits, even parity, 1 stop bit)

Init:      TX → 0x7F             → RX ← ACK (0x79) or NACK (0x1F)
Get ID:    TX → 0x02 0xFD        → RX ← ACK + 3-byte chip ID
Read Mem:  TX → 0x11 0xEE        → RX ← ACK (success) or NACK (RDP active)
           TX → ADDR[4] + XOR    → RX ← ACK
           TX → SIZE[1] + ~XOR   → RX ← ACK + data[SIZE]

Checksum:  XOR of all bytes (address), or complement XOR (size)
```

### STM32F42x — V_CAP Line Glitching

**Location:** `projects/stm32f42x/`
**Key difference:** Glitch inserted on internal V_CAP line (requires removing V_CAP_1 and V_CAP_2 capacitors from board)
**Successful parameters (CW Pro):** delay=90,500–91,500 ns, length=230–240 ns

### STM32F412 — Same bootloader attack

**Location:** `projects/stm32f412/`
**Successful parameters (Pico Glitcher):** delay=103,000–105,000 ns, length=225–235 ns
**Notable:** Flash gets erased occasionally during glitching; only 96 successful reads needed out of ~15,000 attempts for full bootloader dump (~24kB)

---

## KeepKey Stack Relevance Matrix

### Direct Hardware Overlap

| Component | KeepKey Stack | Findus Target | Match |
|-----------|--------------|---------------|-------|
| MCU Family | STM32 (various) | STM32L4, STM32F4 | Direct |
| Debug Interface | SWD (SWDIO/SWDCLK) | SWD via ST-Link | Direct |
| Boot Mode | System bootloader (ROM) | UART bootloader protocol | Direct |
| Protection | RDP (Read-Out Protection) | RDP bypass via glitching | Direct |
| USB Transport | WebUSB/HID/Interrupt | Not targeted (UART focus) | Indirect |
| Firmware | Custom (hdwallet integration) | Generic test programs | Indirect |

### Attack Surface Analysis

**Physical access required:** Yes — voltage glitching requires direct electrical connection to target MCU power rails.

**Equipment cost:** ~$200 (Pico Glitcher) or ~$3,000 (ChipWhisperer Pro)

**Time to exploit:** Minutes to hours per campaign (15,000 experiments at ~1 experiment/second = ~4 hours for STM32F412 bootloader dump)

**Destructive risk:** Glitching can erase flash or set PCROP bits — attacker risks destroying the data they're trying to extract.

### What Could Be Extracted

If RDP is bypassed on a KeepKey device:

1. **Firmware binary** — Full flash dump enables reverse engineering
2. **BIP-39 seed words** — If stored in flash (depends on storage architecture)
3. **Private keys** — Derived key material in flash/SRAM
4. **Device configuration** — PIN hash, settings, metadata
5. **Bootloader code** — System memory at 0x1FFF0000 (useful for finding additional vulnerabilities)

### Applicable Mitigations

| Mitigation | Effectiveness | Notes |
|------------|--------------|-------|
| RDP Level 2 (permanent) | High | Irreversible; cannot be downgraded. But disables SWD permanently |
| Voltage monitoring (brown-out detection) | Medium | MCU can detect supply drops; may reset before glitch takes effect |
| Decoupling capacitors | Low | Absorb short glitches; defeated by high-power MOSFETs |
| Tamper detection mesh | High | Physical layer; detects board modification |
| Secure element (separate chip) | High | Keys stored in dedicated SE, not in MCU flash |
| PCROP (Proprietary Code ReadOut Protection) | Medium | Masks flash reads even if RDP bypassed; but can be unset |
| Redundant RDP checks in firmware | Medium | Multiple verification points harder to glitch simultaneously |
| Clock jitter / randomization | Medium | Makes timing-based attacks less reproducible |

---

## Core Library Capabilities

### Database (findus.py)

- SQLite storage for all campaign experiments
- Columns: `experiment_id`, `delay`, `length`, custom params, `color` (classification), `response`
- Resume support: continue campaigns across sessions
- Cleanup: remove expected results to reduce DB size
- Web visualization via analyzer dashboard

### PicoGlitcher (findus.py)

- Controls Pico Glitcher hardware via MicroPython REPL over USB serial
- Trigger modes: rising edge, falling edge, UART byte match, edge counting
- Glitch modes: single, double, burst (N pulses), multiplexing, pulse shaping
- Power control: `power_cycle_target()`, `power_cycle_reset()`, `reset_target()`
- MOSFET selection: `set_lpglitch()` (precision), `set_hpglitch()` (high current)
- ADC sampling: capture voltage trace during glitch for oscilloscope-like analysis

### DebugInterface (DebugInterface.py)

- OpenOCD process management (start/stop/attach/detach)
- GDB integration for loading ELF to RAM
- Flash programming with RDP level control
- Memory read/write at arbitrary addresses
- RDP + PCROP register inspection
- Target unlock (RDP removal + mass erase) and lock (RDP enable)

### GeneticAlgorithm (GeneticAlgorithm.py)

- Evolutionary parameter optimization for finding successful glitch windows
- Population-based search with breeding, mutation, health-based selection
- Parameter space binning with weighted exploration
- Malus factors to prevent redundant parameter exploration
- `OptimizationController` orchestrates the search lifecycle

### Response Classification (GlitchState.py)

```python
Success:    rdp_inactive, dump_ok, dump_successful, dump_finished
Expected:   rdp_active (protection held — normal behavior)
Error:      nack, no_response, bootloader_not_available, bootloader_error
Warning:    flash_reset, timeout
OK:         ack, bootloader_ok, dump_error (partial success)
```

Color mapping for visualization:
- **Green (G):** Expected behavior (RDP active)
- **Red (R):** Success (RDP bypassed)
- **Yellow (Y):** Timeout
- **Magenta (M):** Error
- **Cyan (C):** Warning (flash may have been erased)
- **Blue (B):** Other failure

---

## Hardware Specifications

### Pico Glitcher v1

- **MCU:** Raspberry Pi Pico (RP2040, 125MHz, dual Cortex-M0+)
- **Glitch MOSFETs:** IRLML2502 (LP, precise) + SI4134DY (HP, 66A)
- **Level shifters:** Bidirectional for 1.8V–5V compatibility
- **Power supply:** 1.8V, 3.3V, 5V taps; software-controllable VTARGET
- **Trigger:** Single GPIO input (rising/falling edge)

### Pico Glitcher v2

- **Additions:** Multiplexing stage (4 voltage levels), Schmitt trigger inputs (EXT1, EXT2)
- **Multiplexing:** ~1ns switching between voltage levels for precision glitch shaping

### Pico Glitcher v3

- **MCU:** Raspberry Pi Pico 2 (higher clock = better timing resolution)
- **Power supply:** 1.2V, 1.8V, 3.3V, 5V
- **Improved Schmitt triggers:** Better noise rejection on trigger inputs

---

## Analyzer Tool

Web-based campaign visualization:

```bash
analyzer --directory databases
# Opens http://127.0.0.1:8080
```

Features:
- 2D/3D parameter space heatmaps (delay vs. length vs. result)
- Color-coded scatter plots by classification
- Interactive filtering and zoom
- Campaign statistics and timing
- Database selector for multiple campaigns

---

## Referenced Research

- [Glitching the STM32F4](https://mkesenheimer.github.io/blog/glitching-the-stm32f4.html) — Detailed writeup by library author
- [Include Security: Firmware Dumping for ARM Cortex-M0](https://blog.includesecurity.com/2015/11/firmware-dumping-technique-for-an-arm-cortex-m0-soc/) — Register brute force technique
- [STM32 Bootloader AN2606](https://www.st.com/resource/en/application_note/an2606-stm32-microcontroller-system-memory-boot-mode-stmicroelectronics.pdf) — Official bootloader documentation
- [STM32F4 Hardware AN4488](https://www.st.com/resource/en/application_note/an4488-getting-started-with-stm32f4xxxx-mcu-hardware-development-stmicroelectronics.pdf) — Power supply design showing V_CAP insertion points
- [Pico Glitcher v3](https://mkesenheimer.github.io/blog/pico-glitcher-v3.html) — Hardware design details
- [Findus documentation](https://fault-injection-library.readthedocs.io/) — Full library docs
- [Pico Glitcher store](https://faultyhardware.de) — Hardware purchase

---

## Dependencies

```
Python: >=3.8
Packages: adafruit-ampy, pyserial, plotly, pandas, dash, matplotlib, scipy
Optional: rd6006 (Riden power supply control)
System: OpenOCD, arm-none-eabi-gdb, ST-Link drivers
Platform: Linux/macOS (serial device paths)
```

Install: `pip install findus`
