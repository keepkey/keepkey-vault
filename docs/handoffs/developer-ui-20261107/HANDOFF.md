# KeepKey Desktop: coherent UI for the next release

Owner handoff · 2026-11-07 · **Proposal, not an application implementation**

Video production is stopped at the owner's request. The existing captures exposed a UI that is visually busy, inconsistent and difficult to explain. The next task is to improve the app, review the resulting task flows, and then regenerate the videos from that UI.

**Recommended direction:** one calm application shell, one Developer workspace and one set of reusable controls. Use opaque reading surfaces, a clear type hierarchy and consistent alignment. Give every screen a visible target, a clear primary task and a predictable next action. Balanced composition means allocating space to the task; it does not mean forcing every screen into equal-width columns.

Open [the interactive proposal](proposal.html) for Developer, Receive, Settings and request-review layouts, plus a gallery of the ten current cases. The proposal has no device connection or signing implementation. The recorded OLED illustration is real public-test firmware output; the surrounding proposed UI is a design study.

## Baseline and evidence limits

- Target: `keepkey-vault-v11`, maintained product **KeepKey Desktop (keepkey-vault)**. Download/release references remain [keepkey.com/desktop](https://keepkey.com/desktop).
- Captured source commit: `8af216b604542852d93e2d6d0ae5aedf5a9b0d65`. The local checkout still has that HEAD, with concurrent uncommitted application work. Preserve that work, especially the changes in `App.tsx`, `TopNav.tsx`, `DeviceSettingsDrawer.tsx`, RPC/types and the new password-manager surfaces. Reconcile the navigation proposal with those features rather than replacing their files wholesale.
- Evidence is the actual source frontend driven with synthetic **public test** responses, primarily 1440×900 CSS px at 2× pixel density. Seed screenshots use 1440×1000. This is not a packaged-release or physical-device replay. Original capture hashes and source paths are in [evidence.json](evidence.json); captured versus current source hashes are in [source-provenance.json](source-provenance.json).
- Remote resources, including web fonts, were blocked during capture. Exact font rendering and missing remote assets require native-app verification. The all-monospace policy, small declared sizes, component geometry, literal entity text and placement of actions are independently visible in source.
- The JPEGs are full-frame review derivatives at their CSS viewport scale. No UI was retouched. Do not measure production contrast from compressed screenshots; inspect the final rendered token/background combinations.
- Original video files and source captures are retained in the backend content project. No further video renders or publication are part of this handoff.

## Ten concrete cases

| ID | Current problem | Next-release action |
|---|---|---|
| [UI-01](#ui-01) | Busy background and uneven visual balance | Use an opaque reading surface and one content grid. |
| [UI-02](#ui-02) | Tiny monospace prose obscures hierarchy | Use a bundled system/sans face for UI prose; keep mono for addresses, paths, hashes and numeric columns. |
| [UI-03](#ui-03) | Setup, wallet and emulator look like separate products | Share surface, type, radius, spacing, field, notice and task-dialog primitives across setup, settings, signing and emulator views. |
| [UI-04](#ui-04) | Settings is a long inventory rather than a navigable place | Move settings into a full content view with categories: General, Wallet & device, Connections, Developer, Advanced & reset. |
| [UI-05](#ui-05) | Starting an emulator spans too many disconnected surfaces | Create a Developer workspace with an Emulator page for profiles, selected build, Start/Stop, setup, preview and diagnostics. |
| [UI-06](#ui-06) | The profile chooser has an inconsistent modal shell | Use the shared dialog shell: “Choose emulator profile”, a labelled name field, a real close icon/button, selectable profile rows and aligned Cancel / Create profile actions. |
| [UI-07](#ui-07) | Destructive and routine emulator actions have equal weight | Put Start/Stop next to the selected profile. |
| [UI-08](#ui-08) | Seed loading is almost invisible, then overwhelms with warnings | Offer an explicit advanced action in the Developer workspace. |
| [UI-09](#ui-09) | Receive gives raw metadata the same prominence as the address | Use one Receive card: network/account context, full address and Verify on device as primary content, QR aligned to it. |
| [UI-10](#ui-10) | Signing mixes capability, progress and reassurance | Use one request header, one visible action summary and a distinct stage indicator: Review in app → Waiting for target → Signed / Cancelled / Failed. |

All ten are P1 design acceptance items for this initiative; this is a recommended release scope, not a claim that each is a security defect.

### UI-01

**Busy background and uneven visual balance**

[Open the current screenshot](images/home-balance.jpg).

**Observed:** The lattice, glass surfaces, large unused center and long network rail compete with a small central task. The problem is allocation of attention, not a requirement that every region be mirror-symmetric.

**Proposed change:** Use an opaque reading surface and one content grid. Give the selected wallet and next action a stable location. Reserve decorative brand art for an empty-state illustration, never behind form text.

**Acceptance:** At 1280×800 and 1440×900, the active wallet, primary action and readable content occupy the same aligned content frame; no animated or patterned background sits beneath text.

**Implementation anchors:** [main.tsx](../../../projects/keepkey-vault/src/mainview/main.tsx) — `body background`; [styles/tokens.css](../../../projects/keepkey-vault/src/mainview/styles/tokens.css) — `v3-glass-card / v3-glass-pill`; [components/Dashboard.tsx](../../../projects/keepkey-vault/src/mainview/components/Dashboard.tsx) — `dashboard composition`; [components/AssetPage.tsx](../../../projects/keepkey-vault/src/mainview/components/AssetPage.tsx) — `asset glass layout`.

### UI-02

**Tiny monospace prose obscures hierarchy**

[Open the current screenshot](images/type-hierarchy.jpg).

**Observed:** theme.ts deliberately aliases sans and serif to the mono stack. Chooser labels/actions use 10–12px text; metadata and supporting prose compete at nearly the same weight. The capture blocked remote fonts, but the all-mono policy and declared sizes are source facts.

**Proposed change:** Use a bundled system/sans face for UI prose; keep mono for addresses, paths, hashes and numeric columns. Define and migrate a small type scale and spacing scale together.

**Acceptance:** Main instructions read at 15–16 CSS px, labels at 13–14; these are product targets, not WCAG font-size rules. No essential action or instruction uses the low-contrast text-3 token.

**Implementation anchors:** [theme.ts](../../../projects/keepkey-vault/src/mainview/theme.ts) — `FONT_SANS = FONT_MONO`; [index.css](../../../projects/keepkey-vault/src/mainview/index.css) — `global font family`; [styles/tokens.css](../../../projects/keepkey-vault/src/mainview/styles/tokens.css) — `text-3 and font aliases`; [components/EmulatorWalletChooser.tsx](../../../projects/keepkey-vault/src/mainview/components/EmulatorWalletChooser.tsx) — `10–12px helper and action text`.

### UI-03

**Setup, wallet and emulator look like separate products**

[Open the current screenshot](images/component-consistency.jpg).

**Observed:** The green setup heading, purple emulator affordance, gold wallet surfaces, orange native preview, different radii and different dialog proportions make related steps feel disconnected. PIN privacy is a valid reason for a specialized layout, not a different design language.

**Proposed change:** Share surface, type, radius, spacing, field, notice and task-dialog primitives across setup, settings, signing and emulator views. Keep task-specific structure and real device pixels.

**Acceptance:** Setup, PIN, seed load and signing share header/body/footer rhythm and button roles. The PIN matrix preserves its original spatial mapping; actual OLED pixels remain unaltered.

**Implementation anchors:** [components/OobSetupWizard.tsx](../../../projects/keepkey-vault/src/mainview/components/OobSetupWizard.tsx) — `setup shell and Developer Seed Loading`; [components/device/PinEntry.tsx](../../../projects/keepkey-vault/src/mainview/components/device/PinEntry.tsx) — `PIN card and spatial matrix`; [components/device/SigningApproval.tsx](../../../projects/keepkey-vault/src/mainview/components/device/SigningApproval.tsx) — `approval shell`.

Compare the [current PIN dialog](images/pin-dialog.jpg) and [native emulator preview](images/native-preview.jpg). Task-specific layouts are appropriate; reuse the same visual rules and control semantics.

### UI-04

**Settings is a long inventory rather than a navigable place**

[Open the current screenshot](images/settings-structure.jpg).

**Observed:** Device, Emulator, Security, Signing Policy, Application, Browser use, Networks, Feature Flags, API Services and Danger Zone share one narrow scrolling drawer. Users must know which accordion hides a task; native scrollbars are hidden globally.

**Proposed change:** Move settings into a full content view with categories: General, Wallet & device, Connections, Developer, Advanced & reset. Give every category a stable heading and a visible scroll affordance.

**Acceptance:** A category can be reached directly and restored after closing. Its heading, selected category and active target remain visible while its content scrolls. No nested accordion search is required for common tasks.

**Implementation anchors:** [components/DeviceSettingsDrawer.tsx](../../../projects/keepkey-vault/src/mainview/components/DeviceSettingsDrawer.tsx) — `Section, Application, Feature Flags`; [index.css](../../../projects/keepkey-vault/src/mainview/index.css) — `global hidden scrollbar rule`.

### UI-05

**Starting an emulator spans too many disconnected surfaces**

[Open the current screenshot](images/emulator-entry.jpg).

**Observed:** Enablement is in Settings → Feature Flags; launching is in the device grid; choosing a profile is another modal; setup and seed loading use the wizard; runtime controls return to Settings; the preview is a separate window. This is a fragmented task model.

**Proposed change:** Create a Developer workspace with an Emulator page for profiles, selected build, Start/Stop, setup, preview and diagnostics. Retain a simple launcher shortcut from wallet selection. Make first use reachable with no connected device and no cached wallet.

**Acceptance:** From a clean app state with no hardware and no cached wallets, the developer can enable tools, create a blank named profile, select a build, start it and identify the target without changing unrelated settings. Fresh-start reachability still needs an actual native-app reproduction.

**Implementation anchors:** [App.tsx](../../../projects/keepkey-vault/src/mainview/App.tsx) — `emulatorEnabled / render phases`; [components/DeviceGrid.tsx](../../../projects/keepkey-vault/src/mainview/components/DeviceGrid.tsx) — `handleStartEmu / pickingSeed`; [components/DeviceSettingsDrawer.tsx](../../../projects/keepkey-vault/src/mainview/components/DeviceSettingsDrawer.tsx) — `toggleEmulator`.

### UI-06

**The profile chooser has an inconsistent modal shell**

[Open the current screenshot](images/profile-dialog.jpg).

**Observed:** The long title wraps, the close control literally renders &times;, the name field uses placeholder-only guidance, and a small Create action floats inside a different panel style. “Seed” names a profile file, a wallet and recovery words in different contexts.

**Proposed change:** Use the shared dialog shell: “Choose emulator profile”, a labelled name field, a real close icon/button, selectable profile rows and aligned Cancel / Create profile actions. Reserve “recovery phrase” for the words themselves.

**Acceptance:** No HTML entity text is visible; the close control has an accessible name and at least the agreed icon target size. Keyboard focus is contained and restored. Long names/errors wrap without pushing actions out of view.

**Implementation anchors:** [components/EmulatorWalletChooser.tsx](../../../projects/keepkey-vault/src/mainview/components/EmulatorWalletChooser.tsx) — `NewSeedForm / uiText("&times;")`.

### UI-07

**Destructive and routine emulator actions have equal weight**

[Open the current screenshot](images/emulator-actions.jpg).

**Observed:** Wipe Emulator, Stop Emulator, Delete Flash and Change Version wrap into a similarly styled button cluster beneath transport internals. “Change Version…” opens a file picker; its label suggests a version chooser.

**Proposed change:** Put Start/Stop next to the selected profile. Expose build selection as “Load build…” or a labelled build selector with identity details. Move Wipe/Delete into a separate reset section, bound to the exact named profile.

**Acceptance:** Routine actions never share a row with Wipe/Delete. Destructive confirmation names the profile and consequence; cancelling does nothing. Build source, loaded version and hash are shown from actual backend state, not inferred from a filename.

**Implementation anchors:** [components/DeviceSettingsDrawer.tsx](../../../projects/keepkey-vault/src/mainview/components/DeviceSettingsDrawer.tsx) — `Emulator section / emuFileRef`.

### UI-08

**Seed loading is almost invisible, then overwhelms with warnings**

[Open the current screenshot](images/seed-load.jpg).

**Observed:** Developer: load seed is faint clickable Text rather than a normal accessible action. Its dialog then presents several warning paragraphs, acknowledgement and a textarea, but the active target is not the strongest visual anchor.

**Proposed change:** Offer an explicit advanced action in the Developer workspace. Start the dialog with target/profile and replacement consequence, then a concise warning, acknowledgement, labelled phrase field and Review load action. Expand background explanation on demand.

**Acceptance:** The action is keyboard reachable and readable. The selected target and replacement consequence are visible before submission. Keep the existing acknowledgement, firmware/checksum errors, PIN setup and retry behavior. Preserve the owner-authorized physical-device route as a separate explicit advanced flow; do not silently remove it or pretend emulator loading uses USB.

**Implementation anchors:** [components/OobSetupWizard.tsx](../../../projects/keepkey-vault/src/mainview/components/OobSetupWizard.tsx) — `devLoadOpen / handleDevLoadDevice / handleDevSetPin`.

The [current loading dialog](images/seed-load-dialog.jpg) shows the other half of the problem. Source inspection places emulator enablement under **Settings → Feature Flags → Emulator**, not Application. Preserve the owner decision that permits the physical-device advanced loader. Make target/transport-specific warnings accurate and keep phrase contents out of logs, analytics and report exports.

### UI-09

**Receive gives raw metadata the same prominence as the address**

[Open the current screenshot](images/receive-layout.jpg).

**Observed:** A QR column and a wide field stack leave different visual weights. Address, XPUB and path look like peer blocks; account/type selectors and small uppercase Copy controls add competing alignments.

**Proposed change:** Use one Receive card: network/account context, full address and Verify on device as primary content, QR aligned to it. Put XPUB, derivation path, change branch and index in an Advanced inspector; developer mode can open that inspector by default.

**Acceptance:** The complete address is readable and copyable without ellipsis at all supported sizes. Verification refers to the currently displayed address. QR encodes that address. Changing account/type/path cannot leave stale verified state; advanced public-key export retains its privacy explanation.

**Implementation anchors:** [components/ReceiveView.tsx](../../../projects/keepkey-vault/src/mainview/components/ReceiveView.tsx) — `CopyableField / PillToggle / showOnDevice`; [components/AssetPage.tsx](../../../projects/keepkey-vault/src/mainview/components/AssetPage.tsx) — `account and receive layout`.

### UI-10

**Signing mixes capability, progress and reassurance**

[Open the current screenshot](images/signing-hierarchy.jpg).

**Observed:** The pending approval view combines Action Required, app badge, timer, docs links, a green “Shown on your KeepKey” tier bar, explanation, signer, message and raw-data disclosures. The green segmented bar can read like completed progress before the app has sent the payload. This is a design/state-label concern, not a reproduced unauthorized-signing defect.

**Proposed change:** Use one request header, one visible action summary and a distinct stage indicator: Review in app → Waiting for target → Signed / Cancelled / Failed. Label review capability separately. Keep the message/decoded effects visible and raw request expandable.

**Acceptance:** The approve phase does not claim that a device has already displayed data. Hardware and emulator prompts name the actual target. Cancellation, disconnected targets, unknown/blind requests and stale request IDs remain explicit; no visual simplification weakens confirmation gates.

**Implementation anchors:** [components/device/SigningApproval.tsx](../../../projects/keepkey-vault/src/mainview/components/device/SigningApproval.tsx) — `approve / sending-payload / device-confirm phases`; [App.tsx](../../../projects/keepkey-vault/src/mainview/App.tsx) — `handleApproveSign / handleRejectSign`.

## Simplification proposal

### A. One application shell

Use a persistent wallet/target identity row and a small primary navigation: Wallets, Activity, Apps/connections, Developer, Settings. Account for the in-flight password-manager work during route design. Third-party integrations belong in Apps/connections; brand/service names should not compete with the wallet's primary location label.

The identity row distinguishes **physical device**, **emulator** and **watch-only** using text as well as color. Show the selected wallet/profile and live connection state together. Status, capability and security verification are separate concepts. A simulated target must never look like a physically connected signer.

For wallet content, show relevant accounts/networks first, with search and an explicit add/browse action for the rest. An empty wallet needs a useful receive/setup action, not a rail of unqueried networks competing with an empty center. Keep zero, unknown/unavailable and partial totals distinct; a visual cleanup must preserve those data semantics.

### B. One Developer workspace

Replace the current journey across settings, the grid, setup and another window with a dedicated page. Keep the wallet-selection launcher as a shortcut into that page.

Suggested page anatomy:

1. Page heading and a short software-emulator explanation.
2. A **Profile** panel: selected profile, current initialization state, create/select/import actions, and one Start/Stop control. Call the file-backed entry an **emulator profile**; call its words a **recovery phrase**.
3. A **Build** row: bundled versus local override, actual reported version, and a clear Load build action. Put full file path, hash and source revision in an expandable inspector. Developers can leave it expanded.
4. A **Preview** panel on the same grid. Use the actual 256×64 framebuffer with integer/pixel-preserving enlargement. Offer Detach preview for workflows that need the existing separate window. The panel must identify its bound profile/session and show a clear disconnected state rather than retaining a stale approval screen.
5. Secondary tabs for Profiles, Builds, Test & capture, Diagnostics. Group seed loading and reset operations by consequence; Wipe/Delete live in a separate reset section.

Keep selected profile/build explicit through blank → creating/loading → PIN required → ready, with failure/retry branches. First-use navigation must work without a physical device or cached wallet. That reachability is a required native-app acceptance run, not established by the capture fixture.

Embedding the preview is the largest structural change proposed here. Reuse the existing emulator transport and confirmation contracts. Extract the presentation layer; preserve operation IDs, window-ready acknowledgement, pending request ownership, timeout/cancellation behavior and frame capture. Detaching, stopping, switching profiles or changing builds must not approve or redirect an old request. When the preview is embedded in the same window, confirmation controls must live in the active confirmation dialog or a non-modal review surface; a modal cannot make them inert behind it. Keep one interactive confirmation owner per request when detaching or reattaching.

### C. Full-page settings and a small reusable component set

Use category navigation instead of the long drawer inventory:

| Category | Contents |
|---|---|
| General | Language, currency, number formatting, updates and window behavior |
| Wallet & device | Label, identity, PIN, passphrase, backup checks |
| Apps & connections | API Bridge, paired apps, mobile pairing, browser connection and network services |
| Developer | Emulator workspace entry, build/profile management, capture and diagnostics |
| Advanced & reset | Explicit advanced operations, with named target and consequences |

Create shared `PageShell`, `SectionCard`, `FormRow`, `TargetIdentity`, `StatusBadge`, `InlineNotice`, `TaskDialog` and action-button primitives before migrating screens. Use a few documented dialog sizes: compact PIN, medium selection/form and wide request review. The PIN grid is specialized, but its title, explanation, spacing, focus behavior and footer follow the same system.

Avoid turning this into another theme layered over the old ones. Consolidate the CSS-variable/Chakra token bridge and migrate each touched screen to the shared primitives; retire its superseded local styles in the same change. This should reduce one-off choices and custom dialog code over time.

### D. Keep the information that makes a wallet trustworthy

- **Receive:** full address and verification action first; QR aligned to that information. Collapse XPUB/path/change/index into an Advanced inspector for ordinary use, expanded by default in Developer mode. Never shorten an address to make the composition look tidy.
- **Request review:** request origin, actual target, action/message/effects, then the next step. Keep important decoded content visible. Raw payloads are expandable; warnings, unknown operations and required acknowledgements remain prominent.
- **Progress:** Review in app → Waiting for physical device/emulator → Signed, Cancelled or Failed. A review-capability label is not progress and not an assurance that the request is safe. Device-display claims require an actual device/frame event.
- **Seed loading:** show the exact target and replacement consequence first. Use concise warning copy with optional background explanation. Retain acknowledgement, valid phrase/checksum handling, firmware refusal/error reporting and target-driven PIN setup. A cancelled/mismatched PIN remains a recoverable step; do not announce setup complete early.

## Proposed visual contract

These are product design targets for the implementation, not universal accessibility rules:

| Area | Proposed default |
|---|---|
| Grid | 8px spacing rhythm, with 4px substeps; 24–32px page inset; shared horizontal alignment |
| Surfaces | Opaque graphite reading surfaces; one quiet border treatment; decoration outside task content |
| Typography | Bundled/system sans for prose; mono for cryptographic/technical values; body 15–16px, labels 13–14px, page heading 24–28px |
| Text blocks | About 60–70 characters per line for explanations; 1.4–1.6 line height |
| Actions | One obvious primary action per task; 40px regular control height, 44px for key dialog actions, 32px minimum icon target as a product default |
| Shape | One small radius scale, e.g. 8px controls / 12px panels; restrained, consistent shadows |
| Color | Keep graphite/gold identity. Gold marks selection or primary action; red/rose marks consequential failure/reset; success color appears only for a known successful state |
| Metadata | Legible label/value rows; stable value alignment; complete values available with deliberate copy controls |
| Motion | Restrained transitions; support reduced motion; no pulsing glow behind reading or approval content |

For text contrast, use the [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): ordinary text needs at least 4.5:1, with the applicable large-text threshold of 3:1. As a nominal token-pair calculation, `--text-3 #56564f` on `--ink-1 #101015` is approximately **2.57:1**; `--text-2 #8a8a82` on that surface is approximately **5.45:1**. Actual compositing and native rendering still need measurement. Low-contrast tokens belong to nonessential decoration or inactive content, not required instructions/actions.

The [W3C target-size criterion](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) uses 24×24 CSS px with defined exceptions; the larger control targets above are our proposed usability baseline. Use the [WAI modal pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) for initial focus, focus containment, Escape and focus return. Preserve operation-specific cancellation semantics when implementing those behaviors.

## Delivery plan for the Vault app

| Step | Concrete deliverable | Acceptance before moving on |
|---|---|---|
| 1 | Token/type/spacing contract + shared form/dialog primitives | Compare setup, PIN, chooser, receive and signing at native scale; verify the chosen font offline |
| 2 | Developer page and direct first-use entry | Complete empty-profile → start → load public fixture → PIN → ready; active target stays visible |
| 3 | Profile/build/runtime controls and preview integration | Start/stop/reopen and detach/reattach; compare actual profile/build identity and capture output |
| 4 | Settings category view and Receive composition | Common settings found directly; full address, QR, account and verification remain consistent |
| 5 | Signing/task-state cleanup and remaining visual migration | Known/unknown requests, rejection, disconnect, timeout and repeated operations remain correct |
| 6 | Native QA and design review, then fresh video capture | Complete the checks below on the release candidate; replace the current video sources with new captures |

The recommended next-release scope is the coherent workspace and shared primitives above. A smaller fallback is tokens, readable type, the modal/close-control fix, grouped emulator actions and truthful signing labels within the existing layout. That fallback addresses immediate readability, but leaves the settings/navigation redesign as an explicit follow-up. Make the scope visible in release planning rather than letting ten separate cosmetic patches create ten new styles.

## Acceptance and video regeneration gate

1. Review the app at its actual native minimum window size, plus 1280×800, 1440×900 and 1920×1080. Use the platform's real minimum from the window config; do not assume a screenshot viewport is supported. Check native text scaling/200% zoom and long localized labels. No clipped primary action, overlay, address or error text.
2. Verify all ten cases against fresh native screenshots. View them at 100% CSS scale before using video crops. Confirm focus indicators, essential-text contrast and target sizes on the actual composite backgrounds.
3. Run keyboard-only navigation through settings, profile creation, seed loading, PIN and request review. Dialog focus stays local and returns to the invoking action. PIN positions keep their existing mapping.
4. Exercise a clean no-device/no-cache first launch, blank profile, named profile restart, invalid phrase, cancelled/mismatched PIN, missing build, build change and stopped/disconnected preview. The supplied synthetic captures do not prove those native flows.
5. Run approval, rejection, a read after rejection and consecutive operations on the **Desktop native-library path**, with a public fixture. Keep standalone UDP evidence separate. Switching profiles/builds or closing/detaching preview cannot complete an old confirmation or leave stale target data visible.
6. Preserve hardware confirmation authority, unknown/blind-sign warnings, the advanced physical-device seed-loader decision, and secret-handling boundaries. UI simplification cannot weaken protocol gates or move sensitive data into logs/reports.
7. Save the reviewed source revision/dirty state, native build identity, transport, artifact hash and screenshot hashes in internal evidence. Source presence does not establish public release availability.
8. After the revised UI passes design/native acceptance, regenerate the SOP captures and videos from those screens. The new series should show the actual app steps, device/emulator screens and real developer output wherever applicable. Treat rendering/loudness/playback checks as video checks, separate from application acceptance.

## Video backlog after the UI review

The stopped production package is `keepkey-backend-v3/projects/content/video-series/vault/emulator-production/`. Keep its scripts and evidence; replace the visual sources after native UI acceptance.

| Lesson | UI cases to resolve before fresh capture |
|---|---|
| Start an isolated emulator | UI-02, UI-04, UI-05, UI-06, UI-07 |
| Hidden seed loading and PIN setup | UI-03, UI-06, UI-08 |
| Verify fixture and address | UI-09, shared target identity |
| Approval, rejection and recovery | UI-10, shared dialog system |
| Build, run and test | UI-04, UI-05, UI-07; preserve real command evidence |
| Debugging and evidence handoff | UI-04, UI-05, UI-07, UI-10 |

Video regeneration remains a later step after the app changes; this handoff does not schedule or restart it.

## Handoff boundary

Use the HTML as a layout/interaction reference. Its local example state and disabled protocol actions are not production application code. Implement the design through the existing React/Chakra app and real backend contracts.


This package contains an audit and an interactive layout proposal. It does not change application behavior, firmware, credentials, customer data or release state. Continue from the current target checkout while preserving other contributors' work. No video production should resume until the owner’s requested UI improvement/review step is complete.
