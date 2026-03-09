KeepKey firmware hardening against voltage/glitch fault injection
Executive summary
KeepKey’s secure-boot and runtime isolation design (bootloader signature validation + MPU-based privilege separation with a privileged “supervisor” for sensitive operations) has historically contained fault-sensitive decision points where a physical fault can push execution into a “less protected” state instead of a “more protected” one. The clearest example is the previously disclosed TOCTOU-style weakness (VULN-21020): the firmware reused the long-running signatures_ok() routine during early boot to decide whether to drop privileges and enable protections; a fault that turns a valid signature check into SIG_FAIL/KEY_EXPIRED could cause protections to be skipped while still booting “normally.”

Separately, KeepKey’s supervisor boundary has had issues (CVE-2022-30330) where range checks in svhandler_flash_* could be bypassed, enabling writes into protected flash regions in some conditions. A later upstream patch strengthened these checks by adding overlap-aware validation to ensure the entire write range stays within allowed flash sectors.

A key limitation: some STM32-family attacks target immutable BootROM behaviors or early option-byte loading (e.g., readout protection downgrades). Vendor firmware alone cannot “patch” BootROM vulnerabilities, so mitigations must focus on (a) ensuring faults cannot downgrade software security state (“fail-closed”), (b) reducing single-point-of-failure checks, and (c) adding software-level fault detection/infection and reset-safe telemetry (fault counters) to detect repeated abnormal resets.

This report provides code-path mapping, an exploit-primitive-to-code map, and a concrete hardening patch set (C/pseudocode) designed to be handed off to an engineering agent for implementation.

Scope and threat model
This analysis is code-only: it focuses on how voltage/glitch fault models manifest as instruction skips, branch inversions, register/stack corruption, faulty return codes, or early-exit behavior inside KeepKey bootloader/firmware routines—then maps those fault models to specific checks and software mitigations.

Assumptions:

The device is STM32-based (KeepKey has been documented as using an STM32F205 family MCU in prior disclosures).
Fault injection can disturb computation during long-running cryptographic checks and can also cause instruction skip / multi-skip behavior (which is especially relevant for Thumb/Thumb-2 encodings and pipeline effects).
BootROM-targeting attacks exist in the broader STM32 ecosystem (e.g., RDP downgrade glitching described in hardware-wallet research), but those are not directly fixable by application firmware; defenses must instead harden what happens after boot and signature verification.
Tooling priority (for defensive testing and reproducibility guidance): Markus Kesenheimer’s fault-injection-library (“Findus”) is a common automation framework for fault-injection experimentation; importantly for defenders, it models campaigns in terms of parameters like delay/length and trigger sources (without being specific to any one target).

Boot and verification sequence
High-level chain of trust and “protection enablement”
The VULN-21020 disclosure describes a two-path design goal: for signed firmware, the firmware enables certain protections; for custom/unsigned firmware, the bootloader enables protections. This split creates fault-sensitive seams if the signed/unsigned decision is evaluated more than once or evaluated with a long-running check in multiple places.

The disclosed boot process contains these important stages:

Bootloader invokes signatures_ok() to determine whether firmware signatures are valid and selects user flow (SIG_OK, SIG_FAIL, KEY_EXPIRED) accordingly.
Firmware startup logic (earlier versions) re-invoked signatures_ok() inside canDropPrivs() to decide whether to drop privileges / enable protections, creating a TOCTOU-like dependence on a second long-running computation.
Runtime isolation: svhandler_flash_* privileged handlers gate flash operations. A hardened range-check implementation was later merged to ensure disallowed sectors can’t be partially overlapped by crafted ranges.
Boot + verification flowchart with fault target points
mermaid
Copy
flowchart TD
A[Reset / BootROM] --> B[Bootloader start]
B --> C[signatures_ok(): hash firmware + verify 3 ECDSA sigs]
C -->|SIG_OK| D[Boot approved → chainload firmware]
C -->|SIG_FAIL / KEY_EXPIRED| E[Warn / update-required / unofficial prompt]
D --> F[Firmware early init]
F --> G[Protection decision: MPU/privilege configuration]
G --> H[Normal operation (unprivileged app + privileged supervisor)]
H --> I[Flash operations via svhandler_flash_* gate]

