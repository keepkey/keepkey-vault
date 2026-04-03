/**
 * WalletConnect v2 — native wallet-side integration.
 *
 * Runs Web3Wallet in the Bun backend. Session proposals are auto-approved
 * (user explicitly paired via URI). Signing requests route through the
 * existing SigningApproval dialog (same flow as REST API signing).
 */
import { Core } from '@walletconnect/core'
import { Web3Wallet, type Web3WalletTypes } from '@walletconnect/web3wallet'
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils'
import { formatJsonRpcResult, formatJsonRpcError } from '@walletconnect/jsonrpc-utils'
import type { SessionTypes, SignClientTypes } from '@walletconnect/types'
import type { SigningRequestInfo } from '../shared/types'
import { evmAddressPath } from './evm-addresses'

const WC_PROJECT_ID = '14d36ca1bc76a70273d44d384e8475ae'
const WC_RELAY_URL = 'wss://relay.walletconnect.com'

// All EVM methods we can handle
const SUPPORTED_METHODS = [
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
]

const SUPPORTED_EVENTS = ['chainChanged', 'accountsChanged']

// EVM chains we support — same set as vault's EVM multi-chain support
const SUPPORTED_CHAINS = [
  'eip155:1',       // Ethereum
  'eip155:137',     // Polygon
  'eip155:42161',   // Arbitrum
  'eip155:10',      // Optimism
  'eip155:43114',   // Avalanche
  'eip155:56',      // BSC
  'eip155:8453',    // Base
  'eip155:100',     // Gnosis
]

export interface WcCallbacks {
  /** Get the current EVM address (checksummed). Null if device not ready. */
  getEvmAddress: () => string | null
  /** Sign an EVM transaction via the KeepKey device. */
  ethSignTx: (params: any) => Promise<any>
  /** Sign a message via the KeepKey device. */
  ethSignMessage: (params: any) => Promise<any>
  /** Sign typed data (EIP-712) via the KeepKey device. */
  ethSignTypedData: (params: any) => Promise<any>
  /** Show signing approval to user — returns true if approved. */
  requestSigningApproval: (info: SigningRequestInfo) => Promise<boolean>
  /** Dismiss the signing overlay. */
  dismissSigning: (id: string) => void
  /** Log to API audit log. */
  log: (msg: string) => void
  /** Notify frontend of session changes. */
  onSessionsChanged: (sessions: WcSessionInfo[]) => void
}

export interface WcSessionInfo {
  topic: string
  peerName: string
  peerUrl: string
  peerIcon: string
  chains: string[]
  expiry: number
}

function sessionToInfo(session: SessionTypes.Struct): WcSessionInfo {
  return {
    topic: session.topic,
    peerName: session.peer.metadata.name,
    peerUrl: session.peer.metadata.url,
    peerIcon: session.peer.metadata.icons?.[0] ?? '',
    chains: Object.values(session.namespaces).flatMap(ns => ns.chains ?? []),
    expiry: session.expiry,
  }
}

export class WalletConnectManager {
  private web3wallet: InstanceType<typeof Web3Wallet> | null = null
  private callbacks: WcCallbacks
  private initializing = false

  constructor(callbacks: WcCallbacks) {
    this.callbacks = callbacks
  }

  async init(): Promise<void> {
    if (this.web3wallet || this.initializing) return
    this.initializing = true
    try {
      const core = new Core({
        projectId: WC_PROJECT_ID,
        relayUrl: WC_RELAY_URL,
      })
      this.web3wallet = await Web3Wallet.init({
        core,
        metadata: {
          name: 'KeepKey Vault',
          description: 'KeepKey hardware wallet',
          url: 'https://keepkey.com',
          icons: ['https://keepkey.com/favicon.ico'],
        },
      })
      this.setupListeners()
      this.callbacks.log('[WC] Initialized')
    } catch (e: any) {
      this.callbacks.log(`[WC] Init failed: ${e.message}`)
      throw e
    } finally {
      this.initializing = false
    }
  }

  async pair(uri: string): Promise<void> {
    if (!this.web3wallet) await this.init()
    this.callbacks.log(`[WC] Pairing with URI`)
    await this.web3wallet!.pair({ uri })
  }

  getSessions(): WcSessionInfo[] {
    if (!this.web3wallet) return []
    const sessions = this.web3wallet.getActiveSessions()
    return Object.values(sessions).map(sessionToInfo)
  }

  async disconnectSession(topic: string): Promise<void> {
    if (!this.web3wallet) return
    await this.web3wallet.disconnectSession({
      topic,
      reason: getSdkError('USER_DISCONNECTED'),
    })
    this.callbacks.onSessionsChanged(this.getSessions())
  }

