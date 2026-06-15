# Handoff: F7 — show the REAL firmware confirm frame BEFORE approval (emulator)

**Date:** 2026-06-15
**Status:** Deferred (intentionally not built). F4 + F5 shipped instead.
**Branch context:** `feature-emulator` (vault) + firmware `alpha`.
**Owner of decision:** deferred after a design review found unacceptable risk to the shared signing path; see *Why deferred*.

---

## The goal

On a real KeepKey, signing is **screen-first**: the device renders "Confirm amount → fee → …", **holds** each screen, and you press the physical button to advance. In the emulator we want the same feel — the **actual firmware-rendered OLED confirm frame shown in the emulator window, held, BEFORE the user clicks Confirm in the vault**, then the click advances it.

Today the order is inverted: the vault shows its own dialog, the user clicks Confirm, and only *then* does the firmware render its screens (in a burst). F7 is about flipping that back to screen-first with the genuine device bitmap.

## What already ships (and why F7 is lower priority than it sounds)

- **F5** (`8c22b592`): the vault confirm dialog now shows amount / to / **fee** / memo **before** approval (BTC/ETH/Cosmos-family/XRP). So the user already sees *what they're signing* pre-click — just not the literal OLED bitmap.
- **F4** (`8c22b592`): the firmware confirm screens that stream in right *after* the click are now played back slowly enough to read (~350 ms/frame). **These are the genuine firmware-rendered OLED frames** (captured via `libkkemu_capture_frame`), so the device's real screen content *is* surfaced — just sequenced after the click.
- Net: F7's only marginal gain over F4+F5 is **timing** (real bitmap *before* vs *just after* the click) and **hold** (interactive press-to-advance). Worth doing for fidelity, not urgent.

---

## Why it's deferred (the core constraint)

The firmware confirm primitive `confirm_helper()` (`modules/keepkey-firmware/lib/board/confirm_sm.c:159-293`) is a **blocking C busy-loop** that runs entirely inside a single `kkemu_poll()` FFI call:

1. On the **first** loop iteration it renders the confirm layout (`cur_layout = LAYOUT_INVALID` at `:205` forces `swap_layout()` → the notification callback draws to the canvas), then `display_refresh()` captures it. **So the real confirm frame is renderable before any decision arrives** — good.
2. It then busy-loops calling `check_for_tiny_msg()` → `usbPoll()` (one non-blocking poll/iteration, `:225`) until it has both `ButtonAck` (type 27) and `DebugLinkDecision` (type 100), or a Cancel (`:238-239`), or the held-button state machine reaches `FINISHED` (`:259-261`).
3. It holds **stack-local** state (`volatile StateInfo state_info`, `cur_layout`, the layout callback ptr — `:164-176, 205`) **and file-static** state (`static bool button_request_acked` at `:43`, plus a static `strbuf` cleared per call).

Why this blocks F7:

- To show-and-hold the real frame **before** the click, the host must let `confirm_helper` render (step 1), **return control to JS** (so the Bun event loop and the watchdog heartbeat keep running), wait for the user, then **resume** to deliver the ButtonAck. That requires `confirm_helper` to be **re-entrant / yieldable**.
- Making it re-entrant means persisting all the state in (3) across the yield. But **ETH and BTC call `confirm()` multiple times per signature** (amount, fee, data, …). Each call resets `button_request_acked = false` and clears the static `strbuf`. A naive yield/resume that re-enters via a fresh `confirm()` would **reset shared static state mid-operation and corrupt the in-progress signature** — on the **same C code that runs on real hardware** unless perfectly `#if EMULATOR`-gated.
- The out-of-process **watchdog** (`projects/keepkey-vault/src/bun/emulator-watchdog.ts`) SIGKILLs the app if a `kkemu_poll` busy-loop freezes the Bun event loop >60s (the heartbeat `setInterval` can't fire during a synchronous FFI call). Any approach that enters `confirm_helper` without a pre-written decision freezes the loop → SIGKILL. (Note: Bun does **not** deliver the firmware's SIGALRM, which is why the timer is now driven from `kkemu_poll`; see `lib/emulator/libkkemu.c`. So you cannot rely on an async signal to break the loop either.)

**Signing currently works end-to-end on the emulator.** F7 is the one change that can break it, so it was deliberately not bundled into a UX pass.

---

## How the emulator confirm works today (context for whoever picks this up)

`projects/keepkey-vault/src/bun/emulator-window.ts` → `emuInteractiveConfirm()` (~`:516-595`):

1. `pausePoll()` — stop the 16ms `kkemu_poll` display loop.
2. Pre-poll `numChunks - 1` message chunks via `emuPollOnce()` so the firmware buffers the sign message but does **not** yet enter `confirm_helper`.
3. Show the vault confirm dialog; await the user's click.
4. On approve: `prewriteConfirmations(N)` writes N × (ButtonAck type 27 + DebugLinkDecision type 100) to **iface 1** (`emulator-transport.ts`), then **one** `emuPollOnce()` — the firmware runs `confirm_helper` to completion against the pre-written decisions, in one blocking C call.
5. `resumePoll()`; the captured confirm frames drain to the preview afterward (now paced by F4).

