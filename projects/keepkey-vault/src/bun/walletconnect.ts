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
import bs58 from 'bs58'
import type { SigningRequestInfo, WcSessionInfo } from '../shared/types'
import { evmAddressPath } from './evm-addresses'

function base64ToBase58(base64: string): string {
  return bs58.encode(Buffer.from(base64, 'base64'))
}

const WC_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID || '14d36ca1bc76a70273d44d384e8475ae'
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

// EVM chains we support — keyed by chainId for RPC lookup
const CHAIN_RPC: Record<number, string> = {
  1: 'https://eth.llamarpc.com',
  137: 'https://polygon-rpc.com',
  42161: 'https://arb1.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io',
  43114: 'https://api.avax.network/ext/bc/C/rpc',
  56: 'https://bsc-dataseed.binance.org',
  8453: 'https://mainnet.base.org',
  100: 'https://rpc.gnosischain.com',
}

const SUPPORTED_CHAIN_IDS = new Set(Object.keys(CHAIN_RPC).map(Number))
const SUPPORTED_EVM_CHAINS = Object.keys(CHAIN_RPC).map(id => `eip155:${id}`)

// Cosmos namespace: amino-format signing only for now. signDirect requires
// proto decoding (cosmjs/proto-signing); deferred to a follow-up.
const SUPPORTED_COSMOS_METHODS = ['cosmos_getAccounts', 'cosmos_signAmino', 'cosmos_signDirect']
const SUPPORTED_COSMOS_EVENTS: string[] = []
// Only cosmoshub-4 in v1 — Osmosis/THOR/Maya use cosmos namespace too but have
// different bech32 prefixes and (in THOR/Maya's case) different hdwallet
// signers, so they need per-chain wiring.
const SUPPORTED_COSMOS_CHAINS = ['cosmos:cosmoshub-4']

// Solana namespace. Same shape as EVM: sign-only and sign+broadcast both supported.
const SUPPORTED_SOLANA_METHODS = ['solana_signMessage', 'solana_signTransaction', 'solana_signAndSendTransaction']
const SUPPORTED_SOLANA_EVENTS: string[] = []
// CAIP-2 mainnet genesis hash. Some dApps use other CAIPs; iterate as needed.
const SUPPORTED_SOLANA_CHAINS = ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']

/** Information shown to the user when a session pair is proposed. */
export interface WcPairApprovalInfo {
  id: string
  peerName: string
  peerUrl: string
  peerIcon: string
  chains: string[]
  methods: string[]
}

export interface WcCallbacks {
  /** Get the current EVM address (checksummed) and its derivation index. Null if not ready. */
  getEvmAddressInfo: () => { address: string; addressIndex: number } | null
  /** Sign an EVM transaction via the KeepKey device. */
  ethSignTx: (params: any) => Promise<any>
  /** Sign a message via the KeepKey device. */
  ethSignMessage: (params: any) => Promise<any>
  /** Sign typed data (EIP-712) via the KeepKey device. */
  ethSignTypedData: (params: any) => Promise<any>
  /** Get the cosmos account info for a given CAIP chain id. Null if not ready. */
  getCosmosAccountInfo: (caipChain: string) => Promise<{ address: string; pubkeyBase64: string; addressNList: number[] } | null>
  /** Sign an amino-format Cosmos StdSignDoc via the device. Returns base64 signature. */
  cosmosSignAmino: (params: { addressNList: number[]; signDoc: any }) => Promise<{ signatureBase64: string }>
  /** Get the solana account (bs58-encoded ed25519 pubkey = address) for a CAIP chain. Null if not ready. */
  getSolanaAccountInfo: (caipChain: string) => Promise<{ address: string; addressNList: number[] } | null>
  /** Sign a Solana message (raw bytes). Returns 64-byte ed25519 signature. */
  solanaSignMessageRaw: (params: { addressNList: number[]; messageBase64: string }) => Promise<{ signatureBase64: string }>
  /** Sign a Solana transaction (full base64 tx including empty sig slots). Returns assembled signed tx + signature. */
  solanaSignTransactionRaw: (params: { addressNList: number[]; transactionBase64: string }) => Promise<{ transactionBase64: string; signatureBase64: string }>
  /** Broadcast a fully-signed serialized transaction via Pioneer. Returns the on-chain txid. */
  broadcastViaPioneer: (params: { networkId: string; serialized: string }) => Promise<string>
  /** Show signing approval to user — returns true if approved. */
  requestSigningApproval: (info: SigningRequestInfo) => Promise<boolean>
  /** Dismiss the signing overlay. */
  dismissSigning: (id: string) => void
  /** Log to API audit log. */
  log: (msg: string) => void
  /** Notify frontend of session changes. */
  onSessionsChanged: (sessions: WcSessionInfo[]) => void
  /** Surface a pending pair proposal to the user. */
  onPairApprovalRequest: (info: WcPairApprovalInfo) => void
  /** Tell frontend the proposal is no longer pending (approved/rejected/timed out). */
  onPairApprovalDismiss: (id: string) => void
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
  private initPromise: Promise<void> | null = null
  private pendingPairApprovals = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(callbacks: WcCallbacks) {
    this.callbacks = callbacks
  }

