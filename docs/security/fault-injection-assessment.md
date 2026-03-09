# Fault-Injection Vulnerability Assessment

**Date:** 2026-03-06
**Sources:** Findus fault-injection-library (Dr. Matthias Kesenheimer), KeepKey firmware source, prior disclosures (VULN-21020, CVE-2022-30330, Kraken write-up)
**Related docs:** `fault.md` (hardening analysis), `findus-library-analysis.md` (toolchain details)

---

## MCU Identification

**Chip:** STM32F205 (ARM Cortex-M3, 120 MHz)
**Package:** LQFP-144
**Flash:** 1 MB (sectors 0-11)
**SRAM:** 128 KB
**RDP:** Level 2 (`OPTION_RDP = 0xCCFF`) — **irreversible, permanently disables debug**

The Findus library targets STM32F4xx (Cortex-M4) and STM32L4xx (Cortex-M4). KeepKey uses STM32F2xx (Cortex-M3). Same vendor, similar architecture, but different BootROM and option-byte behavior.

---

## Verdict Summary

| # | Finding | Verdict | Action |
|---|---------|---------|--------|
| F1 | BootROM RDP downgrade via voltage glitch | **NOT APPLICABLE** | RDP Level 2 is irreversible |
| F2 | Bootloader UART Read Memory bypass | **NOT APPLICABLE** | RDP L2 disables bootloader memory commands |
| F3 | `signatures_ok()` early-return chain | **WORTH PATCHING** | Infective aggregation eliminates single-fault bypass |
| F4 | No BOR/PVD voltage monitoring | **WORTH RESEARCHING** | STM32F2 supports BOR option bytes + PVD interrupt |
| F5 | Firmware-side re-invocation of `signatures_ok()` | **WORTH PATCHING** | Replace with short metadata check (VULN-21020 fix) |
| F6 | `fi_defense_delay` brute-force window | **ALREADY PATCHED** | Randomized 0-20K iteration loop with dual-variable invariant |
| F7 | MPU privilege separation | **ALREADY PATCHED** | 8-region MPU config, flash read-only, flash-controller privileged-only |
| F8 | `svhandler_flash_*` range check bypass | **ALREADY PATCHED** | Overlap-aware validation merged (post CVE-2022-30330) |
| F9 | Storage encryption (mnemonic in flash) | **ALREADY PATCHED** | AES-256 encrypted secrets, PIN-wrapped key, SCA-hardened AES |
| F10 | No boot-loop quarantine / reset telemetry | **WORTH RESEARCHING** | Persistent fault counter would detect glitch campaigns |
| F11 | No PCROP enforcement | **WORTH RESEARCHING** | Defense-in-depth layer available on STM32F2 |
| F12 | Stack canary at privilege boundary | **ALREADY PATCHED** | `__stack_chk_guard = fi_defense_delay(random32())` |

---

## Detailed Analysis

### F1: BootROM RDP Downgrade — NOT APPLICABLE

**Findus attack:** `projects/stm32l422/stm32l4-rdp-downgrade.py` — loads RDP-downgrade ELF to RAM via SWD, glitches during option-byte write to downgrade RDP L1 → L0.

**Why not applicable to KeepKey:**

KeepKey firmware sets **RDP Level 2** (`0xCC` in option bytes):

```c
// memory.h:87
#define OPTION_RDP 0xCCFF  // RDP Level 2 (Irreversible)
```

RDP Level 2 on STM32F2:
- **Permanently** disables JTAG/SWD debug access — cannot be re-enabled
- **Cannot be downgraded** — any attempt triggers mass erase + permanent lock
- BootROM enforces this in silicon; no software or voltage glitch can reverse it
- The Findus STM32L422 attack specifically targets L1→L0 downgrade; L2 is out of scope

**Confidence:** High. RDP L2 is silicon-enforced. The entire `stm32l4-rdp-downgrade.py` attack chain requires SWD access to load the downgrade ELF, which RDP L2 blocks at the hardware level.