%% fault targets
C -. fault: corrupt long crypto computation / early return .-> C
G -. fault: invert signed/unsigned decision → skip protections .-> G
I -. fault: bypass range checks → write forbidden flash .-> I
(“Reset / BootROM” is included for completeness; its vulnerability class is not patched by firmware, but downstream decisions can be hardened.)

Vulnerable code paths and fault models
Reuse of long-running signature verification in a security decision
The disclosed signatures_ok() routine performs: read firmware flash, compute SHA-256, verify three ECDSA signatures, return SIG_OK only if all checks pass. The disclosure notes the routine is long-running (on the order of ~1 second in the cited context), which increases exposure to broad fault timing windows.

The key weakness (VULN-21020) was not “accepting a bad signature,” but instead the inverse: under fault injection, making a good signature check return a failure code at the wrong time can push the firmware into skipping protections—because the firmware was using SIG_OK == signatures_ok() as a policy predicate.

Vendor fix direction (as described in the disclosure): replace the lengthy check inside firmware (canDropPrivs) with a much simpler check (presence of signature metadata already validated by bootloader), reducing attack surface and boot time.

Supervisor flash gating edge cases
CVE-2022-30330 and related analysis describe failures in address range validation in privileged flash handlers (svhandler_flash_*), enabling overwriting protected flash ranges in certain layouts.

A later upstream patch (commit message: “more robust address range checks in svhandler_flash_*”) introduced overlap-aware validation helpers (e.g., do_memory_ranges_overlap, allow_svhandler_flash_range) and enforced that both start and end addresses land in allowed sectors while rejecting any overlap with disallowed sectors.

Additional fault-sensitive runtime checks worth hardening
Hardware-wallet research and KeepKey-specific disclosures emphasize that secrets or key material can be present in RAM during early boot or prior to user authentication, increasing the value of any fault that enables RAM readout or bypasses checks. For example, Kraken’s KeepKey write-up describes a boot path where configuration (including encrypted seed material) is loaded into RAM before PIN entry, and then is later attackable if the hardware security configuration is downgraded.

Separately, common fault models against firmware include “instruction skip” and “multiple instruction skip,” meaning simplistic “duplicate one branch” countermeasures can be insufficient unless designed for multi-skip models (e.g., inserting additional sensors/counters or using idempotent duplication patterns).

Exploit primitives mapped to code locations
Table mapping boot/verification code paths, functions, and vulnerable checks
Stage	Code path (as referenced in public sources)	Function(s) / check(s)	Likely fault outcome	Why it is fault-sensitive
Bootloader signature gate	tools/bootloader/main.c → boot()	int signed_firmware = signatures_ok(); then if (signed_firmware == KEY_EXPIRED) / if (signed_firmware != SIG_OK)	Fault flips return code or branch outcome, changing control flow (e.g., warning path vs proceed)	Decision is immediate and high-impact; branch inversion or corrupted return code changes boot policy.
Firmware protection decision (historical)	tools/firmware/keepkey_main.c → canDropPrivs()	return SIG_OK == signatures_ok(); for certain bootloader kinds	Fault-induced SIG_FAIL/KEY_EXPIRED for valid firmware causes protections to be skipped (“fail-open”)	Long-running crypto check reused as a policy predicate; “false negative” signature results become security-relevant.
Signature verification core	lib/board/signatures.c → signatures_ok()	sha256_Raw(...) then 3× ecdsa_verify_digest(...) != 0 with early returns SIG_FAIL/KEY_EXPIRED, else SIG_OK	Early return, corrupted digest, corrupted signature index, corrupted verify result	Early-return structure amplifies “single fault” impact: one disturbed verify can exit early with failure code.
Runtime privileged flash gate (pre-fix)	lib/board/supervise.c → svhandler_flash_*	Range/sector validation on (beginAddr, length)	Fault/corner case enables partial overlap into forbidden flash, persistence or boot compromise	Privileged write primitive is extremely sensitive; range math and sector boundary logic must be overlap-complete.
Runtime privileged flash gate (post-fix baseline)	lib/board/supervise.c	do_memory_ranges_overlap(), allow_svhandler_flash_range(), plus allowed-sector enumeration	Narrowed bypass surface; still sensitive to single-point checks if not redundant	Patch explicitly prevents forbidden-sector overlap and overflow cases; becomes a pattern for other gates.
Early secret material exposure	keepkey_main.c → storage_init → storage_fromFlash (as described)	Loading storage structures (incl. encrypted secret fields) into RAM before PIN unlock	If a separate fault enables RAM readout or bypasses later PIN checks, attacker gains material for offline attack	Increases payoff of any fault that enables debug/RAM read; strengthens need for fault-aware reset telemetry and defense-in-depth.