  /** Wait for the user to approve/reject a pending pair proposal. */
  private requestPairApproval(info: WcPairApprovalInfo, timeoutMs = 120_000): Promise<boolean> {
    if (this.pendingPairApprovals.size >= 10) return Promise.resolve(false) // sanity cap
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPairApprovals.delete(info.id)
        this.callbacks.onPairApprovalDismiss(info.id)
        resolve(false)
      }, timeoutMs)
      this.pendingPairApprovals.set(info.id, { resolve, timer })
      this.callbacks.onPairApprovalRequest(info)
    })
  }

  /** Frontend → backend: user clicked Approve in the pair-approval modal. */
  approvePair(id: string): boolean {
    const entry = this.pendingPairApprovals.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pendingPairApprovals.delete(id)
    this.callbacks.onPairApprovalDismiss(id)
    entry.resolve(true)
    return true
  }

  /** Frontend → backend: user clicked Reject in the pair-approval modal. */
  rejectPair(id: string): boolean {
    const entry = this.pendingPairApprovals.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pendingPairApprovals.delete(id)
    this.callbacks.onPairApprovalDismiss(id)
    entry.resolve(false)
    return true
  }

  async init(): Promise<void> {
    if (this.web3wallet) return
    // Coalesce concurrent init calls — second caller awaits the same promise
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async _doInit(): Promise<void> {
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
  }

  async pair(uri: string): Promise<void> {
    await this.init()
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
   * so we approve with the vault's address on SUPPORTED chains only.
   * Advertises both eip155 (EVM) and cosmos namespaces.
   */
  private onSessionProposal = async (
    proposal: Web3WalletTypes.SessionProposal
  ) => {
    const evmInfo = this.callbacks.getEvmAddressInfo()
    if (!evmInfo) {
      this.callbacks.log('[WC] Rejecting proposal — no EVM address ready')
      await this.web3wallet!.rejectSession({
        id: proposal.id,
        reason: getSdkError('USER_REJECTED'),
      })
      return
    }

    // Resolve cosmos accounts for any cosmos chains the dApp asked for that
    // we know how to sign for. Failures are non-fatal — cosmos namespace is
    // dropped from the approval so the proposal can still succeed for EVM.
    const cosmosAccounts: string[] = []
    const cosmosChainsAdvertised: string[] = []
    for (const chain of SUPPORTED_COSMOS_CHAINS) {
      try {
        const info = await this.callbacks.getCosmosAccountInfo(chain)
        if (info) {
          cosmosAccounts.push(`${chain}:${info.address}`)
          cosmosChainsAdvertised.push(chain)
        }
      } catch (e: any) {
        this.callbacks.log(`[WC] Cosmos account fetch failed for ${chain}: ${e.message}`)
      }
    }

    const solanaAccounts: string[] = []
    const solanaChainsAdvertised: string[] = []
    for (const chain of SUPPORTED_SOLANA_CHAINS) {
      try {
        const info = await this.callbacks.getSolanaAccountInfo(chain)
        if (info) {
          solanaAccounts.push(`${chain}:${info.address}`)
          solanaChainsAdvertised.push(chain)
        }
      } catch (e: any) {
        this.callbacks.log(`[WC] Solana account fetch failed for ${chain}: ${e.message}`)
      }
    }

    // Ask the user to approve the pair before establishing the session.
    const meta = proposal.params.proposer.metadata
    const proposedChains = Object.values(proposal.params.requiredNamespaces ?? {})
      .flatMap(ns => ns.chains ?? [])
      .concat(Object.values(proposal.params.optionalNamespaces ?? {}).flatMap(ns => ns.chains ?? []))
    const proposedMethods = Object.values(proposal.params.requiredNamespaces ?? {})
      .flatMap(ns => ns.methods ?? [])
    const approved = await this.requestPairApproval({
      id: String(proposal.id),
      peerName: meta.name ?? 'Unknown dApp',
      peerUrl: meta.url ?? '',
      peerIcon: meta.icons?.[0] ?? '',
      chains: Array.from(new Set(proposedChains)),
      methods: Array.from(new Set(proposedMethods)),
    })
    if (!approved) {
      this.callbacks.log(`[WC] User rejected pair: ${meta.name}`)
      try {
        await this.web3wallet!.rejectSession({
          id: proposal.id,
          reason: getSdkError('USER_REJECTED'),
        })
      } catch { /* best effort */ }
      return
    }

    try {
      const evmAccounts = SUPPORTED_EVM_CHAINS.map(c => `${c}:${evmInfo.address}`)

      const supportedNamespaces: Parameters<typeof buildApprovedNamespaces>[0]['supportedNamespaces'] = {
        eip155: {
          chains: SUPPORTED_EVM_CHAINS,
          methods: SUPPORTED_METHODS,
          events: SUPPORTED_EVENTS,
          accounts: evmAccounts,
        },
      }
      if (cosmosChainsAdvertised.length > 0) {
        supportedNamespaces.cosmos = {
          chains: cosmosChainsAdvertised,
          methods: SUPPORTED_COSMOS_METHODS,
          events: SUPPORTED_COSMOS_EVENTS,
          accounts: cosmosAccounts,
        }
      }
      if (solanaChainsAdvertised.length > 0) {
        supportedNamespaces.solana = {
          chains: solanaChainsAdvertised,
          methods: SUPPORTED_SOLANA_METHODS,
          events: SUPPORTED_SOLANA_EVENTS,
          accounts: solanaAccounts,
        }
      }

      const namespaces = buildApprovedNamespaces({
        proposal: proposal.params,
        supportedNamespaces,
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
    params: any,
    chainId: string,
    appName: string,
  ): Promise<any> {
    // Cosmos namespace
    if (chainId.startsWith('cosmos:')) {
      return this.handleCosmosRequest(method, params, chainId, appName)
    }
    // Solana namespace
    if (chainId.startsWith('solana:')) {
      return this.handleSolanaRequest(method, params, chainId, appName)
    }

    // EVM namespace
    const info = this.callbacks.getEvmAddressInfo()
    if (!info) throw new Error('No device connected')

    const chainIdNum = parseInt(chainId.split(':')[1], 10)
    if (!SUPPORTED_CHAIN_IDS.has(chainIdNum)) {
      throw new Error(`Unsupported chain: ${chainId}`)
    }

    const addressNList = evmAddressPath(info.addressIndex)
    const evmParams = params as any[]

    switch (method) {
      case 'personal_sign':
      case 'eth_sign': {
        // personal_sign: [message, address], eth_sign: [address, message]
        const message = method === 'personal_sign' ? evmParams[0] : evmParams[1]
        return this.signMessage(message, addressNList, appName, chainIdNum)
      }

      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJSON]
        const typedData = typeof evmParams[1] === 'string' ? JSON.parse(evmParams[1]) : evmParams[1]
        return this.signTypedData(typedData, addressNList, appName, chainIdNum)
      }

      case 'eth_sendTransaction':
      case 'eth_signTransaction': {
        const tx = evmParams[0]
        return this.signTransaction(tx, addressNList, appName, chainIdNum, method === 'eth_sendTransaction')
      }

      default:
        throw new Error(`Unsupported method: ${method}`)
    }
  }

  private async handleCosmosRequest(
    method: string,
    params: any,
    chainId: string,
    appName: string,
  ): Promise<any> {
    if (!SUPPORTED_COSMOS_CHAINS.includes(chainId)) {
      throw new Error(`Unsupported cosmos chain: ${chainId}`)
    }
    const account = await this.callbacks.getCosmosAccountInfo(chainId)
    if (!account) throw new Error('Cosmos account not available')

    switch (method) {
      case 'cosmos_getAccounts': {
        return [{
          address: account.address,
          algo: 'secp256k1',
          pubkey: account.pubkeyBase64,
        }]
      }

      case 'cosmos_signAmino': {
        // WC params: { signerAddress, signDoc }
        // signDoc is the legacy StdSignDoc: { chain_id, account_number, sequence, fee, msgs, memo }
        const { signerAddress, signDoc } = params as { signerAddress: string; signDoc: any }
        if (signerAddress && signerAddress.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error(`Signer address mismatch: dApp asked ${signerAddress}, wallet is ${account.address}`)
        }
        const signingId = crypto.randomUUID()
        const signingInfo: SigningRequestInfo = {
          id: signingId,
          method: '/cosmos/sign-amino',
          appName,
          chain: 'cosmos',
          from: account.address,
          chainId: 0, // not an EVM numeric id
          data: JSON.stringify(signDoc),
        }
        const approved = await this.callbacks.requestSigningApproval(signingInfo)
        if (!approved) throw new Error('User rejected signing')
        try {
          const { signatureBase64 } = await this.callbacks.cosmosSignAmino({
            addressNList: account.addressNList,
            signDoc,
          })
          return {
            signed: signDoc,
            signature: {
              pub_key: { type: 'tendermint/PubKeySecp256k1', value: account.pubkeyBase64 },
              signature: signatureBase64,
            },
          }
        } finally {
          this.callbacks.dismissSigning(signingId)
        }
      }

      case 'cosmos_signDirect': {
        // SignDoc is proto-encoded — would need cosmjs/proto-signing or a hand-rolled
        // protobuf decoder. Deferred. Most cosmos dApps fall back to amino if signDirect
        // is unavailable on the wallet side.
        throw new Error('cosmos_signDirect is not yet supported — please use cosmos_signAmino')
      }

      default:
        throw new Error(`Unsupported cosmos method: ${method}`)
    }
  }

  private async handleSolanaRequest(
    method: string,
    params: any,
    chainId: string,
    appName: string,
  ): Promise<any> {
    if (!SUPPORTED_SOLANA_CHAINS.includes(chainId)) {
      throw new Error(`Unsupported solana chain: ${chainId}`)
    }
    const account = await this.callbacks.getSolanaAccountInfo(chainId)
    if (!account) throw new Error('Solana account not available')

    switch (method) {
      case 'solana_signMessage': {
        // WC params: { pubkey: bs58, message: base64 }
        const { pubkey, message } = params as { pubkey: string; message: string }
        if (pubkey && pubkey !== account.address) {
          throw new Error(`Pubkey mismatch: dApp asked ${pubkey}, wallet is ${account.address}`)
        }
        const signingId = crypto.randomUUID()
        const signingInfo: SigningRequestInfo = {
          id: signingId,
          method: '/solana/sign-message',
          appName,
          chain: 'solana',
          from: account.address,
          chainId: 0,
          data: message,
        }
        const approved = await this.callbacks.requestSigningApproval(signingInfo)
        if (!approved) throw new Error('User rejected signing')
        try {
          const { signatureBase64 } = await this.callbacks.solanaSignMessageRaw({
            addressNList: account.addressNList,
            messageBase64: message,
          })
          // WC dApps expect the signature as bs58 (Solana standard).
          return { signature: base64ToBase58(signatureBase64) }
        } finally {
          this.callbacks.dismissSigning(signingId)
        }
      }

      case 'solana_signTransaction': {
        // WC params: { transaction: base64 }
        const { transaction } = params as { transaction: string }
        const signingId = crypto.randomUUID()
        const signingInfo: SigningRequestInfo = {
          id: signingId,
          method: '/solana/sign-transaction',
          appName,
          chain: 'solana',
          from: account.address,
          chainId: 0,
          data: transaction,
        }
        const approved = await this.callbacks.requestSigningApproval(signingInfo)
        if (!approved) throw new Error('User rejected signing')
        try {
          const { transactionBase64, signatureBase64 } = await this.callbacks.solanaSignTransactionRaw({
            addressNList: account.addressNList,
            transactionBase64: transaction,
          })
          return {
            signature: base64ToBase58(signatureBase64),
            transaction: transactionBase64,
          }
        } finally {
          this.callbacks.dismissSigning(signingId)
        }
      }

      case 'solana_signAndSendTransaction': {
        // WC params: { transaction: base64 } — same as signTransaction, plus broadcast.
        const { transaction } = params as { transaction: string }
        const signingId = crypto.randomUUID()
        const signingInfo: SigningRequestInfo = {
          id: signingId,
          method: '/solana/sign-and-send',
          appName,
          chain: 'solana',
          from: account.address,
          chainId: 0,
          data: transaction,
        }
        const approved = await this.callbacks.requestSigningApproval(signingInfo)
        if (!approved) throw new Error('User rejected signing')
        try {
          const { transactionBase64 } = await this.callbacks.solanaSignTransactionRaw({
            addressNList: account.addressNList,
            transactionBase64: transaction,
          })
          // Pioneer broadcasts the assembled signed tx. networkId == the CAIP-2 chain.
          const txid = await this.callbacks.broadcastViaPioneer({
            networkId: chainId,
            serialized: transactionBase64,
          })
          return { signature: txid }
        } finally {
          this.callbacks.dismissSigning(signingId)
        }
      }

      default:
        throw new Error(`Unsupported solana method: ${method}`)
    }
  }

  // ── JSON-RPC helper ─────────────────────────────────────────────

  private async rpcCall(chainId: number, method: string, params: any[]): Promise<any> {
    const rpcUrl = CHAIN_RPC[chainId]
    if (!rpcUrl) throw new Error(`No RPC for chain ${chainId}`)
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const json = await resp.json() as any
    if (json.error) throw new Error(json.error.message)
    return json.result
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
      from: this.callbacks.getEvmAddressInfo()?.address,
      data: message,
      chainId,
    }

    const approved = await this.callbacks.requestSigningApproval(signingInfo)
    if (!approved) throw new Error('User rejected signing')

    try {
      // hdwallet expects message as a hex string — pass through as-is
      // (WC personal_sign already provides 0x-prefixed hex)
      const result = await this.callbacks.ethSignMessage({
        addressNList,
        message,
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
      from: this.callbacks.getEvmAddressInfo()?.address,
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
    // Parse chainId: handle both hex (0x1) and decimal ("1") strings, matching rest-api.ts
    let effectiveChainId: number
    if (tx.chainId) {
      const raw = String(tx.chainId)
      effectiveChainId = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
    } else {
      effectiveChainId = chainId
    }
    if (!Number.isInteger(effectiveChainId) || effectiveChainId <= 0) {
      throw new Error(`Invalid chainId: ${tx.chainId}`)
    }

    const signingInfo: SigningRequestInfo = {
      id: signingId,
      method: '/eth/sign-transaction',
      appName,
      chain: 'eth',
      from: tx.from ?? this.callbacks.getEvmAddressInfo()?.address,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      chainId: effectiveChainId,
    }

    const approved = await this.callbacks.requestSigningApproval(signingInfo)
    if (!approved) throw new Error('User rejected signing')

    try {
      const from = tx.from ?? this.callbacks.getEvmAddressInfo()?.address
      if (!from) throw new Error('Missing sender address')

      // Fetch nonce if not provided (most dApps omit it)
      const nonce = tx.nonce ?? await this.rpcCall(effectiveChainId, 'eth_getTransactionCount', [from, 'latest'])

      // Estimate gas if not provided and tx has data (contract interaction)
      let gasLimit = tx.gas ?? tx.gasLimit
      if (!gasLimit) {
        if (tx.data && tx.data !== '0x' && tx.data !== '') {
          gasLimit = await this.rpcCall(effectiveChainId, 'eth_estimateGas', [{
            from, to: tx.to, data: tx.data, value: tx.value ?? '0x0',
          }])
        } else {
          gasLimit = '0x5208' // 21000 for simple transfers
        }
      }

      // Build the ethSignTx message matching hdwallet format
      const msg: any = {
        addressNList,
        to: tx.to,
        value: tx.value ?? '0x0',
        data: tx.data ?? '0x',
        chainId: effectiveChainId,
        nonce,
        gasLimit,
      }

      // EIP-1559 vs legacy gas — fetch from network if not provided
      if (tx.maxFeePerGas) {
        msg.maxFeePerGas = tx.maxFeePerGas
        // Fetch tip if omitted — 0x0 works but produces slow txs
        msg.maxPriorityFeePerGas = tx.maxPriorityFeePerGas
          ?? await this.rpcCall(effectiveChainId, 'eth_maxPriorityFeePerGas', []).catch(() => '0x59682F00') // 1.5 gwei fallback
      } else if (tx.gasPrice) {
        msg.gasPrice = tx.gasPrice
      } else {
        // Neither provided — fetch from network
        msg.gasPrice = await this.rpcCall(effectiveChainId, 'eth_gasPrice', [])
      }

      const result = await this.callbacks.ethSignTx(msg)
      if (!result?.serialized) {
        throw new Error('Device did not return serialized transaction')
      }

      if (broadcast) {
        const txHash = await this.rpcCall(effectiveChainId, 'eth_sendRawTransaction', [result.serialized])
        return txHash
      }

      return result.serialized
    } finally {
      this.callbacks.dismissSigning(signingId)
    }
  }
}
