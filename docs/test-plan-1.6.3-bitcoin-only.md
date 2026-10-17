# KeepKey Desktop 1.6.3: Bitcoin-only hardware test plan

Branch `feat/bitcoin-only-163`. Everything below was checked only by unit tests
(`make test-unit`: 1431 + 53 pass, 0 fail). No emulator, hardware or SDK run has
happened. This plan is the hardware run.

## Which device for which journey

| Journey | Device | Risk |
|---|---|---|
| a. New device to Bitcoin-only | SPARE: new/old-stock unit (e.g. the fw 5.2.4 / bl 1.0.2 unit seen 2026-10-17) | Firmware changes. Treat any wallet on it as lost. |
| b. New device to Multi-chain | SPARE (second unit, or the same one later via custom file) | Firmware changes. Treat any wallet on it as lost. |
| c. Bitcoin-only device in firmware mode | The SPARE from (a), now on 7.14.3 Bitcoin-only | Read-only. |
| d. Bitcoin-only device in bootloader mode | The SPARE from (a) | Read-only. Step d4 is optional and WIPES. |
| e1. Funded 7.16.0, firmware mode | Owner's FUNDED 7.16.0 | Safe: read-only. |
| e2. Funded 7.16.0, bootloader mode | Owner's FUNDED 7.16.0 | Safe ONLY if you stop where marked. Never tick a red box, never press the KeepKey button. |
| e3. Multi-chain 7.14.1 to 7.14.2 | SPARE on 7.14.1 (or 7.14.0) | Firmware changes; the wallet should survive. |

On the funded device, the only buttons you press in KeepKey Desktop are the ones
listed. If the KeepKey ever shows "Verify Backup" or "Firmware Update" during
e1/e2, do NOT press its button: unplug it. Nothing has been erased at that point.

## Before you start

1. Quit the KeepKey Desktop that is running now (port 1646). Two Desktops fight
   over the device and the port.
2. Launch the branch build from the worktree:
   `cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/.worktrees/bitcoin-only-163 && make vault`
   Keep the terminal output. Each journey below names the log lines to look for.
3. Leave any dapp or SDK client connected to Desktop. Journey (a) checks that it
   no longer triggers "Unknown message" failures during setup.

## a. New KeepKey to Bitcoin-only (SPARE)

Start: a unit that needs the bootloader update, for example fw 5.2.4 on
bootloader 1.0.2 (initialized, label "label"), or a factory 4.0.0 unit.

1. Plug it in normally.
   - Desktop: the setup wizard opens.
   - Log: `[Engine] State → needs_firmware`. There must be NO
     `[REST] batch address failed … Unknown message` lines. A connected client
     gets HTTP 503 from `/api/pubkeys/batch` instead.
   - FAIL if any `batch address failed` line appears while the wizard is open.
2. Click "Get Started" (and the intro pages) until "Step 1 of 3".
   - Desktop: "Put Your Device in Bootloader Mode", CURRENT v1.0.2 → LATEST
     v2.1.4. Below it, a "FIRMWARE FOR THIS KEEPKEY" picker with two cards:
     "Multi-chain · v7.14.2" (SELECTED, green border) and
     "Bitcoin-only · v7.14.3".
   - FAIL if there is no picker, or Bitcoin-only is preselected.
3. Click the "Bitcoin-only · v7.14.3" card.
   - Desktop: it becomes selected. An orange note appears: "This is one-way…".
     On a unit that is not factory firmware it also says "If this KeepKey
     already holds a wallet, it keeps working for Bitcoin…".
4. Unplug. Hold the KeepKey button, plug in, release when the bootloader screen
   appears.
   - KeepKey: bootloader screen.
   - Desktop: "Bootloader Mode Detected". The picker still shows Bitcoin-only
     selected. Button "Update Bootloader to v2.1.4".
   - FAIL if the selection jumped back to Multi-chain or to nothing.
5. Tick the backup box if shown, then click "Update Bootloader to v2.1.4". Follow
   the KeepKey screen.
   - KeepKey: bootloader update, then asks you to disconnect and reconnect.
6. Unplug, then plug in normally (do NOT hold the button).
   - Desktop: "Step 2 of 3" firmware step. Instead of the picker, one line:
     "Bitcoin-only firmware" with a "Change" link. LATEST shows "v7.14.3" with
     "Bitcoin-only" under it.
   - FAIL if the picker asks again with nothing selected, or LATEST says v7.14.2.
