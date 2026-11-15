import { beforeAll, describe, expect, test } from 'bun:test'

// Electrobun 2.x on Windows never answers on the socket: Bun calls
// window.__electrobun.receiveMessageFromHost(packet) in the page, and the
// preload queues replies in __electrobunPendingHostMessages until a receiver
// exists. The 1.7.0 Windows build ignored that path and every RPC timed out.

const sent: any[] = []

class FakeSocket {
	static OPEN = 1
	readyState = 1
	url: string
	constructor(url: string) { this.url = url; sockets.push(this) }
	addEventListener() {}
	send(data: string) { sent.push(JSON.parse(data)) }
}
const sockets: FakeSocket[] = []

const w: any = {
	__electrobunHostSocketPort: 50000,
	__electrobunWebviewId: 1,
	__electrobun: {},
	// A reply that arrived before rpc.ts loaded, and a push message.
	__electrobunPendingHostMessages: [{ type: 'message', id: 'early', payload: 1 }],
}

let rpc: typeof import('./rpc')

beforeAll(async () => {
	;(globalThis as any).window = w
	;(globalThis as any).WebSocket = FakeSocket
	rpc = await import('./rpc')
})

describe('rpc over the Electrobun 2.x host bridge', () => {
	test('connects to 127.0.0.1 on the host socket port', () => {
		expect(sockets[0].url).toBe('ws://127.0.0.1:50000/socket?webviewId=1')
	})

	test('registers both host receivers and drains the queue', () => {
		expect(typeof w.__electrobun.receiveMessageFromHost).toBe('function')
		expect(w.__electrobun.receiveMessageFromBun).toBe(w.__electrobun.receiveMessageFromHost)
		expect(w.__electrobunPendingHostMessages).toEqual([])
	})

	test('a request sent on the socket resolves from receiveMessageFromHost', async () => {
		const reply = rpc.rpcRequest<string[]>('getRegisteredDevices', undefined, 1000)
		await Promise.resolve()
		const request = sent.find(p => p.method === 'getRegisteredDevices')
		expect(request?.type).toBe('request')
		w.__electrobun.receiveMessageFromHost({ type: 'response', id: request.id, success: true, payload: ['kk'] })
		expect(await reply).toEqual(['kk'])
	})

	test('a reply delivered as a JSON string also resolves', async () => {
		const reply = rpc.rpcRequest<number>('getAppVersion', undefined, 1000)
		await Promise.resolve()
		const request = sent.find(p => p.method === 'getAppVersion')
		w.__electrobun.receiveMessageFromHost(JSON.stringify({ type: 'response', id: request.id, success: true, payload: 7 }))
		expect(await reply).toBe(7)
	})
})
