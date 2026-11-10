# UpdateBanner responsive regression

Manual browser fixture using the actual component, theme, app reset and tokens.
It opens no server, device, app profile or API. Every browser network request is
blocked, so measurements use the supported offline monospace font fallback.
Online-loaded Geist can have different pixel widths.

From `projects/keepkey-vault`, after the normal project dependencies are installed:

```sh
bun __tests__/fixtures/update-banner/build.ts
node __tests__/fixtures/update-banner/smoke.mjs
```

Use an existing Playwright installation/browser; this fixture installs nothing:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROME_EXECUTABLE=/path/to/Chrome \
CORE_QA_EVIDENCE=/tmp/update-banner-evidence \
node __tests__/fixtures/update-banner/smoke.mjs
```

`PLAYWRIGHT_TEST_MODULE` is also supported, or locally installed `@playwright/test`
is used. `UPDATE_BANNER_STORY_DIR` optionally selects the build output directory
and must match for both commands. Defaults use the operating system's temp folder.
Playwright's clock API checks the existing 20-second toast timeout without waiting.

The fixture checks 320/390/1280px with English, expanded German and unbroken stress
labels: available, ready, applying, downloading with/without known progress, plus
idle/checking visibility and warning/error dismissal. It asserts readable titles,
contained/wrapped buttons, small-screen action placement, callbacks and no browser
errors. Screenshots and exact geometry are written to `layout.json` in the evidence
directory. Expected result: **45 layout states, zero failures, 36 click callback
checks and one timer check**.

Before the responsive fix, the 320px ready banner's title was 0px wide and Restart
ended at x=328.7 outside the viewport; at 390px its title was only 32.3px wide.
The fixed English case measured 206px/276px title widths and contained buttons;
the ordinary 1280px desktop geometry stayed unchanged.
