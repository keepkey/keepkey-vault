/** Read-only frame access is bound to the exact signing request and wallet
 * session. It reads captured memory and never sends a protocol request. */
export class SigningReviewSessions {
  private sessions = new Map<string, { deviceId: string; epoch: number }>()
  begin(id: string, deviceId: string | undefined, epoch: number, emulator: boolean) {
    for (const [key, session] of this.sessions) if (session.epoch !== epoch) this.sessions.delete(key)
    if (emulator && deviceId) this.sessions.set(id, { deviceId, epoch })
  }
  end(id: string) { this.sessions.delete(id) }
  read<T>(id: string, deviceId: string, epoch: number, emulator: boolean, capture: () => T): T | null {
    const session = this.sessions.get(id)
    return this.sessions.size === 1 && emulator && session?.deviceId === deviceId && session.epoch === epoch ? capture() : null
  }
}