7. (Restart check, optional) Quit Desktop now and run `make vault` again.
   - Expected and accepted: the wizard does not save its step or the choice.
     For a unit whose bootloader is now current and whose firmware Desktop
     knows (5.2.4), the firmware step shows NO picker and offers Multi-chain
     ("Install Official Firmware v7.14.2"). Do not install it here. Unplug,
     quit, and restart this journey from step 1 on another session only if you
     want Bitcoin-only. Report what you saw; this is a known limitation (see
     the end of this plan).
8. Unplug. Hold the button, plug in.
   - KeepKey: "FIRMWARE UPDATE MODE" (or "FIRMWARE UPDATE REQUIRED"),
     "Bootloader Version: 2.1.4".
   - Desktop: CURRENT shows a hash with "(custom)" for 5.2.4, or
     "Factory firmware" for a 4.0.0 unit. Desktop cannot identify these builds in
     bootloader mode. So a red card "This may wipe the device" appears, with the
     box "I understand this may wipe my device and I have my recovery phrase
     backed up". The button "Install Bitcoin-only firmware v7.14.3" stays
     disabled until the box is ticked.
   - Log: `[Engine] Features: {…"firmwareHash":"…"…}`. Copy that firmwareHash
     into the results. For a 4.0.0 unit, compare it with
     `eb57814406ef6c9efd77939971ab2f9e08fdec10de78cb974d4f6b2a231f1dd6`, the
     sha256 of the public v4.0.0 `keepkey_main.bin`. If it matches, it can be
     pinned and this red card goes away for new devices. 5.2.4 has no public
     asset, so its hash cannot be pinned under the table's rule.
   - FAIL if the install button is enabled without the box ticked.
9. Tick the box, click "Install Bitcoin-only firmware v7.14.3".
   - Desktop progress: "Binary verified — sha256 matches the pinned release hash
     (4cf84bfe977d00ca…)".
   - Log: `[Engine] Installing bitcoin-only firmware v7.14.3 (wipe acknowledged: unknown-installed)`.
   - KeepKey: "Verify Backup" (the unit has a wallet) or "Firmware Update" (no
     wallet). Hold the button to confirm. Upload, then "Firmware Update
     Complete".
   - FAIL if the log says multi-chain, or the progress shows any other hash.
10. The KeepKey restarts on its own.
    - KeepKey: boots with no "Unrecognized firmware" warning.
    - Desktop: orange splash "Bitcoin-Only KeepKey". A unit with a wallet goes
      to the Bitcoin page with its label ("label") and its BTC accounts. A unit
      with no wallet goes to create/recover.
    - Log: Features show `"firmwareVariant":"KeepKeyBTC"` and firmwareVersion
      7.14.3.
    - PASS: steps 1-10 as described. FAIL: any multi-chain asset, any ETH
      address request, or the wallet gone on a unit that had one (signed 5.2.4 →
      signed 7.14.3 keeps storage).

## b. New KeepKey to Multi-chain (SPARE)

Same as (a), with these changes:

- Step 3: leave "Multi-chain · v7.14.2" selected (the default).
- Step 6: the line reads "Multi-chain firmware"; LATEST v7.14.2 "Multi-chain".
- Step 9: the button reads "Install Multi-chain firmware v7.14.2". The log reads
  `Installing multi-chain firmware v7.14.2`, and the progress hash starts with
  `45fe90c1`.
- Step 10: normal (not orange) splash. After setup, all chains are shown.
- FAIL if the Bitcoin-only build is installed, or KeepKeyBTC appears in Features.

## c. Bitcoin-only 7.14.3, firmware mode (SPARE from a)

1. Plug the (a) unit in normally.
   - Desktop: orange splash "Bitcoin-Only KeepKey". On first connect,
     "Your Bitcoin-only KeepKey". Dashboard is the Bitcoin page; no other chain.
   - No firmware update prompt anywhere. Settings shows firmware v7.14.3.
   - Log: no `needs_firmware`.
   - FAIL if Desktop offers v7.14.2 or v7.16.0, or shows any non-BTC chain.
2. From a REST client, request an ETH address (e.g. `/api/pubkeys/batch` with
   an m/44'/60' address path).
   - Expected: skipped or refused (Bitcoin-only boundary). The device is never
     asked.

## d. Bitcoin-only 7.14.3, bootloader mode (SPARE from a)

The 7.14.3 Bitcoin-only hash is in the release table, so the result does not
depend on a remembered snapshot. The snapshot path (unofficial builds) is
covered by `__tests__/firmware-install.test.ts`.

