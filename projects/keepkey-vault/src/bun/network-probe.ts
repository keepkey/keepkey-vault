export interface NetworkProbe { online: boolean; durationMs: number; checkedAt: number; status?: number; reason?: string }
/** Cloudflare handles this at the edge, avoiding the container, DB and paid
 * providers. On other servers, any HTTP answer still proves reachability. */
export async function probeNetworkReachability(apiBase: string, fetcher: typeof fetch = fetch): Promise<NetworkProbe> {
  const endpoint = new URL('/cdn-cgi/trace', apiBase).href
  const startedAt = Date.now()
  try {
    const response = await fetcher(endpoint, {method:'HEAD',signal:AbortSignal.timeout(8000)})
    return {online:true,status:response.status,durationMs:Date.now()-startedAt,checkedAt:Date.now()}
  } catch (error) {
    return {online:false,reason:error instanceof Error?error.name:'network',durationMs:Date.now()-startedAt,checkedAt:Date.now()}
  }
}
