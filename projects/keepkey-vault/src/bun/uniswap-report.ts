import { utils as ethersUtils } from 'ethers'

import type { EffectFinding } from '../shared/transaction-effects'
import { evmRpc } from './evm-effects'
import { isOfficialLegacyUniswapTarget, legacyUniswapReportFindings } from './uniswap-legacy-router'
import {
  isOfficialPermissionedPositionManager,
  isOfficialV4PositionManager,
  permissionedPositionReferences,
  v4PositionManagerReportFindings,
} from './uniswap-v4-position-manager'
import { isOfficialPermit2, permit2ReportFindings } from './permit2-calldata'
import {
  officialUniversalRouterVersion,
  permissionedV4References,
  universalRouterReportFindings,
} from './uniswap-universal-router'

const ERC20_APPROVE = new ethersUtils.Interface(['function approve(address spender,uint256 amount)'])
const UINT256_MAX = (1n << 256n) - 1n
const UNISWAP_SETUP_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
}

function permit2SetupApproval(data: string, chainId?: number, to?: string) {
  const token = chainId && to ? UNISWAP_SETUP_TOKENS[`${chainId}:${to.toLowerCase()}`] : undefined
  if (!token || !/^0x[0-9a-f]+$/i.test(data)) return undefined
  try {
    const parsed = ERC20_APPROVE.parseTransaction({ data })
    if (parsed.name !== 'approve'
      || ERC20_APPROVE.encodeFunctionData(parsed.sighash, Array.from(parsed.args)).toLowerCase() !== data.toLowerCase()) return undefined
    const spender = String(parsed.args.spender).toLowerCase()
    if (!isOfficialPermit2(chainId, spender)) return undefined
    const amount = BigInt(parsed.args.amount.toString())
    return {
      findings: [{
        code: 'UNISWAP_PERMIT2_TOKEN_APPROVAL',
        message: `Authorize canonical Permit2 ${spender} to spend ${amount === UINT256_MAX ? 'an unlimited amount' : `${amount} base units`} of ${token.symbol} from token contract ${to!.toLowerCase()}.`,
        severity: 'warning' as const,
      }],
      limitations: [],
      complete: true,
    }
  } catch { return undefined }
}

/** Route a call to the matching Uniswap dialect without ever treating ABI
 * compatibility as identity. Each decoder independently verifies the target
 * against its official deployment registry and downgrades unknown addresses. */
export function uniswapReportFindings(data: string, chainId?: number, to?: string) {
  // Identity must select the ABI family, never the selector. ERC-20/ERC-721
  // share selectors such as approve(address,uint256), and decoding first can
  // otherwise misdescribe an ordinary token allowance as a position-NFT ID.
  const setupApproval = permit2SetupApproval(data, chainId, to)
  if (setupApproval) return setupApproval
  if (officialUniversalRouterVersion(chainId, to)) return universalRouterReportFindings(data, chainId, to)
  if (isOfficialV4PositionManager(chainId, to)) return v4PositionManagerReportFindings(data, chainId, to)
  if (isOfficialPermit2(chainId, to)) return permit2ReportFindings(data, chainId, to)
  if (isOfficialLegacyUniswapTarget(chainId, to)) return legacyUniswapReportFindings(data, chainId, to)
  return { findings: [], limitations: [], complete: false }
}

const ROUTER_STATE = new ethersUtils.Interface([
  'function PERMISSIONS_ADAPTER_FACTORY() view returns (address)',
])
const FACTORY_STATE = new ethersUtils.Interface([
  'function verifiedPermissionsAdapterOf(address) view returns (address)',
  'function permissionsAdapterOf(address) view returns (address)',
])
const ADAPTER_STATE = new ethersUtils.Interface([
  'function swappingEnabled() view returns (bool)',
  'function isAllowed(address,bytes2) view returns (bool)',
  'function allowedHooks(address) view returns (bool)',
])
const PERMISSIONED_POSITION_STATE = new ethersUtils.Interface([
  'function PERMISSIONS_ADAPTER_FACTORY() view returns (address)',
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),bytes32)',
  'function ownerOf(uint256) view returns (address)',
])