  async destroy(): Promise<void> {
    if (!this.web3wallet) return
    // Disconnect all sessions gracefully
    const sessions = this.web3wallet.getActiveSessions()
    for (const session of Object.values(sessions)) {
      try {
        await this.web3wallet.disconnectSession({
          topic: session.topic,
          reason: getSdkError('USER_DISCONNECTED'),
        })
      } catch { /* best effort */ }
    }
    this.web3wallet = null
  }

  // ── Event listeners ─────────────────────────────────────────────

  private setupListeners() {
    const w = this.web3wallet!
    w.on('session_proposal', this.onSessionProposal)
    w.on('session_request', this.onSessionRequest)
    w.on('session_delete', () => {
      this.callbacks.onSessionsChanged(this.getSessions())
    })
  }

  /**
   * Auto-approve session proposals.
   * The user explicitly initiated pairing (entered URI or deep link),
   * so we approve with the vault's EVM address on all requested chains.
   */
  private onSessionProposal = async (
    proposal: Web3WalletTypes.SessionProposal
  ) => {
    const address = this.callbacks.getEvmAddress()
    if (!address) {
      this.callbacks.log('[WC] Rejecting proposal — no device connected')
      await this.web3wallet!.rejectSession({
        id: proposal.id,
        reason: getSdkError('USER_REJECTED'),
      })
      return
    }

    try {
      // Build accounts list: address on every supported + requested chain
      const requestedChains = [
        ...(proposal.params.requiredNamespaces?.eip155?.chains ?? []),
        ...(proposal.params.optionalNamespaces?.eip155?.chains ?? []),
      ]
      const allChains = [...new Set([...SUPPORTED_CHAINS, ...requestedChains])]
      const accounts = allChains.map(chain => `${chain}:${address}`)

      const namespaces = buildApprovedNamespaces({
        proposal: proposal.params,
        supportedNamespaces: {
          eip155: {
            chains: allChains,
            methods: SUPPORTED_METHODS,
            events: SUPPORTED_EVENTS,
            accounts,
          },
        },
      })

      await this.web3wallet!.approveSession({
        id: proposal.id,
        namespaces,
      })

      this.callbacks.log(`[WC] Session approved: ${proposal.params.proposer.metadata.name}`)
      this.callbacks.onSessionsChanged(this.getSessions())
    } catch (e: any) {
      this.callbacks.log(`[WC] Failed to approve session: ${e.message}`)
      try {
        await this.web3wallet!.rejectSession({
          id: proposal.id,
          reason: getSdkError('USER_REJECTED'),
        })
      } catch { /* best effort */ }
    }
  }

  /**
   * Handle signing requests from connected dApps.
   * Routes through the same approval gate as REST API signing.
   */
  private onSessionRequest = async (
    event: SignClientTypes.EventArguments['session_request']
  ) => {
    const { topic, params, id } = event
    const { request, chainId } = params
    const { method } = request

    // Resolve session peer name for the approval dialog
    const sessions = this.web3wallet!.getActiveSessions()
    const session = sessions[topic]
    const appName = session?.peer.metadata.name ?? 'Unknown dApp'

    this.callbacks.log(`[WC] Request: ${method} from ${appName}`)

    try {
      const result = await this.handleRequest(method, request.params, chainId, appName)
      await this.web3wallet!.respondSessionRequest({
        topic,
        response: formatJsonRpcResult(id, result),
      })
    } catch (e: any) {
      this.callbacks.log(`[WC] Request failed: ${e.message}`)
      const code = e.message?.includes('rejected') ? 4001 : 5000
      await this.web3wallet!.respondSessionRequest({
        topic,
        response: formatJsonRpcError(id, { code, message: e.message }),
      })
    }
  }

  // ── Request routing ─────────────────────────────────────────────

  private async handleRequest(
    method: string,
    params: any[],
    chainId: string,
    appName: string,
  ): Promise<any> {
    const address = this.callbacks.getEvmAddress()
    if (!address) throw new Error('No device connected')

    const chainIdNum = parseInt(chainId.split(':')[1], 10)
    const addressNList = evmAddressPath(0)

    switch (method) {
      case 'personal_sign':
      case 'eth_sign': {
        // personal_sign: [message, address], eth_sign: [address, message]
        const message = method === 'personal_sign' ? params[0] : params[1]
        return this.signMessage(message, addressNList, appName, chainIdNum)
      }

      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJSON]
        const typedData = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
        return this.signTypedData(typedData, addressNList, appName, chainIdNum)
      }

      case 'eth_sendTransaction':
      case 'eth_signTransaction': {
        const tx = params[0]
        return this.signTransaction(tx, addressNList, appName, chainIdNum, method === 'eth_sendTransaction')
      }