**Caveat:** This assumes production devices have RDP L2 programmed. Debug builds (`DEBUG_ON`) skip `memory_protect()`:
```c
#if !defined(DEBUG_ON) && (MEMORY_PROTECT == 0)
#error "To compile release version, please set MEMORY_PROTECT flag"
#endif
```
Build system correctly enforces this as a compile-time error.

---

### F2: Bootloader UART Read Memory Bypass — NOT APPLICABLE

**Findus attack:** `projects/stm32f40x/stm32f4-glitching.py` — enters UART bootloader, sends `0x11 0xEE` (Read Memory), glitches during RDP check so bootloader returns ACK instead of NACK.

**Why not applicable:**

Under RDP Level 2, the STM32 system bootloader **disables memory-read commands entirely**. The BootROM doesn't even reach the RDP check — the command is rejected at the protocol level.

From ST's reference manual (RM0033, STM32F2): "When RDP Level 2 is active, all protections provided by Level 1 are active and the MCU is fully protected. The RDP Level 2 is an irreversible protection."

Additionally, JTAG/SWD are permanently disabled, preventing the `register-brute-force.py` attack which requires SWD stepping.

**Confidence:** High.

---

### F3: `signatures_ok()` Early-Return Chain — WORTH PATCHING

**Current code** (`lib/board/signatures.c:33-92`):

```c
int signatures_ok(void) {
  // 6 early returns for SIG_FAIL (index validation)
  // 3 early returns for KEY_EXPIRED (key validity)
  sha256_Raw(app, codelen, digest);  // ~0.5-1s on STM32F2
  if (ecdsa_verify_digest(...sig1...) != 0) return SIG_FAIL;  // early return
  if (ecdsa_verify_digest(...sig2...) != 0) return SIG_FAIL;  // early return
  if (ecdsa_verify_digest(...sig3...) != 0) return SIG_FAIL;  // early return
  return SIG_OK;
}
```

**Vulnerability:** Each `ecdsa_verify_digest` call is followed by an early return. A single voltage glitch that corrupts the return value or skips the `if` branch causes the function to fall through to the next check (or to `return SIG_OK`) — this is the classic "instruction skip" fault model.

**What `fault.md` recommends (and is correct):**

Replace early-return chain with infective aggregation:
```c
int r1 = ecdsa_verify_digest(...sig1...);
int r2 = ecdsa_verify_digest(...sig2...);
int r3 = ecdsa_verify_digest(...sig3...);
uint32_t acc = (r1 | r2 | r3);
return (acc == 0) ? SIG_OK : SIG_FAIL;
```

This forces the attacker to corrupt all three verify results, not just one branch.

**Additional recommendation:** Double-compute SHA-256 with constant-time comparison before use (catches transient fault during hash computation).

**Priority:** HIGH. Even with RDP L2 preventing direct flash readout, a faulted signature check could allow booting unsigned/malicious firmware that exfiltrates secrets at runtime.

---

### F4: No BOR/PVD Voltage Monitoring — WORTH RESEARCHING

**Current state:** Zero references to BOR, PVD, PWR_CR, or VDDA in the entire firmware codebase. The MCU's built-in voltage monitoring is completely unused.

**What STM32F2 offers:**
- **BOR (Brown-Out Reset):** Configurable via option bytes. Holds MCU in reset when VDD drops below threshold (1.8V / 2.1V / 2.4V / 2.7V). This directly defeats crowbar glitches that drop voltage.
- **PVD (Programmable Voltage Detector):** Interrupt-capable comparator. Can fire EXTI interrupt when VDD crosses configurable threshold, allowing firmware to abort crypto operations.

**Why worth researching (not "worth patching" yet):**
1. BOR is an option-byte setting — changing it on deployed devices requires careful update flow
2. Must verify BOR threshold doesn't interfere with normal operation (cold starts, battery sag)
3. PVD interrupt latency on STM32F2 needs measurement against glitch pulse widths (5-10ns glitch vs ~100ns interrupt latency)
4. Even if PVD can't catch every glitch, BOR at the right threshold eliminates the entire "gray zone" attack surface

**Recommended research:**
- Measure KeepKey's actual VDD rail behavior during normal operation
- Test BOR Level 3 (2.7V threshold) for false-positive rate
- Prototype PVD interrupt handler that sets fault flag + aborts crypto
- Evaluate whether Pico Glitcher's crowbar pulse would trigger BOR reset

