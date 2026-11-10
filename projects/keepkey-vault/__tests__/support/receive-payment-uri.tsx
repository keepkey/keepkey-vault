/** Actual ReceiveView with a captured QR payload/clipboard; no device or network. */
import { mock } from 'bun:test'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MouseEvent']) (globalThis as any)[key] = (dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
let encoded: string | null = null
let clipboard: string | null = null
const deviceCalls: string[] = []
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { clipboard = value } } })
mock.module('../../src/mainview/lib/qr', () => ({ generateQRSvg: (value: string) => { encoded = value; return '<svg xmlns="http://www.w3.org/2000/svg"/>' } }))
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string) => { deviceCalls.push(method); throw new Error('Device access is forbidden in this fixture') }, onRpcMessage: () => () => {} }))
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { CHAINS } = await import('../../src/shared/chains')
const { ReceiveView } = await import('../../src/mainview/components/ReceiveView')
const account = '0x1234567890123456789012345678901234567890'
const cashaddr = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
const cases = [
  { name: 'bitcoin', chain: 'bitcoin', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' },
  { name: 'litecoin', chain: 'litecoin', address: 'LZMFgV5boQq9YwJsXpq4PhRriqKdiP5A6D' },
  { name: 'dogecoin', chain: 'dogecoin', address: 'D8B1yGgkdbPFk78B1XWjNrKA8QJxGVhDSd' },
  { name: 'dash', chain: 'dash', address: 'XoZW4AwNbRzJ6gN3h8JgX7mWmZCybHroex' },
  { name: 'digibyte', chain: 'digibyte', address: 'D7QJgbZxL9R8d3FqmSjuPQyJY4Uv8wKJtu' },
  { name: 'zcash', chain: 'zcash', address: 't1RyvJryUwNNqAfEWqzwVphinduyhVsE3Sz' },
  { name: 'bitcoincash', chain: 'bitcoincash', address: cashaddr },
  { name: 'cashaddr-prefixed', chain: 'bitcoincash', address: `bitcoincash:${cashaddr}` },
  { name: 'cashaddr-uppercase', chain: 'bitcoincash', address: `BITCOINCASH:${cashaddr.toUpperCase()}` },
  { name: 'ethereum', chain: 'ethereum', address: account },
  { name: 'base-token', chain: 'base', address: account, assetCaip: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { name: 'solana', chain: 'solana', address: '9xQeWvG816bUx9EPjHmaT23yvVMFPrT1SgfXVtbdZ9J' },
  { name: 'ripple', chain: 'ripple', address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' },
  { name: 'cosmos', chain: 'cosmos', address: 'cosmos1syntheticownwalletaddress' },
  { name: 'thorchain', chain: 'thorchain', address: 'thor1syntheticownwalletaddress' },
  { name: 'hive', chain: 'hive', address: 'STMsyntheticpublickey' },
]
const result: Record<string, unknown> = {}
for (const value of [...cases, { name: 'evmMismatch', chain: 'ethereum', address: account, assetCaip: 'eip155:8453/slip44:60' }]) {
  encoded = null; clipboard = null
  const chain = CHAINS.find(chain => chain.id === value.chain)
  if (!chain) throw new Error(`Missing fixture chain ${value.chain}`)
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(<ChakraProvider value={defaultSystem}><ReceiveView chain={chain} address={value.address} assetCaip={value.assetCaip} currentPath={chain.defaultPath} loading={false} onDerive={() => { throw new Error('No device derivation allowed') }} /></ChakraProvider>) })
  if (value.name === 'evmMismatch') result[value.name] = { qr: encoded, alert: !!container.querySelector('[role="alert"]') }
  else {
    const addressButton = [...container.querySelectorAll('button')].find(button => button.textContent === value.address)
    if (!addressButton) throw new Error(`Raw ${value.name} address is not displayed`)
    await act(async () => { addressButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    result[value.name] = { address: value.address, qr: encoded, displayed: addressButton.textContent, copied: clipboard }
  }
  await act(async () => root.unmount()); container.remove()
}
result.deviceCalls = deviceCalls
console.log(JSON.stringify(result))
dom.window.close()
