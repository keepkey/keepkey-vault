/** Minimal Socket.IO v4 client over Bun native WebSocket. Authentication and
 * callbacks are bound to the current connection; stale sockets are inert. */
import { getPioneerApiBase } from './pioneer'
import { PioneerSocketClient, type PioneerSocketOptions } from '../shared/pioneer-socket-client'

export type { PioneerSocketOptions } from '../shared/pioneer-socket-client'
export class PioneerSocket extends PioneerSocketClient {
  constructor(options: PioneerSocketOptions) {
    super(options, { getBase: getPioneerApiBase })
  }
}
