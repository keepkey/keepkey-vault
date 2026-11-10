import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { CHAINS } from '../src/shared/chains'
import { broadcastHttpRejectionReason, broadcastRejectionReason } from '../src/bun/txbuilder/broadcast-error'

// Execute the actual dispatcher without importing its DB, device or sidecars.
const path = '../src/bun/txbuilder/index.ts'
const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'broadcastTx')
if (!declaration) throw new Error('Missing production broadcastTx')
const js = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const forbidden = () => { throw new Error('Network, device and alternate broadcast backends are forbidden') }
const bindings = {
  broadcastHttpRejectionReason, broadcastRejectionReason,
  BTC_NETWORK_ID: CHAINS.find(c => c.id === 'bitcoin')!.networkId,
  getBtcBackend: forbidden, fetch: forbidden, broadcastTonBoc: forbidden,
  broadcastHiveTx: forbidden, tronWalletFetch: forbidden,
  console: { debug() {}, log() {}, error() {} },
}
const broadcastTx = new Function(...Object.keys(bindings), `${js}; return broadcastTx`)(...Object.values(bindings))
const zcash = CHAINS.find(c => c.id === 'zcash')!
const serializedTx = 'deadbeef'
const upgradeReason = 'Blockbook broadcast failed: transaction version 4 is not supported by network upgrade Nu7'

for (const field of ['obj', 'body', 'data']) {
  for (const asJson of [false, true]) {
    test(`actual broadcast surfaces the consensus rejection in Swagger response.${field} (${asJson ? 'JSON' : 'object'})`, async () => {
      const body = { error: { code: 'utxo_error', message: upgradeReason } }
      const error = Object.assign(new Error('Bad Request'), { status: 400, statusText: 'Bad Request', response: { [field]: asJson ? JSON.stringify(body) : body } })
      const calls: unknown[] = []
      const pioneer = { Broadcast: async (params: unknown) => { calls.push(params); throw error } }
      await expect(broadcastTx(pioneer, zcash, { serializedTx })).rejects.toThrow(`Broadcast rejected: ${upgradeReason}`)
      expect(calls).toEqual([{ networkId: zcash.networkId, serialized: serializedTx }])
    })
  }
}

test('other structured provider rejections surface without a Zcash-specific special case', async () => {
  const error = Object.assign(new Error('Bad Request'), { response: { obj: { error: { code: -26, message: 'bad-txns-inputs-missingorspent' } } } })
  await expect(broadcastTx({ Broadcast: async () => { throw error } }, zcash, { serializedTx })).rejects.toThrow('Broadcast rejected: bad-txns-inputs-missingorspent')
})

test('unstructured HTTP and transport failures keep a useful generic fallback', async () => {
  for (const error of [new Error('Request timed out'), Object.assign(new Error('Bad Request'), { response: { body: '<html>upstream unavailable</html>' } })]) {
    await expect(broadcastTx({ Broadcast: async () => { throw error } }, zcash, { serializedTx })).rejects.toThrow(error.message)
  }
  await expect(broadcastTx({ Broadcast: async () => { throw {} } }, zcash, { serializedTx })).rejects.toThrow('Broadcast failed: provider request failed')
})

test('successful provider response shapes remain accepted unchanged', async () => {
  const txid = 'a'.repeat(64)
  for (const data of [{ txid }, { tx_hash: txid }, { hash: txid }, txid]) {
    const calls: unknown[] = []
    await expect(broadcastTx({ Broadcast: async (params: unknown) => { calls.push(params); return { data } } }, zcash, { serializedTx })).resolves.toEqual({ txid })
    expect(calls).toEqual([{ networkId: zcash.networkId, serialized: serializedTx }])
  }
})

test('returned failure wrappers keep existing string errors and surface structured message fields', async () => {
  for (const error of ['transaction rejected', { error: 'transaction rejected' }, { code: 'utxo_error', message: upgradeReason }]) {
    const message = typeof error === 'string' ? error : 'message' in error ? upgradeReason : error.error
    await expect(broadcastTx({ Broadcast: async () => ({ data: { success: false, error } }) }, zcash, { serializedTx })).rejects.toMatchObject({ message: `Broadcast rejected: ${message}` })
  }
  await expect(broadcastTx({ Broadcast: async () => ({ data: { results: { raw: { tx_response: { code: 5, raw_log: 'insufficient funds' } } } } }) }, zcash, { serializedTx })).rejects.toThrow('Broadcast rejected: insufficient funds')
})

test('unrecognized bodies are not dumped into the message, and recognized messages are bounded', () => {
  expect(broadcastHttpRejectionReason({ response: { obj: {}, body: { error: { message: ' precise reason ' } } } })).toBe('precise reason')
  expect(broadcastHttpRejectionReason({ response: { obj: { serializedTx, request: 'do not display' } } })).toBeNull()
  expect(broadcastHttpRejectionReason({ response: { text: '<html>do not display</html>' } })).toBeNull()
  expect(broadcastRejectionReason({ error: { message: 'x'.repeat(2_500) } })).toHaveLength(2_000)
})
