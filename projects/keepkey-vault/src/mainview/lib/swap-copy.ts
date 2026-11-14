/** Translated swap copy that is chosen at runtime, so it cannot be JSX text (V20). */
import type { UiValues } from '../i18n/ui'

type UiText = (text: string, values?: UiValues) => string

/** The asset picker's title and step line. */
export function swapPickerHeading(
  state: { side: 'from' | 'to'; confirm: boolean; unavailable: boolean; network?: string },
  uiText: UiText,
): { title: string; stepLabel: string } {
  const { side, confirm, unavailable, network } = state
  const title = confirm ? uiText("Confirm your selection")
    : side === "from" ? uiText("Select asset to swap from")
    : unavailable ? uiText("Route unavailable")
    : network ? uiText("Assets on {{network}}", { network })
    : uiText("Select destination network")
  const stepLabel = confirm ? (side === "from" ? uiText("Review the input before continuing") : uiText("Review the output before continuing"))
    : side === "from" ? uiText("Step 1 of 2 — pick what you're swapping")
    : network ? uiText("Step 2 of 2 — pick an asset on {{network}}", { network })
    : uiText("Step 2 of 2 — choose destination network")
  return { title, stepLabel }
}

/** The picker's confirm button: one sentence per side, so word order is the translator's. */
export function swapPickerConfirmLabel(side: 'from' | 'to', symbol: string, network: string, uiText: UiText): string {
  return side === "from" ? uiText("Use {{symbol}} on {{network}} as input", { symbol, network })
    : uiText("Use {{symbol}} on {{network}} as output", { symbol, network })
}

/** Fee labels Bun's swap-fees.ts writes in English. A label a provider sent is shown as sent. */
export function swapFeeLabel(label: string, uiText: UiText): string {
  switch (label) {
    case 'Relay app fee': return uiText("Relay app fee")
    case 'Source network fee (estimate)': return uiText("Source network fee (estimate)")
    case 'Relay execution fee': return uiText("Relay execution fee")
    case 'NEAR app fee': return uiText("NEAR app fee")
    case 'Destination withdrawal fee': return uiText("Destination withdrawal fee")
    case 'Affiliate fee': return uiText("Affiliate fee")
    case 'Outbound fee': return uiText("Outbound fee")
    case '0x fee': return uiText("0x fee")
    case 'Partner fee': return uiText("Partner fee")
    case 'ShapeShift fee': return uiText("ShapeShift fee")
    case 'Provider fee': return uiText("Provider fee")
    default: return label
  }
}
