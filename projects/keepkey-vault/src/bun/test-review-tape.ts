/**
 * Test-only record of what a signing request showed: the Desktop approval
 * card's risk assessment, and each raw device frame held at a confirmation.
 * Filled only while a test driver has turned recording on through
 * POST /emulator/test-tape (emulator, KEEPKEY_TEST_EMULATOR_CONTROL=1).
 */
import type { SigningRequestInfo } from '../shared/types'
import { assessSigningRisk, type RiskAssessment } from '../shared/clearsign-risk'

export type ReviewTapeEntry =
  | { kind: 'card'; method: string; risk: RiskAssessment | null; needsBlindSigning: boolean; deviceClearSigns: boolean; protectionLevel?: string }
  /** frame: base64 of the 2048-byte SSD1306 buffer (8 pages x 256 columns). */
  | { kind: 'screen'; operation: string; frame: string }

let recording = false
let entries: ReviewTapeEntry[] = []

export const reviewTapeRecording = (): boolean => recording

export function recordReviewCard(info: SigningRequestInfo): void {
  if (!recording) return
  entries.push({
    kind: 'card', method: info.method, risk: assessSigningRisk(info),
    needsBlindSigning: !!info.needsBlindSigning, deviceClearSigns: !!info.deviceClearSigns,
    protectionLevel: info.clearSignReport?.protectionLevel,
  })
}

export function recordReviewScreen(operation: string, frame: Uint8Array | null): void {
  if (recording && frame) entries.push({ kind: 'screen', operation, frame: Buffer.from(frame).toString('base64') })
}

/** Hand over what was recorded, empty the tape, and set whether it keeps recording. */
export function takeReviewTape(record: boolean): ReviewTapeEntry[] {
  const taken = entries
  entries = []
  recording = record
  return taken
}
