/** The monero* RPCs the XMR asset page uses, behind one interface so the page can be rendered in tests. */
import { rpcRequest } from "./rpc"
import type { AppSettings, MoneroSendReview, MoneroStatus } from "../../shared/types"

export interface MoneroClient {
	getStatus(): Promise<MoneroStatus>
	getSettings(): Promise<Pick<AppSettings, "moneroDaemonUrl" | "moneroRestoreHeight">>
	suggestRestoreHeight(): Promise<{ tipHeight: number; restoreHeight: number; marginBlocks: number }>
	connect(restoreHeight?: number): Promise<MoneroStatus>
	getAddress(minor: number, showDisplay: boolean): Promise<{ address: string; network: "mainnet"; displayed: boolean; minor: number }>
	syncKeyImages(): Promise<MoneroStatus>
	prepareSend(params: { address: string; amountAtomic?: string; max?: boolean }): Promise<MoneroSendReview>
	send(prepareId: string): Promise<{ txid: string }>
	retryRelay(): Promise<{ txid: string }>
	discardPending(): Promise<{ outcome: "discarded" | "sent" | "superseded"; txid: string }>
}

const ATOMIC = /^(0|[1-9][0-9]*)$/
const ADDRESS = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/

/** The backend validates too; this keeps a malformed reply from ever rendering as a balance. */
export function checkedMoneroStatus(status: MoneroStatus): MoneroStatus {
	if (!status || typeof status.available !== "boolean" || status.network !== "mainnet") throw new Error("The Monero wallet status is unavailable.")
	if (!status.available) return status
	if (!ADDRESS.test(status.address) || typeof status.monitorReady !== "boolean" || !ATOMIC.test(status.balanceAtomic) || !ATOMIC.test(status.unlockedBalanceAtomic)
		|| BigInt(status.unlockedBalanceAtomic) > BigInt(status.balanceAtomic) || !Number.isSafeInteger(status.walletHeight) || status.walletHeight < 0) {
		throw new Error("The wallet returned an invalid balance or sync height.")
	}
	if (!Array.isArray(status.transactions) || status.transactions.some(tx => !tx || !/^[0-9a-f]{64}$/i.test(tx.txid) || !ATOMIC.test(tx.amountAtomic)
		|| !Number.isSafeInteger(tx.confirmations) || tx.confirmations < 0 || typeof tx.locked !== "boolean")) {
		throw new Error("The wallet returned an invalid transaction list.")
	}
	return status
}

export const rpcMoneroClient: MoneroClient = {
	getStatus: async () => checkedMoneroStatus(await rpcRequest<MoneroStatus>("moneroGetStatus", {}, 8000)),
	getSettings: () => rpcRequest<AppSettings>("getAppSettings", undefined, 5000),
	suggestRestoreHeight: () => rpcRequest("moneroSuggestRestoreHeight", {}, 20000),
	connect: async restoreHeight => checkedMoneroStatus(await rpcRequest<MoneroStatus>("moneroConnect", restoreHeight === undefined ? {} : { restoreHeight }, 180_000)),
	getAddress: (minor, showDisplay) => rpcRequest("moneroGetAddress", { showDisplay, minor }, showDisplay ? 180_000 : 60_000),
	syncKeyImages: async () => checkedMoneroStatus(await rpcRequest<MoneroStatus>("moneroSyncKeyImages", {}, 600_000)),
	prepareSend: params => rpcRequest<MoneroSendReview>("moneroPrepareSend", params, 300_000),
	send: prepareId => rpcRequest<{ txid: string }>("moneroSend", { prepareId }, 600_000),
	retryRelay: () => rpcRequest<{ txid: string }>("moneroRetryRelay", undefined, 120_000),
	discardPending: () => rpcRequest("moneroDiscardPending", { confirm: true }, 120_000),
}