1. Unplug. Hold the button, plug in.
   - KeepKey: "FIRMWARE UPDATE MODE", "Bootloader Version: 2.1.4".
   - Desktop: firmware recognised as `v7.14.3-bitcoin-only`. No firmware
     install is offered (the device is current).
   - Log: no `[Engine] Installing …`.
2. If a firmware step is visible:
   - There is NO Bitcoin-only/Multi-chain picker, LATEST is v7.14.3
     "Bitcoin-only", and the button reads "Install Bitcoin-only firmware
     v7.14.3" (reinstall, no red card).
   - FAIL if Multi-chain can be selected anywhere in the wizard, or LATEST says
     v7.14.2.
3. Custom file check (no flashing): open "Or install custom firmware" and select
   `projects/keepkey-vault/firmware-bundle/v7.14.2/firmware.keepkey.bin`.
   - Desktop: red "This downgrade will wipe the device" warning; "Wipe & Flash"
     stays disabled until its box is ticked. Click cancel/reset. Do NOT flash.
4. (Optional, WIPES the spare) Tick and flash the 7.14.2 file. The device
   restarts on multi-chain 7.14.2 with no wallet. This confirms the warning was
   true.
5. Unplug, plug in normally. The unit boots 7.14.3 Bitcoin-only with its wallet
   (unless you did d4).

## e. Multi-chain behaviour unchanged

### e1. Funded 7.16.0, firmware mode (SAFE)

1. Plug in normally. Unlock with PIN as usual.
   - Desktop: dashboard as on 1.6.2. No firmware update prompt; Desktop never
     offers 7.14.2 as an "update" and never offers a downgrade.
   - Log: no `needs_firmware`. Features show firmwareVersion 7.16.0,
     firmwareHash `99ebac75…879c`.
   - REST: `/api/pubkeys/batch` answers 200 (the setup 503 does not apply).
   - FAIL if any update or downgrade is offered.

### e2. Funded 7.16.0, bootloader mode (SAFE if you stop where marked)

1. Unplug. Hold the button, plug in.
   - KeepKey: "FIRMWARE UPDATE MODE", "Bootloader Version: 2.1.4".
   - Desktop: firmware recognised as v7.16.0. No install is offered and there
     is no Bitcoin-only/Multi-chain picker.
2. STOP. If any install button is visible, it must sit under a red card "This
   will wipe the device" (v7.14.2 over v7.16.0) and stay disabled. Do NOT tick
   the box. Do NOT press the KeepKey button.
   - FAIL if an install button is enabled without a red card, or a picker is
     shown.
3. Unplug, plug in normally. The device boots 7.16.0 with the wallet unchanged.
   Entering bootloader mode erases nothing.

### e3. Multi-chain 7.14.1 to 7.14.2 (SPARE)

1. Plug the 7.14.1 unit in normally.
   - Desktop: wizard firmware step. NO picker (bootloader current, firmware
     known). Button "Install Official Firmware v7.14.2". No red card; the
     backup box is shown.
2. Optional: click "Skip Update". Desktop opens the dashboard, and
   `/api/pubkeys/batch` answers 200 (a skipped update keeps working).
3. Install: enter bootloader mode, click the install button, then confirm on the
   KeepKey ("Verify Backup").
   - Log: `Installing multi-chain firmware v7.14.2` with no `wipe acknowledged`.
   - The unit boots 7.14.2 with its wallet.

## Results to send back

For each journey: PASS/FAIL, plus screenshots of step 2 (a), step 6 (a), step 8
(a) and e2 step 1. Also send the firmwareHash lines from (a) step 8 and the
terminal log.

## Known limitations (decide before release)

- Restart mid-wizard: the wizard does not save its step, and the coin choice is
  kept only in memory. After a restart, a unit whose bootloader is already
  current and whose firmware Desktop knows shows no picker and installs
  Multi-chain. There are two ways to fix this. One is to show the picker on
  every wizard firmware install of a multi-chain device (Multi-chain stays
  preselected). The other is to save the choice across restarts, with an
  expiry so it never reaches a different KeepKey.
- In bootloader mode, Desktop cannot identify 4.0.0 or 5.2.4 firmware, because
  neither hash is in the release table. That is why (a) step 8 shows "This may
  wipe the device" even on a genuinely new unit. The card is safe but alarming.
  Pinning the 4.0.0 hash removes it if it matches the public asset (see a,
  step 8).
- The "(custom)" label on the CURRENT line in (a) step 8 is the existing label
  for any unrecognised hash. For 5.2.4 it is technically wrong: the firmware is
  official, just older than the table.
