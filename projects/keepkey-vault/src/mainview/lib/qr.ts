import QRCode from "qrcode"

/** Standards-compliant QR versions 1–40. Keep this synchronous for existing address views. */
export function generateQRSvg(text: string, moduleSize = 4, quietZone = 4): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" })
  const size = qr.modules.size
  const dimension = size + quietZone * 2
  const paths: string[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.modules.get(y, x)) paths.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" width="${dimension * moduleSize}" height="${dimension * moduleSize}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${dimension}v${dimension}H0z"/><path fill="#000" d="${paths.join("")}"/></svg>`
}
