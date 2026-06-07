// Windows USB diagnostic probe (read-only).
//
// When a KeepKey "plays the connection chime but the app never sees it" on
// Windows, the device was enumerated by Windows but WinUSB is not (yet/ever)
// bound to its vendor interface — so it is invisible to libusb / the `usb`
// package. This probe runs READ-ONLY PowerShell queries to tell the user which
// of the known causes they're hitting, so they (and support) get a labelled
// signal instead of a guess. See docs/WINDOWS-USB-AUDIT.md for the analysis.
//
// Privacy: collects only presence/driver/registry-cache signals + OS/app
// version. It never touches the wallet and never includes the device serial,
// labels, xpubs, or addresses. The full InstanceId (which carries the serial)
// is NOT returned — only the boolean presence and the bound-driver name.

import { usb } from "usb"

import type { UsbDiagnosticCause, UsbDiagnosticReport } from "../shared/types"

const KEEPKEY_VENDOR_ID = 0x2b24

type LikelyCause = UsbDiagnosticCause

interface WinProbeRaw {
  present: boolean
  status: string | null
  service: string | null
  osvc: string | null
}

// Single read-only PowerShell pass. Outputs compact JSON. `-NoProfile` avoids a
// hang on a misconfigured profile; `-NonInteractive` prevents any prompt.
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$dev = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_2B24' } | Select-Object -First 1
$svc = $null
if ($dev) { $svc = (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName 'DEVPKEY_Device_Service').Data }
$osvc = $null
$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\usbflags\\2B2400020100'
if (Test-Path $k) {
  $v = (Get-Item $k).GetValue('osvc')
  if ($v) { $osvc = (($v | ForEach-Object { $_.ToString('X2') }) -join ' ') }
}
[pscustomobject]@{
  present = [bool]$dev
  status  = if ($dev) { "$($dev.Status)" } else { $null }
  service = $svc
  osvc    = $osvc
} | ConvertTo-Json -Compress
`

async function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  try {
    const exitCode = await proc.exited
    const out = await new Response(proc.stdout as any).text()
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr as any).text()
      throw new Error(err.trim() || `powershell exited ${exitCode}`)
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

function libusbSeesKeepKey(): boolean {
  try {
    return usb.getDeviceList().some((d) => d.deviceDescriptor?.idVendor === KEEPKEY_VENDOR_ID)
  } catch {
    return false
  }
}

function classify(
  libusbDetected: boolean,
  win: (WinProbeRaw & { probeErrorPresent: boolean }) | null
): {
  cause: LikelyCause
  headline: string
  guidance: string
} {
  if (libusbDetected) {
    return {
      cause: "detected",
      headline: "Your KeepKey is detected by the system.",
      guidance:
        "The device is reachable. If the app still doesn't show it, fully quit KeepKey Vault (check the system tray) and relaunch. If it persists, restart your computer.",
    }
  }
  if (!win || win.probeErrorPresent) {
    return {
      cause: "unknown",
      headline: "Couldn't determine the cause automatically.",
      guidance:
        "The diagnostic couldn't query Windows USB state. Try a different USB cable (must be a data cable, not charge-only) and a port directly on the computer (not a hub or dock), then unplug and re-plug your KeepKey. Copy this report and contact support.",
    }
  }
  if (!win.present) {
    return {
      cause: "not-present",
      headline: "Windows doesn't see a KeepKey at all.",
      guidance:
        "Use a different USB cable — many cables are charge-only and carry no data — and plug directly into a port on the computer (not a hub, dock, or monitor). Try each USB port. If you heard the Windows connection chime but this still says not-present, copy this report and contact support.",
    }
  }
  if (win.osvc === "00 00") {
    return {
      cause: "B",
      headline: "Windows cached a bad driver record for your KeepKey.",
      guidance:
        "Windows recorded that this device has no driver and won't retry. Open Device Manager, find the KeepKey (look for a warning icon under 'Universal Serial Bus devices' or 'Other devices'), uninstall it, then unplug and re-plug. Copy this report and contact support — a fix is in progress.",
    }
  }
  if (win.service && win.service.toLowerCase() !== "winusb") {
    return {
      cause: "C",
      headline: `A conflicting USB driver ("${win.service}") is bound to your KeepKey.`,
      guidance:
        "Another driver (often left over from an old KeepKey app or a tool like Zadig) is attached instead of WinUSB. In Device Manager, find the KeepKey, choose Uninstall device (tick 'Delete the driver software' if offered), then unplug and re-plug. Copy this report and contact support.",
    }
  }
  if (win.service && win.service.toLowerCase() === "winusb") {
    return {
      cause: "A",
      headline: "Windows sees your KeepKey with the correct driver, but the app can't open it yet.",
      guidance:
        "This is usually a slow USB hub/dock or another app holding the device. Plug directly into a port on the computer (not a hub or dock); close any other KeepKey apps and browser tabs using WebUSB; then unplug and re-plug. Give it ~15 seconds. If it persists, copy this report and contact support.",
    }
  }
  return {
    cause: "unknown",
    headline: "Windows sees the device but its driver state is unclear.",
    guidance:
      "Open Device Manager, find the KeepKey, choose Uninstall device, then unplug and re-plug. Copy this report and contact support.",
  }
}

function buildText(r: Omit<UsbDiagnosticReport, "text">): string {
  const lines: string[] = []
  lines.push("KeepKey Vault — USB diagnostic")
  lines.push(`Time: ${new Date(r.timestamp).toISOString()}`)
  lines.push(`App: ${r.appVersion}`)
  lines.push(`OS: ${r.platform} ${r.osVersion}`)
  lines.push(`Visible to app (libusb): ${r.libusbDetected ? "yes" : "no"}`)
  if (r.windows) {
    lines.push(`Windows PnP present: ${r.windows.pnpPresent ? "yes" : "no"}`)
    lines.push(`PnP status: ${r.windows.status ?? "n/a"}`)
    lines.push(`Bound driver: ${r.windows.boundService ?? "none"}`)
    lines.push(`MS OS cache (osvc): ${r.windows.osvc ?? "n/a"}`)
    if (r.windows.probeError) lines.push(`Probe error: ${r.windows.probeError}`)
  }
  lines.push(`Likely cause: ${r.likelyCause}`)
  lines.push(`Summary: ${r.headline}`)
  lines.push(`Suggested: ${r.guidance}`)
  return lines.join("\n")
}

/**
 * Run the USB diagnostic. Never throws — every failure path produces a report
 * with `likelyCause: "unknown"` (or "non-windows" off Windows) so the UI always
 * has something to show and copy.
 */
export async function runUsbDiagnostic(appVersion: string): Promise<UsbDiagnosticReport> {
  const os = await import("node:os")
  const timestamp = Date.now()
  const platform = process.platform
  const osVersion = `${os.release?.() ?? ""} (${os.arch?.() ?? ""})`.trim()
  const libusbDetected = libusbSeesKeepKey()

  if (platform !== "win32") {
    const base = {
      timestamp,
      appVersion,
      platform,
      osVersion,
      libusbDetected,
      likelyCause: (libusbDetected ? "detected" : "non-windows") as LikelyCause,
      headline: libusbDetected
        ? "Your KeepKey is detected by the system."
        : "USB driver diagnostics are only available on Windows.",
      guidance: libusbDetected
        ? "The device is reachable. If the app doesn't show it, fully quit and relaunch KeepKey Vault."
        : "On macOS/Linux, use the on-screen guidance for your platform. Copy this report if contacting support.",
    }
    return { ...base, text: buildText(base) }
  }

  let win: (WinProbeRaw & { probeErrorPresent: boolean }) | null = null
  let probeError: string | null = null
  try {
    const out = await runPowerShell(PS_SCRIPT, 8000)
    const parsed = JSON.parse(out.trim()) as WinProbeRaw
    win = {
      present: Boolean(parsed.present),
      status: parsed.status ?? null,
      service: parsed.service ?? null,
      osvc: parsed.osvc ?? null,
      probeErrorPresent: false,
    }
  } catch (err: any) {
    probeError = err?.message || String(err)
    win = { present: false, status: null, service: null, osvc: null, probeErrorPresent: true }
  }

  const { cause, headline, guidance } = classify(libusbDetected, win)
  const base = {
    timestamp,
    appVersion,
    platform,
    osVersion,
    libusbDetected,
    windows: {
      pnpPresent: win.present,
      status: win.status,
      boundService: win.service,
      osvc: win.osvc,
      probeError,
    },
    likelyCause: cause,
    headline,
    guidance,
  }
  return { ...base, text: buildText(base) }
}
