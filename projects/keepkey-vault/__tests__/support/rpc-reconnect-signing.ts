// Real rpc.ts + device-signing.ts over a scripted socket. No device, network or app.
const sockets: FakeSocket[] = []
class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  readyState = FakeSocket.CONNECTING
  sent: any[] = []
  listeners: Record<string, Array<{ fn: (e: any) => void; once?: boolean }>> = {}
  constructor() { sockets.push(this) }
  addEventListener(type: string, fn: (e: any) => void, opts?: { once?: boolean }) { (this.listeners[type] ??= []).push({ fn, once: opts?.once }) }
  emit(type: string, e: any = {}) {
    const list = this.listeners[type] ?? []
    this.listeners[type] = list.filter(l => !l.once)
    for (const l of list) l.fn(e)
  }
  send(json: string) { this.sent.push(JSON.parse(json)) }
  reply(id: number, body: object) { this.emit('message', { data: JSON.stringify({ type: 'response', id, ...body }) }) }
}
const g = globalThis as any
g.WebSocket = FakeSocket
g.window = g
g.__electrobunHostSocketPort = 1
g.__electrobunWebviewId = 1
const BUSY = 'KeepKey is busy with another request. Wait for it to finish, then try again.'
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const { signOnDevice, cancelDeviceSigning } = await import('../../src/mainview/lib/device-signing')
const socket = sockets[0]
const methods = () => socket.sent.map(p => p.method)
const result: Record<string, boolean> = {}

// H2: a sign request made while the socket is still connecting is sent once it opens.
const sign = signOnDevice('cosmosSignTx', { tx: 1 })
await tick()
socket.readyState = FakeSocket.OPEN; socket.emit('open')
await tick()
result.queuedUntilOpen = methods().includes('cosmosSignTx')
socket.reply(socket.sent.at(-1).id, { success: true, payload: 'signed' })
result.signResolved = (await sign) === 'signed'

// S5: busy-retry stops once the dialog is gone; no stray prompt later.
let open = true
socket.sent.length = 0
const busy = signOnDevice('cosmosSignTx', { tx: 2 }, () => open).catch(e => e)
await tick()
socket.reply(socket.sent.at(-1).id, { success: false, error: BUSY })
open = false
await tick(700)
result.stopsWhenClosed = (await busy) instanceof Error && methods().filter(m => m === 'cosmosSignTx').length === 1

// Cancel while waiting on someone else's busy operation ends the wait, never cancels theirs.
socket.sent.length = 0
const waiting = signOnDevice('cosmosSignTx', { tx: 3 }).catch(e => e)
await tick()
socket.reply(socket.sent.at(-1).id, { success: false, error: BUSY })
await tick()
await cancelDeviceSigning()
await tick(700)
result.cancelOnlyOwn = (await waiting) instanceof Error && !methods().includes('cancelForegroundDeviceOperation')
  && methods().filter(m => m === 'cosmosSignTx').length === 1
console.log(JSON.stringify(result))
process.exit(0)
