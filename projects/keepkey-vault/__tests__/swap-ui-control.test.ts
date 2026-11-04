import { expect, test } from 'bun:test'
import { handleSwapRoute } from '../src/bun/rest-swap'
import { blocksSwapUiCommand } from '../src/shared/swap-ui-control'
const json = (data: unknown, status = 200) => Response.json(data, { status })
for (const phase of ['approving', 'signing', 'broadcasting', 'submitted']) {
  for (const command of ['open', 'set', 'requote', 'advance', 'confirm']) {
    test(`${phase}: REST ${command} cannot change an active operation or receipt`, async () => {
      const sent: any[] = []
      const response = await handleSwapRoute(`/api/v2/swap/${command}`, 'POST',
        new Request(`http://localhost/api/v2/swap/${command}`, { method: 'POST', body: JSON.stringify({ amount: '0.003' }) }),
        { requireAuth: () => ({}) } as any, json, {
          getSwapUiState: () => ({ state: { phase }, updatedAt: 1 }), sendSwapCmd: (cmd: any) => sent.push(cmd),
        } as any)
      expect(response?.status).toBe(409)
      expect(sent).toEqual([])
      expect(blocksSwapUiCommand(phase, command)).toBe(true)
    })
  }
  test(`${phase}: closing remains available`, () => {
    expect(blocksSwapUiCommand(phase, 'close')).toBe(false)
  })
}
test('input updates still work before review or signing', async () => {
  const sent: any[] = []
  const response = await handleSwapRoute('/api/v2/swap/set', 'POST',
    new Request('http://localhost/api/v2/swap/set', { method: 'POST', body: JSON.stringify({ amount: '0.003' }) }),
    { requireAuth: () => ({}) } as any, json, { getSwapUiState: () => ({ state: { phase: 'input' }, updatedAt: 1 }), sendSwapCmd: (cmd: any) => sent.push(cmd) } as any)
  expect(response?.status).toBe(200)
  expect(sent).toEqual([{ kind: 'set', amount: '0.003' }])
})
test('the busy response does not bypass authentication', async () => {
  await expect(handleSwapRoute('/api/v2/swap/set', 'POST', new Request('http://localhost/api/v2/swap/set'),
    { requireAuth: () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }) } } as any, json,
    { getSwapUiState: () => ({ state: { phase: 'signing' }, updatedAt: 1 }) } as any)).rejects.toMatchObject({ status: 401 })
})
