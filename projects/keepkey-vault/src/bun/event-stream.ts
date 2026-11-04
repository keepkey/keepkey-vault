/** One SSE lease for the active wallet addresses or account public keys.
 * Stops on wallet/provider change; reconnects with a cursor only while the
 * same watch set remains active. UTXO account watches may include xpubs. */
import { getPioneerApiBase, getQueryKey } from './pioneer'
import { createEventStreamClient } from '../shared/event-stream-client'

export type { AddressEntry, StreamEvent, TxIncomingEvent, StreamSessionOptions } from '../shared/event-stream-client'

const client = createEventStreamClient({ getBase: getPioneerApiBase, getQueryKey })
export const startEventStream = client.start
export const stopEventStream = client.stop