---

### F5: Firmware Re-Invocation of `signatures_ok()` — WORTH PATCHING

**Current code** (`tools/firmware/keepkey_main.c:177-179`):

```c
int sigRet = SIG_FAIL;
sigRet = signatures_ok();       // ~1 second long-running crypto
flash_collectHWEntropy(SIG_OK == sigRet);
```

This is the VULN-21020 class: firmware re-runs the full signature verification after the bootloader already verified it. The long computation window (~1 second) gives the attacker a wide timing window for glitching.

**`fault.md` recommended fix:** Replace with short metadata presence check:
```c
// Instead of re-running signatures_ok():
return *(volatile uint8_t*)FLASH_META_SIGINDEX1 != 0;
```

Or better: use a bootloader-to-firmware attestation token (redundancy-encoded value in backup SRAM).

**Priority:** HIGH. This is a documented vulnerability class with a known fix direction.

---

### F6: `fi_defense_delay` — ALREADY PATCHED (adequate)

**Implementation** (`lib/board/timer.c:239-257`):

```c
uint32_t fi_defense_delay(volatile uint32_t value) {
  int wait = random32() & 0x4fff;  // 0-20479 random iterations
  volatile int i = 0;
  volatile int j = wait;
  while (i < wait) {
    if (i + j != wait) shutdown();  // invariant check every iteration
    ++i; --j;
  }
  if (i != wait || j != 0) shutdown();  // final check
  return value;
}
```

**Assessment:** This is a well-designed fault detection loop:
- Random timing defeats deterministic delay attacks
- Dual-variable invariant (`i + j == wait`) catches single-variable corruption
- Final boundary check catches late-stage loop exit faults
- `volatile` prevents compiler optimization
- `shutdown()` is terminal (no recovery path to skip)

**Used at critical decision points:**
- `fi_defense_delay(trust)` — wraps signature decision before boot
- `fi_defense_delay(random32())` — wraps stack canary init
- `fi_defense_delay(storage_protect_status())` — wraps storage protection check

**Remaining risk:** Multi-instruction-skip fault model could potentially skip both the invariant check AND the loop increment. However, the random iteration count means the attacker doesn't know when to fire. Adequate for the threat model.

---

### F7-F9: MPU, Flash Gate, Storage Encryption — ALREADY PATCHED

These are well-implemented:

- **MPU:** 8 regions, flash read-only from unprivileged, flash controller privileged-only, SRAM XN
- **Flash gate:** SVC handlers with overlap-aware range validation (post CVE-2022-30330 fix)
- **Storage:** AES-256 encrypted secrets with SCA-hardened AES implementation (`deps/sca-hardening/SecAESSTM32`), PIN-wrapped key

---

### F10: No Boot-Loop Quarantine — WORTH RESEARCHING

**Current state:** No persistent counter tracks abnormal resets during boot. An attacker running a glitch campaign (15,000+ resets over 4-6 hours) goes completely undetected by firmware.

**Recommendation from `fault.md`:**
```c
// On each boot, read reset flags:
if (RCC_CSR & BORRSTF) boot_fault_cnt++;
if (boot_fault_cnt > MAX_ALLOWED) enter_safe_boot();
```

Store counter in backup registers or backup SRAM with redundant encoding (value + complement + CRC).

**Why "research" not "patch":**
- Need to determine appropriate threshold (legitimate rapid resets during firmware update vs attack)
- Counter storage in backup SRAM survives soft reset but not power cycle — attacker can clear it
- Best paired with BOR (F4) so that voltage drops actually trigger BOR reset flag
- May cause false positives during development/testing

---

### F11: No PCROP — WORTH RESEARCHING

**Current state:** PCROP (Proprietary Code ReadOut Protection) bits not configured. PCROP provides per-sector code-execute-only protection — even if RDP is somehow bypassed, PCROP-protected sectors return zeros when read.

