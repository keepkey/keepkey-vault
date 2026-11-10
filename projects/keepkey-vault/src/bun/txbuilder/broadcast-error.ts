/** Extract a provider's rejection message without displaying its full HTTP body. */
export function broadcastRejectionReason(value: unknown): string | null {
  let body: any = value
  if (typeof body === 'string') {
    if (body.length > 64_000) return null
    try { body = JSON.parse(body) } catch { return null }
  }
  if (!body || typeof body !== 'object') return null
  for (const message of [body.error?.message, body.error?.error, body.error, body.message]) {
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 2_000)
  }
  return null
}

/** Swagger clients expose parsed HTTP error bodies under different properties. */
export function broadcastHttpRejectionReason(error: any): string | null {
  for (const body of [error?.response?.obj, error?.response?.body, error?.response?.data, error?.responseError, error?.response?.text]) {
    const reason = broadcastRejectionReason(body)
    if (reason) return reason
  }
  return null
}
