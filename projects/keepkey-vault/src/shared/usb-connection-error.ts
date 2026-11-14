/**
 * Plain-language classification of the raw USB/transport error the engine
 * reports in DeviceStateInfo.error (libusb codes from node-usb, WebUSB/HID
 * DOMException text, errno names). The UI shows the reason and what to do;
 * the raw code stays visible as a detail for support.
 */
export type UsbConnectionErrorKind = 'in-use' | 'disconnected' | 'not-responding' | 'unknown'

const PATTERNS: [UsbConnectionErrorKind, RegExp][] = [
  // Another process holds the interface (KeepKey Desktop/Bridge, a browser tab
  // using WebUSB), or the OS refused the open.
  ['in-use', /LIBUSB_ERROR_(?:ACCESS|BUSY)|\bEACCES\b|\bEBUSY\b|permission denied|access denied|unable to claim interface|resource busy|already (?:open|in use)/i],
  ['disconnected', /LIBUSB_ERROR_(?:NO_DEVICE|NOT_FOUND)|\bENODEV\b|\bENXIO\b|device (?:was )?(?:disconnected|unplugged|not found)|no device selected/i],
  ['not-responding', /LIBUSB_ERROR_(?:TIMEOUT|PIPE|IO|OVERFLOW|INTERRUPTED)|\bETIMEDOUT\b|\bEPIPE\b|\bEIO\b|transfer (?:error|timed out)|timed out/i],
]

export function usbConnectionErrorKind(raw: string | null | undefined): UsbConnectionErrorKind {
  if (!raw) return 'unknown'
  for (const [kind, pattern] of PATTERNS) if (pattern.test(raw)) return kind
  return 'unknown'
}
