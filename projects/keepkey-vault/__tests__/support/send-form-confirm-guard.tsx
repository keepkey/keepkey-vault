// Jasper audit v5 V9: a burn-address or self-send confirmation counts only for the recipient
// it was given for, even in the render right after the recipient changes.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, setInput, press, checkbox, button, input, calls, dispatchClick, settle, click, lastBuild } from './send-form-fixture'
const eth = chainById('ethereum'), owner = '0x' + '11'.repeat(20)
const dead = '0x000000000000000000000000000000000000dEaD', zero = '0x0000000000000000000000000000000000000000'
const builds = () => calls.filter(c => c.method === 'buildTx')
await mount({ chain: eth, address: owner, balance: { chainId: 'ethereum', balance: '10', balanceUsd: 1, nativeBalanceUsd: 1, address: owner, syncState: 'confirmed' } })
await setRecipient(dead); await setInput('amountPlaceholder', '1')
await press(checkbox()!)
expect(button('buildTransaction').disabled).toBe(false)

// Switch to another burn address and click Build in the same task, before effects run.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false
const field = input('addressPlaceholder')
Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, zero)
field.dispatchEvent(new window.Event('input', { bubbles: true }))
dispatchClick(button('buildTransaction'))
await new Promise(resolve => setTimeout(resolve, 0))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
await settle(400)
const summary: Record<string, unknown> = { staleClickBuilds: builds().length }
expect(checkbox()!.checked).toBe(false)
expect(button('buildTransaction').disabled).toBe(true)

// Confirming the new recipient lets it build, to that recipient.
await press(checkbox()!)
await click('buildTransaction')
expect(lastBuild()!.params.to).toBe(zero)
summary.confirmedBuilds = builds().length
await unmount()

// Self-send: the confirmation does not carry over to an edited recipient string.
const own = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
await mount({ chain: eth, address: own, balance: { chainId: 'ethereum', balance: '10', balanceUsd: 1, nativeBalanceUsd: 1, address: own, syncState: 'confirmed' } })
await setRecipient(own); await setInput('amountPlaceholder', '1')
await press(checkbox()!)
expect(button('buildTransaction').disabled).toBe(false)
await setRecipient(own.toLowerCase())
summary.selfSendReconfirm = checkbox()!.checked === false && button('buildTransaction').disabled
await unmount()

expect(summary).toEqual({ staleClickBuilds: 0, confirmedBuilds: 1, selfSendReconfirm: true })
console.log(JSON.stringify(summary))
