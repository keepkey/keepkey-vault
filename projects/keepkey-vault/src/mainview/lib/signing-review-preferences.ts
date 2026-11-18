import { useEffect, useState } from 'react'
import { DEFAULT_SIGNING_REVIEW, signingReviewPreferences, type SigningReviewPreferences } from '../../shared/signing-review-guide'

const KEY = 'keepkey.signing-review.v1'
const CHANGED = 'keepkey-signing-review-changed'
function read(): SigningReviewPreferences {
  try { return signingReviewPreferences(JSON.parse(window.localStorage.getItem(KEY) || 'null')) }
  catch { return { ...DEFAULT_SIGNING_REVIEW } }
}
/** Non-secret display preferences only; no request payload is persisted. */
export function useSigningReviewPreferences() {
  const [preferences, setPreferences] = useState(read)
  useEffect(() => {
    const local = (event: Event) => setPreferences(signingReviewPreferences((event as CustomEvent).detail))
    const storage = () => setPreferences(read())
    window.addEventListener(CHANGED, local); window.addEventListener('storage', storage)
    return () => { window.removeEventListener(CHANGED, local); window.removeEventListener('storage', storage) }
  }, [])
  const update = (patch: Partial<SigningReviewPreferences>) => {
    const next = signingReviewPreferences({ ...preferences, ...patch })
    setPreferences(next)
    try { window.localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private windows keep the preference for this view */ }
    window.dispatchEvent(new window.CustomEvent(CHANGED, { detail: next }))
  }
  return [preferences, update] as const
}