      default:
        throw new Error(`Unsupported method: ${method}`)
    }
  }

  // ── Signing implementations ─────────────────────────────────────

  private async signMessage(
    message: string,
    addressNList: number[],
    appName: string,
    chainId: number,
  ): Promise<string> {
    const signingId = crypto.randomUUID()

    const signingInfo: SigningRequestInfo = {
      id: signingId,
      method: '/eth/sign',
      appName,
      chain: 'eth',
      from: this.callbacks.getEvmAddress() ?? undefined,
      data: message,
      chainId,
    }

    const approved = await this.callbacks.requestSigningApproval(signingInfo)
    if (!approved) throw new Error('User rejected signing')

    try {
      // Convert hex message to UTF-8 bytes for display, pass as-is for signing
      const msgBytes = message.startsWith('0x')
        ? Buffer.from(message.slice(2), 'hex')
        : Buffer.from(message)

      const result = await this.callbacks.ethSignMessage({
        addressNList,
        message: msgBytes,
      })

      return result?.signature ?? result
    } finally {
      this.callbacks.dismissSigning(signingId)
    }
  }

  private async signTypedData(
    typedData: any,
    addressNList: number[],
    appName: string,
    chainId: number,
  ): Promise<string> {
    const signingId = crypto.randomUUID()

    const signingInfo: SigningRequestInfo = {
      id: signingId,
      method: '/eth/sign-typed-data',
      appName,
      chain: 'eth',
      from: this.callbacks.getEvmAddress() ?? undefined,
      chainId: typedData.domain?.chainId ? Number(typedData.domain.chainId) : chainId,
    }

    const approved = await this.callbacks.requestSigningApproval(signingInfo)
    if (!approved) throw new Error('User rejected signing')

    try {
      const result = await this.callbacks.ethSignTypedData({
        addressNList,
        typedData,
      })

      return result?.signature ?? result
    } finally {
      this.callbacks.dismissSigning(signingId)
    }
  }

  private async signTransaction(
    tx: any,
    addressNList: number[],
    appName: string,
    chainId: number,
    broadcast: boolean,
  ): Promise<string> {
    const signingId = crypto.randomUUID()

    const signingInfo: SigningRequestInfo = {
      id: signingId,
      method: '/eth/sign-transaction',
      appName,
      chain: 'eth',
      from: tx.from ?? this.callbacks.getEvmAddress() ?? undefined,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      chainId: tx.chainId ? parseInt(tx.chainId, 16) : chainId,
    }

    const approved = await this.callbacks.requestSigningApproval(signingInfo)
    if (!approved) throw new Error('User rejected signing')

    try {
      // Build the ethSignTx message matching hdwallet format
      const msg: any = {
        addressNList,
        to: tx.to,
        value: tx.value ?? '0x0',
        data: tx.data ?? '',
        chainId: tx.chainId ? parseInt(tx.chainId, 16) : chainId,
        nonce: tx.nonce ?? '0x0',
        gasLimit: tx.gas ?? tx.gasLimit ?? '0x5208',
      }

      // EIP-1559 vs legacy gas
      if (tx.maxFeePerGas) {
        msg.maxFeePerGas = tx.maxFeePerGas
        msg.maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? '0x0'
      } else {
        msg.gasPrice = tx.gasPrice ?? '0x0'
      }

      const result = await this.callbacks.ethSignTx(msg)
      if (!result?.serialized && !result?.r) {
        throw new Error('Device signing failed')
      }

      const serialized = result.serialized
        ?? `0x${result.r}${result.s.slice(2)}${result.v.toString(16)}`

      if (broadcast) {
        // Broadcast via public RPC
        const rpcUrl = this.getChainRpcUrl(msg.chainId)
        const resp = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_sendRawTransaction',
            params: [serialized],
          }),
        })
        const json = await resp.json() as any
        if (json.error) throw new Error(json.error.message)
        return json.result // txHash
      }

      return serialized
    } finally {
      this.callbacks.dismissSigning(signingId)
    }
  }

  private getChainRpcUrl(chainId: number): string {
    const rpcs: Record<number, string> = {
      1: 'https://eth.llamarpc.com',
      137: 'https://polygon-rpc.com',
      42161: 'https://arb1.arbitrum.io/rpc',
      10: 'https://mainnet.optimism.io',
      43114: 'https://api.avax.network/ext/bc/C/rpc',
      56: 'https://bsc-dataseed.binance.org',
      8453: 'https://mainnet.base.org',
      100: 'https://rpc.gnosischain.com',
    }
    return rpcs[chainId] ?? rpcs[1]
  }
}