async function call(
  endpoint: string,
  block: string,
  target: string,
  iface: ethersUtils.Interface,
  method: string,
  args: unknown[] = [],
): Promise<ethersUtils.Result> {
  const result = await evmRpc(endpoint, 'eth_call', [{ to: target, data: iface.encodeFunctionData(method, args) }, block])
  return iface.decodeFunctionResult(method, result)
}

/** Resolve mutable Universal Router 2.2 permission-adapter semantics at one
 * block. The synchronous decoder deliberately remains fail-closed when this
 * evidence is unavailable. */
export async function uniswapReportFindingsWithState(
  data: string,
  chainId: number | undefined,
  to: string | undefined,
  from: string | undefined,
  endpoint: string,
) {
  const base = uniswapReportFindings(data, chainId, to)
  if (isOfficialPermissionedPositionManager(chainId, to)
    && base.limitations.some(item => item.code === 'UNISWAP_PERMISSIONED_POSITION_STATE_UNRESOLVED')
    && to) {
    const findings: EffectFinding[] = [...base.findings]
    try {
      const block = await evmRpc(endpoint, 'eth_blockNumber', [])
      const [factoryValue] = await call(endpoint, block, to, PERMISSIONED_POSITION_STATE, 'PERMISSIONS_ADAPTER_FACTORY')
      const factory = String(factoryValue).toLowerCase()
      if (factory === '0x0000000000000000000000000000000000000000') throw new Error('permissioned PositionManager has no adapter factory')

      const references = permissionedPositionReferences(data, from)
      for (const original of references) {
        let ref = original
        if (ref.tokenId) {
          const [poolKey] = await call(endpoint, block, to, PERMISSIONED_POSITION_STATE, 'getPoolAndPositionInfo', [ref.tokenId])
          const principal = ref.requireLiquidityPermission
            ? String((await call(endpoint, block, to, PERMISSIONED_POSITION_STATE, 'ownerOf', [ref.tokenId]))[0]).toLowerCase()
            : undefined
          ref = {
            ...ref,
            currencies: [String(poolKey.currency0).toLowerCase(), String(poolKey.currency1).toLowerCase()],
            hooks: String(poolKey.hooks).toLowerCase(), principal,
          }
        }
        let verifiedCount = 0
        for (const currency of ref.currencies || []) {
          if (currency === '0x0000000000000000000000000000000000000000') continue
          const [underlyingValue] = await call(endpoint, block, factory, FACTORY_STATE, 'verifiedPermissionsAdapterOf', [currency])
          const underlying = String(underlyingValue).toLowerCase()
          if (underlying === '0x0000000000000000000000000000000000000000') {
            const [createdValue] = await call(endpoint, block, factory, FACTORY_STATE, 'permissionsAdapterOf', [currency])
            if (String(createdValue).toLowerCase() !== '0x0000000000000000000000000000000000000000') {
              throw new Error(`adapter ${currency} exists but is not verified`)
            }
            const code = await evmRpc(endpoint, 'eth_getCode', [currency, block])
            if (code === '0x') throw new Error(`ordinary currency ${currency} is not a contract`)
            continue
          }
          verifiedCount++
          const hookAllowed = ref.requireAllowedHook && ref.hooks
            ? Boolean((await call(endpoint, block, currency, ADAPTER_STATE, 'allowedHooks', [ref.hooks]))[0])
            : undefined
          if (ref.requireLiquidityPermission && !ref.principal) throw new Error(`liquidity principal unavailable for adapter ${currency}`)
          const liquidityAllowed = ref.requireLiquidityPermission
            ? Boolean((await call(endpoint, block, currency, ADAPTER_STATE, 'isAllowed', [ref.principal, '0x0002']))[0])
            : undefined
          findings.push({
            code: 'UNISWAP_PERMISSIONED_POSITION_CURRENCY_RESOLVED',
            message: `At block ${block}, adapter ${currency} resolves to underlying token ${underlying}${ref.principal ? `; ${ref.principal} is ${liquidityAllowed === false ? 'not ' : ''}liquidity-authorized` : ''}${hookAllowed === undefined ? '' : `; hook ${ref.hooks} is ${hookAllowed ? '' : 'not '}allowed`}.`,
            severity: liquidityAllowed === false || hookAllowed === false ? 'danger' : 'warning',
          })
          if (liquidityAllowed === false || hookAllowed === false) throw new Error('permissioned liquidity action is not currently authorized')
        }
        if (ref.requireVerifiedAdapter && verifiedCount === 0) throw new Error('permissioned mint has no verified permissions adapter')
      }
      const limitations = base.limitations.filter(item => item.code !== 'UNISWAP_PERMISSIONED_POSITION_STATE_UNRESOLVED')
      return { findings, limitations, complete: limitations.length === 0 }
    } catch (error: any) {
      return {
        ...base,
        findings,
        limitations: [...base.limitations, {
          code: 'UNISWAP_PERMISSIONED_POSITION_STATE_LOOKUP_FAILED',
          message: `Block-pinned permissioned PositionManager lookup failed: ${error?.message || String(error)}.`,
          severity: 'danger' as const,
        }],
      }
    }
  }
  if (officialUniversalRouterVersion(chainId, to) !== 'V2.2.0 Permissioned Pools'
    || !base.limitations.some(item => item.code === 'UNISWAP_PERMISSIONED_CURRENCY_UNRESOLVED')
    || !to) return base

  const findings: EffectFinding[] = [...base.findings]
  try {
    const block = await evmRpc(endpoint, 'eth_blockNumber', [])
    const [factory] = await call(endpoint, block, to, ROUTER_STATE, 'PERMISSIONS_ADAPTER_FACTORY')
    const factoryAddress = String(factory).toLowerCase()
    if (factoryAddress === '0x0000000000000000000000000000000000000000') {
      findings.push({
        code: 'UNISWAP_PERMISSIONED_POOLS_DISABLED',
        message: `At block ${block}, this router has no permissions-adapter factory; v4 currencies retain their literal token meanings.`,
        severity: 'info',
      })
    } else {
      for (const ref of permissionedV4References(data)) {
        const [underlyingValue] = await call(endpoint, block, factoryAddress, FACTORY_STATE, 'verifiedPermissionsAdapterOf', [ref.currency])
        const underlying = String(underlyingValue).toLowerCase()
        if (underlying === '0x0000000000000000000000000000000000000000') continue
        const [enabled] = await call(endpoint, block, ref.currency, ADAPTER_STATE, 'swappingEnabled')
        const allowed = from
          ? Boolean((await call(endpoint, block, ref.currency, ADAPTER_STATE, 'isAllowed', [from, '0x0001']))[0])
          : undefined
        const hookAllowed = ref.hooks
          ? Boolean((await call(endpoint, block, ref.currency, ADAPTER_STATE, 'allowedHooks', [ref.hooks]))[0])
          : undefined
        findings.push({
          code: 'UNISWAP_PERMISSIONED_CURRENCY_RESOLVED',
          message: `At block ${block}, adapter ${ref.currency} resolves to underlying token ${underlying}; swapping is ${enabled ? 'enabled' : 'disabled'}${allowed === undefined ? '' : `; sender is ${allowed ? '' : 'not '}swap-authorized`}${hookAllowed === undefined ? '' : `; hook ${ref.hooks} is ${hookAllowed ? '' : 'not '}allowed`}.`,
          severity: enabled && allowed !== false && hookAllowed !== false ? 'warning' : 'danger',
        })
        if (!enabled || allowed === false || hookAllowed === false) throw new Error('permissioned swap is not currently authorized')
      }
    }
    const limitations = base.limitations.filter(item => item.code !== 'UNISWAP_PERMISSIONED_CURRENCY_UNRESOLVED')
    return { findings, limitations, complete: limitations.length === 0 }
  } catch (error: any) {
    return {
      ...base,
      findings,
      limitations: [...base.limitations, {
        code: 'UNISWAP_PERMISSIONED_STATE_LOOKUP_FAILED',
        message: `Block-pinned permissions-adapter lookup failed: ${error?.message || String(error)}.`,
        severity: 'danger' as const,
      }],
    }
  }
}