Table of exploit primitives (timing/width/trigger) and mapping to code locations
This table is intentionally non-procedural (no hardware setup, no parameter values). It captures generic fault “knobs” defenders should model in test harnesses and where those knobs “land” in code.

Primitive category	Typical abstraction (defender modeling terms)	Trigger anchor (software-observable)	Code locations most impacted	Expected corrupted artifact
Long-computation corruption	“Fault during compute window” (broad timing)	Entry/exit of signatures_ok(); any coarse boot milestone	signatures_ok() including SHA and ECDSA verify calls	Wrong digest, wrong ECDSA result, early exit path selected.
Single-branch inversion	“Fault near conditional branch”	Immediately after return from signature verify or policy predicate	if (signed_firmware != SIG_OK), if (… == KEY_EXPIRED), SIG_OK == signatures_ok()	Control-flow flip (“accept” vs “reject”; “enable protections” vs “skip protections”).
Instruction skip / multi-skip	“Skip N instructions” / “multi-skip fault model”	Short windows around critical check blocks	Any short critical sequence that implements validation or sets state (MPU/privilege config gates, range-check blocks)	Skipped validation step(s); duplicated-check countermeasures may fail under multi-skip.
Parameter corruption (range math)	“Corrupt arithmetic intermediate”	During address/length computation in privileged flash handler	svhandler_flash_* validation and any helper range functions	Overflow/underflow leading to false “allowed” classification.
Brownout-adjacent destabilization	“Supply dips that stay above POR but affect compute”	PVD/BOR events available via PWR/RCC flags; EXTI PVD line (family-dependent)	Any long crypto or key-derivation loop, plus early boot state setting	Silent compute corruption unless trapped; can be mitigated by BOR option bytes and PVD interrupts.
Fault-campaign automation parameters	“delay/length/triggered campaign parameters” as used in open tooling	External trigger sources (e.g., UART-trigger abstraction) as a concept	Used to structure defender test campaigns; map into windows around signature verify and policy predicates	Reproducible fault-space exploration to validate mitigations.

Concrete code-level hardening patches
Design principles for this patch set
Fail-closed on ambiguity: any anomalous result during signature/protection decision must default to maximum protections enabled, not minimum. This directly addresses the VULN-21020 failure mode (false-negative signature → protections skipped).
Remove “long check as policy predicate”: keep long cryptographic verification in the bootloader’s trust boundary, then pass a short, redundancy-encoded, non-cryptographic attestation to firmware (or have bootloader always enable baseline protections).
Use redundancy designed for instruction skip and multi-skip: naive duplication can be defeated by multi-skip faults; use counters/sentinels and idempotent duplication patterns.
Treat privileged gates like parsers: range checks must be overlap-complete and overflow-safe; reuse the strengthened svhandler_flash_* pattern broadly.
Exploit MCU power supervision features in software: BOR (option bytes) and PVD (interrupt + flags) are explicitly intended to keep execution in safe regions during supply disturbances; firmware should record and react to frequent BOR/PVD events during sensitive phases.
Table of recommended code patches (diffs/pseudocode snippets in C)
Each row includes: code example, insertion point, rationale, residual risk, and test/verification steps.

