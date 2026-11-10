# Release UI audit — November 10, 2026

This audit compares the current candidate with v1.6.10 (`88caa37014`),
v1.6.9 (`6e12d01ea2`) and stable v1.6.7 (`e3b416c4ea`). It uses real React
components with synthetic native RPC replies. It does not open a real wallet,
change application flags, access the real Vault API or perform device operations.

## Confirmed issue addressed

**The Zcash Dashboard still offered a separate Privacy shortcut.** The unified
AssetPage implementation was present in the merged source, but Dashboard's
drilled Zcash action row still added a fourth, purple Privacy action. The
existing unified fixture mounted AssetPage directly and could not see that
remaining entry point. Root removed the Dashboard shortcut in `4bbc47982`.

The focused Dashboard regression now traverses the actual Dashboard to Zcash
Receive and Send, verifies the common transparent/shielded pool selector, and
asserts that no Privacy shortcut remains. Zcash is enabled only in intercepted
browser RPC replies for this explicit user-requested check. Fixture settings
stay disabled; navigation invokes no private initialization, signing, building,
broadcasting or settings mutation.

| Check | Result | Local evidence |
| --- | --- | --- |
| Existing unified Zcash asset-page browser checks | 13/13 pass, no page errors | `/private/tmp/keepkey-zcash-unified-review-20261110/zcash-ui-results.json` |
| Actual Dashboard → unified Zcash Receive/Send | 6/6 pass, no page errors | `/private/tmp/keepkey-zcash-dashboard-review-20261110/zcash-dashboard-results.json` |

Screenshots in those directories show the standard Dashboard actions, unified
Receive and Send, transparent default, shielded Receive and a 390-pixel mobile
layout. The existing suite also covers disabled privacy, old firmware,
watch-only, legacy Privacy deep links and advanced-tool collapse behavior.

## Bounded default-screen pass

The desktop/mobile synthetic sweep captured 30 states at 1280×900 and 390×844:
portfolio/sidebar, Bitcoin and Ethereum Receive/Send, swap input/review, empty
swap history, General/Device/Security/Networks/Connections/Advanced settings,
and the current-PIN overlay. There were no horizontal-overflow measurements or
browser runtime errors. Swap and settings dialog bounds stayed within their
viewports. All optional feature flags remained disabled, and no settings,
signing, broadcast or execution mutation was requested.

Evidence and the isolated runner are under
`/private/tmp/keepkey-ui-audit-20261110/`; `results.json` records every viewport
and dialog measurement, and the corresponding PNGs preserve the rendered
states. Screenshots are full-page captures: content below the bottom edge of
a fixed settings drawer is outside the actual viewport, not drawer leakage.

**No additional P1 visual regression was confirmed in this bounded pass.** The
Zcash entry-point mismatch above was the concrete user-visible issue and is now
covered through Dashboard navigation. The restored swap animation/network
labels and the grouped settings pages remain readable at both widths. Source
comparison shows that PIN and firmware-preview layouts are unchanged from
v1.6.10; their differences from v1.6.9/stable are translation wiring. The main
onboarding differences are the explicit official-firmware installation action
and corrected escaped arrows. Global palette/type tokens have not changed
from those baselines.

Onboarding/firmware and actual lock-to-unlock transitions were source-reviewed;
they were not exercised through real setup, flashing or a physical device.
Those lifecycle and native platform acceptance checks remain separate release
gates. This is a bounded candidate review, not an exhaustive visual or WCAG
certification, and it does not establish identical pixel rendering across
previous release binaries.

Packaged `views://` asset loading is a native WebView feature. A regular Chrome
fixture can show missing packaged icons even when native loading works; those
broken-image placeholders are not counted as production visual regressions.
Optional features stay disabled in the main-flow pass. Zcash is the explicit
focused exception described above.

No additional production changes are owned by this audit. Findings go to root
for triage before implementation.

## Subsequent UI PR review

The 30-state sweep above predates PRs #635–641. It must not be represented as
qualification of their combined global theme/reset changes.

| PR/head reviewed | Bounded source review |
| --- | --- |
| #635 `6983edeff` | Shared ActionButton forwards refs/native Button props, preserves default tone and disabled behavior; wallet-card handlers remain intact. Global reset-layer and button-recipe changes affect all controls, so combined main-flow browser QA is required. |
| #636 `40e8d6264`, compared with #635 | Styling substitutions preserve handler, disabled, loading and watch-only conditions. It depends on #635's helper/theme and should not be treated as a standalone change. |
| #637 `8ce635aa5` | Exact Base native CAIP receives a local icon override; no account/network routing or transaction data changes. |
| #638 `7818f20c6` | OOB step/status styling changes preserve setup handlers and update gates. |
| #639 `2856c447d` | Receive QR CSS/size and embedded Zcash action styling preserve verification, copy, disabled and advanced-tool handlers. |
| #640 `28a96e6db` | Picker footer spacing/sizes preserve cancel, keep-all, save and continue behavior. |
| #641 `64048cf57` | Phase/action wiring is preserved, but a narrow-layout regression was confirmed and sent to root for correction. |

For #641, an isolated no-network browser story renders the exact PR UpdateBanner
with the exact #635 theme/ActionButton. At 320 pixels in the ready phase, the
banner ends at x=304 while Restart to Update ends at x=328.7, outside the
viewport; the status-title width becomes zero. At 390 pixels the status title
has only 32 pixels. Fixed icon/gaps and a nonshrinking, nonwrapping action row
leave no room for the copy. The security reviewer applied the responsive-stack
correction and completed 72 before/after story cases across 320/390/1280 pixels,
three text lengths and four phases. Corrected cases had no layout/browser
errors; 36 callbacks passed. The 320-pixel title width increased from zero to
206 pixels, the 390-pixel title from 32 to 276 pixels, and desktop geometry was
unchanged. Evidence is under
`/private/tmp/keepkey-ui-pr-review-20261110/responsive-evidence`.

The current-PR measurements/screenshots are preserved under
`/private/tmp/keepkey-ui-pr-review-20261110/after/`. This story confirmed native
disabled semantics and keyboard activation of the shared ActionButton without
running application update handlers. The combined actual-component run is
recorded in the following section.

## Combined integration UI qualification

After local integration of #635–641 and the responsive UpdateBanner correction,
the actual component sweep was rerun at 1280×900 and 390×844. All 30 states
completed with no horizontal overflow or browser runtime errors. This is new
evidence for the combined reset/theme/control styles, not reuse of the earlier
baseline screenshots.

The four Bitcoin/Ethereum Receive samples measured a 184×184 white frame,
12-pixel padding and a 160×160 SVG. Horizontal/vertical center deltas were zero.
Actual Copy clicks completed using an in-memory clipboard. Button computed
padding, geometry and center-hit measurements are recorded, and the sweep
successfully clicked the normal navigation, swap review/close, history close
and six settings-section controls. Background controls covered by an active
modal, or scrolled under the fixed top navigation after Copy, are not treated
as foreground click-target failures. No concrete new regression was confirmed.

Evidence: `/private/tmp/keepkey-ui-audit-integration-20261110/results.json`,
`summary.json` and 30 PNGs. The earlier evidence directories are preserved.
All optional flags remained disabled; no application setting, transaction,
signing or broadcast operation was requested. The localhost fixture server
was stopped after the sweep.

The earlier focused Zcash 13+6 checks were not rerun after this UI integration:
the user requested wrap-up before additional scans. Their gating/navigation
evidence remains recorded above; updated shielded-QR styling is source-reviewed
but is not represented as a newly executed 19-check pass. Setup/firmware and
physical/native acceptance limits also remain as described above.
