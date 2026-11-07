import type { MoneroClient } from "./monero-client"
import type { MoneroStatus } from "../../shared/types"

// Receive/Send and React effect replays can share a device consent already in flight.
// Only the in-flight operation is shared: cancellation is never retried automatically.
const opening = new WeakMap<MoneroClient, Promise<MoneroStatus>>()
export function openMoneroWallet(client: MoneroClient, restoreHeight: number): Promise<MoneroStatus> {
	const active = opening.get(client)
	if (active) return active
	const request = client.connect(restoreHeight)
	opening.set(client, request)
	void request.finally(() => { if (opening.get(client) === request) opening.delete(client) }).catch(() => {})
	return request
}

const verifying = new WeakMap<MoneroClient, Promise<MoneroStatus>>()
export function verifyMoneroBalance(client: MoneroClient): Promise<MoneroStatus> {
	const active = verifying.get(client)
	if (active) return active
	const request = client.syncKeyImages()
	verifying.set(client, request)
	void request.finally(() => { if (verifying.get(client) === request) verifying.delete(client) }).catch(() => {})
	return request
}

/** Routine balance verification belongs to Review send; signing remains a separate approval. */
export async function prepareMoneroSend(client: MoneroClient, wallet: MoneroStatus,
	params: Parameters<MoneroClient['prepareSend']>[0], applyStatus: (status: MoneroStatus) => void, onVerify: () => void) {
	if (wallet.unrelayedTxid) throw new Error('Your previous transaction is still being checked. Wait before sending again.')
	if (wallet.sendBlocked === 'key-images' || !wallet.keyImagesSynced || wallet.keyImagesStale) {
		onVerify()
		const verified = await verifyMoneroBalance(client)
		if (!verified.available || verified.address !== wallet.address) throw new Error('The wallet changed. Review this send again.')
		applyStatus(verified)
		if (!verified.canSend || verified.unrelayedTxid) throw new Error('The wallet is not ready to send yet. Wait for it to finish syncing.')
	}
	return client.prepareSend(params)
}