Mitigation	Where to insert (repo path / function)	Code example (C / pseudocode)	Rationale	Residual risk	Test / verification steps
Fail-closed protection policy for signedness ambiguity	tools/firmware/keepkey_main.c (or equivalent early init), in/around canDropPrivs() and the MPU/privilege setup gate	Policy change: treat “cannot prove signedness” as “keep protections on.”<br><br>bool signed_ok = read_boot_attest();<br>if (!signed_ok) { enable_mpu_hardened(); enter_unprivileged(); } else { enable_mpu_hardened(); enter_unprivileged(); /* signed may request extra caps via supervisor */ }	Eliminates the specific VULN-21020 class where a false-negative signature result disables protections.
If attacker can fault the protection-enable code itself, additional redundancy is required (see CFI/sentinels below). Also does not address BootROM-class faults.
Unit: assert protections enabled for all signedness states (“unknown”, “fail”, “ok”). Integration: simulate faulted return codes from signatures_ok() and confirm protections remain enabled.
Replace long signatures_ok() in firmware with short metadata presence check (as disclosed fix direction)	tools/firmware/keepkey_main.c → canDropPrivs()	Minimal diff pattern (conceptual):<br>// old: return SIG_OK == signatures_ok();<br>// new: return *(volatile uint8_t*)FLASH_META_SIGINDEX1 != 0;	Reduces fault surface by removing long-running crypto from firmware policy logic and relying on bootloader-validated metadata.
Attackers may still target bootloader check or corrupt metadata reads; must pair with bootloader-to-firmware attestation redundancy.
Regression: boot signed/unsigned firmware images and confirm correct policy. Fault testing: corrupt metadata byte in test harness and ensure firmware still fails-closed (protections on).
Bootloader-to-firmware attestation token with redundancy (instead of recomputing signatures)	Bootloader (tools/bootloader/main.c) sets token; firmware reads token early	Bootloader: write token to a “handoff” region (backup SRAM or dedicated RAM word) as value + complement + CRC:<br>token = 0xA5A5A5A5;<br>tok_x = token ^ 0xFFFFFFFF;<br>`tok_crc = crc32(token		tok_x	
Double-computation + consistency check for cryptographic digest (bootloader side)	lib/board/signatures.c or wherever digest computed in bootloader	Compute SHA-256 twice, compare in constant time before using:<br>sha256_Raw(app, len, h1);<br>sha256_Raw(app, len, h2);<br>if (ct_memeq(h1,h2,32)!=1) return SIG_FAIL;	Defends against transient fault corrupting a single digest computation, a common FI target. 
Costs boot time; still susceptible to correlated faults that corrupt both runs similarly; “infective” patterns help (below). 
Unit: deterministic vectors ensure both hashes equal. Fault sim: flip a byte in one hash and expect fail. Measure boot-time impact.
Remove early returns in signatures_ok(); aggregate results (“infective” style)	lib/board/signatures.c → signatures_ok()	Replace early-return chain with full evaluation and single decision:<br>int r1 = ecdsa_verify(...sig1...);<br>int r2 = ecdsa_verify(...sig2...);<br>int r3 = ecdsa_verify(...sig3...);<br>`uint32_t acc = (r1	r2	r3);<br>return (acc==0) ? SIG_OK : SIG_FAIL_OR_EXPIRED;`	Early returns increase sensitivity to a single fault; aggregation forces attacker to influence multiple steps or the final accumulator. 
Instruction-skip-aware check blocks using counters/sentinels	Around critical security predicates (signature decision, privilege drop, flash gate entry)	Pattern using a hardware counter or monotonic software counter checked twice:<br>volatile uint32_t s=0;<br>s+=0x11111111;<br>CRITICAL_CHECK();<br>s+=0x22222222;<br>if (s != 0x33333333) fault_panic();	Multi-instruction skip models defeat naive duplication; adding “sensors” and nontrivial invariants aligns with published instruction-skip countermeasure research. 
If attacker can fault both increments or skip the final compare, protection can fail; mitigate by scattering multiple sensors and by making fault_panic() non-bypassable (e.g., infinite loop + watchdog reset). 
Build a fault-simulation test that removes/patches out sequences (simulate skips) and confirm the invariant catches them. Use compiler flags to prevent optimization removing sentinels (e.g., volatile, asm volatile("" ::: "memory")). 
Constant-time comparisons for security decisions (PIN, hashes, tokens)	Wherever comparisons guard security (e.g., PIN fingerprint compare in storage path; signedness token compare)	Replace memcmp-style early exits with constant-time compare returning 1/0:<br>`uint8_t diff=0; for(i=0;i<n;i++) diff	= a[i]^b[i]; return (diff==0);`	Reduces fault-amplified timing signals and avoids early-exit behavior that can be faulted more easily than straight-line code. 
Does not stop direct branch inversion faults; must combine with sentinels and fail-closed logic. 
Watchdog + reset-cause telemetry and “boot-loop quarantine”	Bootloader early init and firmware early init; store counters in backup registers / backup SRAM	On each boot, read reset flags; increment “suspicious reset during boot” counter; if exceeds threshold, enter safe mode requiring user action.<br>`if (RCC_CSR & (BORRSTF	...)) boot_fault_cnt++;<br>if (boot_fault_cnt>MAX) enter_safe_boot();`	If faults repeatedly occur during signature/protection windows, persistent counters provide a software signal to refuse normal operation. BOR exists explicitly to keep MCU in safe reset during undervoltage.
Counter storage itself could be faulted; store as redundant value+complement+CRC (same pattern as signedness token). Also: not a complete defense; it escalates attacker cost and improves detection.
PVD-driven early warning → “stop doing crypto now”	Firmware and/or bootloader PWR init (STM32 family dependent): enable PVD interrupt; handle EXTI callback	Configure PVD threshold and on interrupt set a global fault flag and immediately abort sensitive operations:<br>void PVD_IRQHandler(){ fault_flag=1; }<br>if (fault_flag) goto fail_closed;	STM32 reference manuals describe PVD as an interrupt-capable early warning for VDD dropping toward BOR, explicitly for safe shutdown tasks.
Requires correct MCU-family-specific register programming and careful ISR design; attacker may still fault the ISR or the flag check. Treat PVD as an input to fail-closed policy, not sole defense.
Hardware-in-loop is ideal, but code-only verification can mock PVD flag and ensure every sensitive loop checks fault_flag frequently (static analysis / grep gates in CI).
Ensure BOR is enabled at a meaningful threshold (bootloader enforcement)	Bootloader option-byte management (where KeepKey manages persistent MCU config)	Verify BOR level is not “off”; if off, refuse to proceed or require explicit maintainer mode.<br>Conceptually: if (BOR_OFF) enter_update_required();	STM32F205 reference manual: BOR threshold configured via option bytes; BOR keeps device in reset when VDD below VBOR and generates reset on drops. For FI resilience, BOR materially reduces “gray-zone execution.”
Programming option bytes is irreversible-risky if wrong; must be done with careful UX and safe update flow. Also can’t fix fast transients fully.
Add build-time configuration assertion that BOR settings are audited. In production, include a boot screen showing BOR level and require signed update to change it.
Secure bootloader flash-gate hardening (adopt and extend upstream overlap checks)	lib/board/supervise.c and any other privileged memory write/erase APIs	Use the upstream pattern (overlap checks, allowed-sector enumeration, overflow guards) broadly; baseline diff exists in upstream commit.
This class is directly tied to persistence and boot compromise; overlapping-range logic is a known source of security bugs and the upstream patch is a concrete, reviewable baseline.
Faults can still skip checks unless protected with sentinels; pair with CFI/sentinel increments around privileged entry points.
Regression tests: exhaustive range fuzzing against allow_svhandler_flash_range(): generate random (start,end) and assert “no overlap with forbidden sectors.” Add a property test for contiguity assumptions.
Stack canary / guard region at privilege boundary	Supervisor entry/exit stubs + unprivileged thread init	Place a canary word in the supervisor stack frame and validate on exit; if corrupted, reset to safe boot.<br>uint32_t can=0xDEADBEEF; …; if (can!=0xDEADBEEF) fault_panic();	Faults can corrupt stack/return addresses; canaries add detection and convert silent corruption into reset. This is consistent with general software FI countermeasure goals (detection/infection).
Not sufficient against deliberate instruction skip of the canary check; pair with multi-skip-aware sentinels and watchdog-based panic loops.
Unit test: compile-time ensure canary not optimized away (volatile). Add negative tests that corrupt the stack frame in a harness / emulator build and confirm panic path.

Notes on “no-hardware-instructions” compliance
The above mitigations describe software insertion points and logic only.
Even when tooling (e.g., Findus) is referenced, it is used purely as a conceptual model for structuring defensive test campaigns (parameter-space exploration), not as a how-to for injecting faults.
Practical prioritization for an engineering handoff
If you have to pick an order that maximizes security impact per engineering effort:

Fail-closed policy + remove firmware-side signatures_ok() predicate (directly addresses VULN-21020 class).
Bootloader-to-firmware attestation token (redundant encoding) to eliminate multiple evaluations of signedness.
Adopt/extend the svhandler_flash_* overlap-complete checks and wrap privileged entry points with sentinels.
Instruction-skip-aware sentinels + watchdog panic loops around all “single-branch decides security” blocks.
BOR/PVD-driven reset telemetry + boot-loop quarantine to detect repeated abnormal boot faults.
These are complementary: the goal is not to “prevent all faults,” but to ensure faults cannot reliably downgrade security state and that repeated faults produce detectable, user-visible safe states.