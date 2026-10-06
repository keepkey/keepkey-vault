#!/usr/bin/env bun
import os from 'node:os'
import path from 'node:path'
import { mkdir, rename } from 'node:fs/promises'

import { compileApprovedErc20TokenArtifact } from '../src/bun/clearsign-artifact-compiler'
import type { ClearSignCentralAssetAudit, ClearSignCentralAssetAuditHistory, ClearSignCentralContractAudit, ClearSignCentralRequest } from '../src/shared/types'

const SERVICE = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const TOKEN_PATH = process.env.CLEARSIGN_ADMIN_TOKEN_FILE
  || path.join(os.homedir(), 'Library/Application Support/com.keepkey.vault/clearsign-admin-token')

async function api(token: string, service: string, pathname: string, query: Record<string, string>) {
  const url = new URL(pathname, service)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  const body: any = await response.json()
  if (!response.ok) throw new Error(body?.error || `HTTP_${response.status}`)
  return body
}

async function findAsset(token: string, service: string, chainId: number, contract: string): Promise<ClearSignCentralAssetAudit> {
  const standards = chainId === 56 ? ['bep20', 'erc20'] : ['erc20']
  for (const standard of standards) {
    try {
      return (await api(token, service, '/v1/admin/discovery/assets/item', {
        caip: `eip155:${chainId}/${standard}:${contract.toLowerCase()}`,
      })).asset
    } catch (error: any) {
      if (!String(error?.message).includes('asset not found')) throw error
    }
  }
  throw new Error('TOKEN_ASSET_NOT_INDEXED')
}

export async function planApprovedPromotions(token: string, service = SERVICE) {
  const page = await api(token, service, '/v1/admin/discovery/requests', { status: 'approved', limit: '500' })
  const requests: ClearSignCentralRequest[] = Array.isArray(page?.requests) ? page.requests : []
  const plans: any[] = []
  for (const request of requests) {
    try {
      if (!request.current_audit_id) throw new Error('CURRENT_CONTRACT_AUDIT_MISSING')
      const match = /^eip155:(\d+)$/.exec(request.network)
      if (!match || !['0x095ea7b3', '0xa9059cbb', '0x23b872dd'].includes(request.selector.toLowerCase())) {
        throw new Error('NO_AUTOMATIC_TOKEN_PROMOTION_COMPILER')
      }
      const chainId = Number(match[1])
      const contractAudit = await api(token, service, '/v1/admin/discovery/audit', { auditId: request.current_audit_id }) as ClearSignCentralContractAudit
      const asset = await findAsset(token, service, chainId, request.contract)
      const history = await api(token, service, '/v1/admin/discovery/assets/history', { caip: asset.caip, limit: '1' })
      const assetAudit = history?.audits?.[0] as ClearSignCentralAssetAuditHistory | undefined
      if (!assetAudit) throw new Error('CURRENT_TOKEN_AUDIT_MISSING')
      plans.push({ requestId: request.id, status: 'unsigned-artifact-ready', asset: asset.caip,
        artifact: compileApprovedErc20TokenArtifact({ contractAudit, asset, assetAudit }) })
    } catch (error: any) {
      plans.push({ requestId: request.id, status: 'blocked', blocker: error?.message || String(error) })
    }
  }
  return { version: 1, generatedAt: Date.now(), approvedRequests: requests.length,
    ready: plans.filter(plan => plan.status === 'unsigned-artifact-ready').length,
    blocked: plans.filter(plan => plan.status === 'blocked').length, plans }
}

if (import.meta.main) {
  const token = (await Bun.file(TOKEN_PATH).text()).trim()
  if (token.length < 32) throw new Error('ClearSign operator access is not configured')
  const plan = await planApprovedPromotions(token)
  const serialized = JSON.stringify(plan, null, 2)
  const outputArg = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
  if (outputArg) {
    const output = path.resolve(outputArg.replace(/^~(?=$|\/)/, os.homedir()))
    await mkdir(path.dirname(output), { recursive: true })
    const temporary = `${output}.tmp-${process.pid}`
    await Bun.write(temporary, `${serialized}\n`)
    await rename(temporary, output)
  }
  console.log(serialized)
}
