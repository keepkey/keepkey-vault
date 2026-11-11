/** A slow backend is not a failed one: retry only timeouts, with longer budgets each time. */
export const isRpcTimeout = (error: unknown): boolean =>
	error instanceof Error && error.message.startsWith('RPC request timed out')

export async function retryOnTimeout<T>(
	call: (timeoutMs: number) => Promise<T>,
	timeoutsMs: number[] = [5000, 10000, 20000],
	onSlow?: (attempt: number) => void,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try { return await call(timeoutsMs[attempt]) }
		catch (error) {
			if (!isRpcTimeout(error) || attempt >= timeoutsMs.length - 1) throw error
			onSlow?.(attempt + 1)
		}
	}
}