Ring buffers are lock-free SPSC (`lib/emulator/ringbuf.c`, C11 atomics) — relevant to Approach B below.

---

## Two viable approaches (pick at follow-up)

### Approach B — dedicated poll thread in the dylib  ·  *recommended; lower risk to signing*

Run `kkemu_poll` on a **C thread inside the dylib**, so `confirm_helper`'s busy-loop can block **in C without freezing the JS event loop**. The vault then does a natural **reactive** confirm: firmware emits `ButtonRequest` → host sees it + shows the captured real frame → user clicks → host writes `ButtonAck` to the ring → the C thread's `confirm_helper` consumes it and advances.

- **Pros:** **no change to `confirm_helper` or any shared signing FSM** — isolated to `lib/emulator/libkkemu.c` (add a poll thread + start/stop) and the vault transport (reactive instead of pre-write). The SPSC rings are already designed for cross-thread use. This is the "poll thread in the dylib" long-term fix flagged in prior emu work.
- **Cons / risks:** the firmware core (FSM, storage, crypto) is **single-threaded by assumption** — only the C poll thread may call `kkemu_poll`; the JS side must interact **only** via the rings + the frame ring (never call `kkemu_poll` concurrently). Lifecycle/teardown must join the thread cleanly (the flash buffer is `mlock`'d and zeroed on shutdown). Frame-ring read from JS while the thread writes is already the existing pattern. Windows: the timer is poll-driven; the thread would own that.
- **Watchdog:** with a poll thread, the JS event loop never freezes, so the SIGKILL watchdog becomes unnecessary for confirms (keep it as a backstop, or gate it).

### Approach A — emulator-gated re-entrant `confirm_helper`  ·  *higher risk*

Refactor `confirm_helper` into a re-entrant state machine that, **under `#if EMULATOR` and a "preview" mode**, renders once and returns a `PENDING` status to the host without consuming a decision; the host shows the frame, waits for the user, then re-enters to deliver `ButtonAck`.

- **Pros:** no threading.
- **Cons / risks:** must persist `StateInfo` / `cur_layout` / `button_request_acked` / `dld` across the yield (heap or FSM-context struct), and guarantee re-entry does **not** reset shared static state used by multi-confirm ETH/BTC. It edits the **shared** confirm primitive — a bug risks every signing path on real hardware. Requires the full regression matrix below and surgical `#if EMULATOR` gating so hardware behavior is byte-identical.

> Recommendation: prototype **Approach B** first. It keeps the blast radius in the emulator dylib + vault transport and leaves the shared signing FSM untouched.

---

## Required regression test matrix (either approach)

Signing **must** remain correct. Before merging F7, verify on the emulator:

- Single-confirm: BTC (1-out), ETH transfer, Cosmos send, XRP, THOR/Maya/Osmosis.
- **Multi-confirm: ETH ERC-20 approve + a contract call (multiple `confirm()` per sign), BTC multi-output** (N outputs + fee) — this is where shared static state corruption would show.
- **Cancel/Reject mid-sequence** (reject on screen 2 of N) — must abort cleanly, no stuck state.
- Re-sign immediately after a cancel and after a success (state fully reset between ops).
- `make test-emu` (the 24-test FFI suite) green; `make test-emu-python` green.
- Hardware smoke (Approach A only): confirm a real-device sign is byte-identical — the `#if EMULATOR` gate must mean **zero** behavior change off-emulator.
- Watchdog: no SIGKILL during a long human pause at the confirm screen.

## Acceptance criteria

- The emulator window shows the **actual firmware-rendered** confirm OLED frame **before** the user clicks Confirm, and **holds** it until the click.
- The click advances exactly one screen per the firmware's flow (press-to-advance feel).
- All matrix tests pass; signing semantics unchanged.

---

## Key references

- Firmware confirm: `modules/keepkey-firmware/lib/board/confirm_sm.c` (`confirm_helper` `:159-293`; `swap_layout` `:107-152`; static `button_request_acked` `:43`).
- Dylib FFI + capture ring + (now) poll-driven timer: `modules/keepkey-firmware/lib/emulator/libkkemu.c`; rings `lib/emulator/ringbuf.{c,h}`.
- Vault confirm orchestration: `projects/keepkey-vault/src/bun/emulator-window.ts` (`emuInteractiveConfirm`, `startDisplayPoll`), `emulator-transport.ts` (`prewriteConfirmations`), `emulator.ts` (`pausePoll`/`resumePoll`/`emuPollOnce`).
- Watchdog: `projects/keepkey-vault/src/bun/emulator-watchdog.ts`.
- What shipped instead (F4/F5): commit `8c22b592` on `feature-emulator`.
- Prior art note: a "poll thread in the dylib" was previously identified as the clean fix for the python-keepkey reactive-confirm deadlock — Approach B is that.