**Why worth researching:**
- STM32F2 PCROP support needs verification (some F2 variants don't support it)
- Could protect bootloader code (sectors 5-6) from reverse engineering
- Doesn't protect storage sectors (need read/write), so limited value for seed protection
- Requires careful flash layout planning

---

### F12: Stack Canary — ALREADY PATCHED

```c
// bootloader/main.c:328
__stack_chk_guard = fi_defense_delay(random32());
```

Randomized at boot, wrapped in fault-detection delay. Adequate.

---

## Priority Matrix

### Tier 1: WORTH PATCHING (firmware changes, no hardware)

| ID | Fix | Effort | Impact |
|----|-----|--------|--------|
| F3 | Infective aggregation in `signatures_ok()` — remove early returns | 2-4 hours | Eliminates single-fault signature bypass |
| F5 | Remove firmware-side `signatures_ok()` re-invocation (VULN-21020 fix) | 2-4 hours | Eliminates 1-second timing window for glitch |

Both are code-only changes in `lib/board/signatures.c` and `tools/firmware/keepkey_main.c`. No hardware modification needed. Combined effort ~1 day including testing.

### Tier 2: WORTH RESEARCHING (may need hardware or option-byte changes)

| ID | Research | Effort | Impact |
|----|----------|--------|--------|
| F4 | BOR option-byte threshold + PVD interrupt handler | 1-2 weeks | Hardware-level glitch rejection |
| F10 | Boot-loop quarantine with persistent fault counter | 3-5 days | Detects glitch campaigns |
| F11 | PCROP availability/applicability on STM32F205 | 1-2 days | Defense-in-depth for bootloader code |

### Tier 3: ALREADY PATCHED / NOT APPLICABLE

| ID | Status | Why |
|----|--------|-----|
| F1 | NOT APPLICABLE | RDP Level 2 is irreversible — SWD permanently disabled |
| F2 | NOT APPLICABLE | RDP L2 disables bootloader memory commands |
| F6 | ALREADY PATCHED | `fi_defense_delay` with random timing + dual invariant |
| F7 | ALREADY PATCHED | 8-region MPU, flash RO, flash-controller privileged |
| F8 | ALREADY PATCHED | Overlap-aware flash gate (post CVE-2022-30330) |
| F9 | ALREADY PATCHED | AES-256 encrypted secrets, SCA-hardened AES |
| F12 | ALREADY PATCHED | Randomized stack canary wrapped in fault detection |

---

## Relationship to Findus Attack Scripts

| Findus Script | Target | KeepKey Applicable? | Why |
|---------------|--------|--------------------|----|
| `stm32l4-rdp-downgrade.py` | RDP L1→L0 via SWD + glitch | **No** | KeepKey uses RDP L2 (irreversible) |
| `stm32f4-glitching.py` | Bootloader Read Memory via UART | **No** | RDP L2 disables memory commands |
| `register-brute-force.py` | SWD register stepping | **No** | SWD permanently disabled by RDP L2 |
| `stm32f4-glitching-shorter-timeouts.py` | Same as above | **No** | Same reason |
| All `stm32f42x/` scripts | V_CAP line glitching | **Partially** | Glitch hardware applicable, but attack target (RDP L1 bootloader) is not |

**Key insight:** The Findus library's STM32 attacks all assume RDP Level 0 or 1. KeepKey's RDP Level 2 blocks the entire attack chain at the silicon level. The remaining attack surface is **bootloader/firmware logic faults** (F3, F5) — which can allow booting modified firmware, not direct flash readout.

---

## Conclusion

KeepKey's hardware security posture is **strong** against the specific attacks documented in the Findus fault-injection library. RDP Level 2 is the primary defense and it holds — the entire RDP-downgrade and bootloader-memory-read attack classes are not applicable.

The remaining firmware-level vulnerabilities (F3, F5) are **logic faults in the signature verification chain** that could allow booting unsigned/modified firmware. These are worth patching as they represent the most practical remaining attack vector for a physical attacker: glitch the boot verification, install malicious firmware, then exfiltrate secrets through the device's own interfaces.

The research items (F4, F10, F11) would add defense-in-depth layers but are lower priority given that RDP L2 already eliminates the direct flash-readout threat.
