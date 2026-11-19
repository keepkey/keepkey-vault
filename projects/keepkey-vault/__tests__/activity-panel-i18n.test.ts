import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

let result: any
beforeAll(async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/activity-panel-i18n.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 25000)
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code) throw new Error(err || out)
  result = JSON.parse(out.trim().split('\n').at(-1)!)
}, 30000)

const ENGLISH = ['Sent', 'Completed', 'Unconfirmed', 'On-chain scan', 'Block explorer', 'Output Detected', 'Confirmed', 'Message', 'Click to copy']

test('the transaction detail dialog is translated (audit v6 U6)', () => {
  for (const label of ['Enviado', 'Concluída', 'Não confirmada', 'Varredura on-chain', 'Explorador de blocos']) expect(result.detail.text).toContain(label)
  expect(result.detail.titles).toEqual(['Clique para copiar', 'Clique para copiar'])
})

test('activity rows translate type, swap status and confirmations', () => {
  expect(result.swapRow.text).toContain('Saída detectada')
  expect(result.swapRow.titles).toEqual(['Clique para copiar'])
  expect(result.confirmedRow.text).toContain('Recebido')
  expect(result.confirmedRow.text).toContain('Confirmada')
  expect(result.messageRow.text).toContain('Mensagem')
})

test('no English label is left in Portuguese', () => {
  for (const view of Object.values(result) as any[]) {
    for (const word of ENGLISH) {
      expect(view.text).not.toContain(word)
      expect(view.titles).not.toContain(word)
    }
  }
})
