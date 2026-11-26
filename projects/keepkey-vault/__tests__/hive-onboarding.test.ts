// KEEPKEY-187: self-serve Hive account creation when the sponsor refuses.
// The operation is signed outside the vault, so its JSON and the hive-uri
// bytes must be exact — pinned here against an independently computed vector.
import { describe, expect, test } from 'bun:test'
import {
	b64u, buildAccountCreateOp, buildCreateClaimedAccountOp, buildKeyRotationOp, buildOwnerRotationOp,
	hiveSignUri, hiveSignerUrl, isValidHiveAccountName, normalizeAuthority, normalizeHiveAccountName,
	operationJson, parseAccountAuthorities, planKeyRotation, type HiveRoleKeys,
} from '../src/shared/hive-onboarding'
import { hiveAccountCreationFee, hiveRpc, lookupHiveAccount, HIVE_API_NODES } from '../src/bun/hive-chain'

const KEYS: HiveRoleKeys = {
	owner: 'STM5ownerKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	active: 'STM6activeKeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
	posting: 'STM7postingKeyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
	memo: 'STM8memoKeyDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
}
const auth = (k: string) => `{"weight_threshold":1,"account_auths":[],"key_auths":[["${k}",1]]}`

// Computed with Python's json.dumps(separators=(',',':')) + base64, then the hive-uri alphabet.
const ACCOUNT_CREATE_JSON = `["account_create",{"fee":"3.000 HIVE","creator":"skatehive","new_account_name":"sopadevs","owner":${auth(KEYS.owner)},"active":${auth(KEYS.active)},"posting":${auth(KEYS.posting)},"memo_key":"${KEYS.memo}","json_metadata":""}]`
const ACCOUNT_CREATE_B64U = 'WyJhY2NvdW50X2NyZWF0ZSIseyJmZWUiOiIzLjAwMCBISVZFIiwiY3JlYXRvciI6InNrYXRlaGl2ZSIsIm5ld19hY2NvdW50X25hbWUiOiJzb3BhZGV2cyIsIm93bmVyIjp7IndlaWdodF90aHJlc2hvbGQiOjEsImFjY291bnRfYXV0aHMiOltdLCJrZXlfYXV0aHMiOltbIlNUTTVvd25lcktleUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwxXV19LCJhY3RpdmUiOnsid2VpZ2h0X3RocmVzaG9sZCI6MSwiYWNjb3VudF9hdXRocyI6W10sImtleV9hdXRocyI6W1siU1RNNmFjdGl2ZUtleUJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkIiLDFdXX0sInBvc3RpbmciOnsid2VpZ2h0X3RocmVzaG9sZCI6MSwiYWNjb3VudF9hdXRocyI6W10sImtleV9hdXRocyI6W1siU1RNN3Bvc3RpbmdLZXlDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0MiLDFdXX0sIm1lbW9fa2V5IjoiU1RNOG1lbW9LZXlEREREREREREREREREREREREREREREREREREREREREREREREREREQiLCJqc29uX21ldGFkYXRhIjoiIn1d'

describe('path A builders', () => {
	test('account_create: exact JSON with the four KeepKey keys', () => {
		const op = buildAccountCreateOp({ creator: 'skatehive', newAccountName: 'sopadevs', keys: KEYS })
		expect(JSON.stringify(op)).toBe(ACCOUNT_CREATE_JSON)
	})

	test('account_create carries the live fee when given', () => {
		const op = buildAccountCreateOp({ creator: 'a-payer', newAccountName: 'sopadevs', keys: KEYS, fee: '2.500 HIVE' })
		expect(op[1].fee).toBe('2.500 HIVE')
	})

	test('create_claimed_account: exact JSON, no fee, empty extensions', () => {
		const op = buildCreateClaimedAccountOp({ creator: 'skatehive', newAccountName: 'sopadevs', keys: KEYS })
		expect(JSON.stringify(op)).toBe(`["create_claimed_account",{"creator":"skatehive","new_account_name":"sopadevs","owner":${auth(KEYS.owner)},"active":${auth(KEYS.active)},"posting":${auth(KEYS.posting)},"memo_key":"${KEYS.memo}","json_metadata":"","extensions":[]}]`)
	})

	test('hive-uri and HiveSigner link encode the exact bytes', () => {
		const op = buildAccountCreateOp({ creator: 'skatehive', newAccountName: 'sopadevs', keys: KEYS })
		expect(hiveSignUri(op)).toBe(`hive://sign/op/${ACCOUNT_CREATE_B64U}`)
		expect(hiveSignUri(op, 'xvlad')).toBe(`hive://sign/op/${ACCOUNT_CREATE_B64U}?s=xvlad`)
		expect(hiveSignerUrl(op)).toBe(`https://hivesigner.com/sign/op/${ACCOUNT_CREATE_B64U}`)
		// Round-trip through the hive-uri decoder rules.
		const decoded = Buffer.from(ACCOUNT_CREATE_B64U.replace(/[-_.]/g, m => (m === '-' ? '+' : m === '_' ? '/' : '=')), 'base64').toString('utf8')
		expect(JSON.parse(decoded)).toEqual(op)
	})

	test('copy operation is the same op as pretty JSON', () => {
		const op = buildAccountCreateOp({ creator: 'skatehive', newAccountName: 'sopadevs', keys: KEYS })
		expect(JSON.parse(operationJson(op))).toEqual(JSON.parse(ACCOUNT_CREATE_JSON))
	})
})

describe('b64u (hive-uri alphabet)', () => {
	test('padding becomes "." and is kept', () => {
		expect(b64u('a')).toBe('YQ..')
		expect(b64u('ab')).toBe('YWI.')
		expect(b64u('abc')).toBe('YWJj')
	})
	test('"+" → "-" and "/" → "_"', () => {
		expect(Buffer.from('??>').toString('base64')).toBe('Pz8+')
		expect(b64u('??>')).toBe('Pz8-')
		expect(b64u('???')).toBe('Pz8_')
	})
	test('UTF-8, not Latin-1', () => {
		expect(b64u('ã')).toBe(Buffer.from('ã', 'utf8').toString('base64').replace(/=/g, '.'))
	})
})

describe('account names', () => {
	test('valid names', () => {
		for (const n of ['sopadevs', 'abc', 'skate-hive', 'a1b', 'name.two', 'abcdefghijklmnop']) expect(isValidHiveAccountName(n), n).toBe(true)
	})
	test('invalid names', () => {
		for (const n of ['ab', 'abcdefghijklmnopq', '1abc', 'abc-', 'Abc', 'ab.cd', 'a--b', 'abc..def', '', 'ab_c']) expect(isValidHiveAccountName(n), n).toBe(false)
	})
	test('normalizes "@Name " input', () => {
		expect(normalizeHiveAccountName(' @SopaDevs ')).toBe('sopadevs')
	})
})

const RAW_ACCOUNT = {
	name: 'sopadev', memo_key: 'STM8oldMemo', json_metadata: '{"profile":{"name":"Sopa"}}', posting_json_metadata: '{"profile":{}}',
	pending_claimed_accounts: '2', balance: '12.345 HIVE',
	owner: { weight_threshold: 1, account_auths: [], key_auths: [['STM5oldOwner', 1]] },
	active: { weight_threshold: '1', account_auths: [], key_auths: [['STM6oldActive', '1']] },
	posting: { weight_threshold: 1, account_auths: [['peakd.app', '1'], ['ecency.app', 1]], key_auths: [['STM7oldPosting', 1]] },
}

describe('get_accounts normalization', () => {
	test('string weights become numbers, account_auths sorted by name', () => {
		expect(normalizeAuthority(RAW_ACCOUNT.posting)).toEqual({ weight_threshold: 1, account_auths: [['ecency.app', 1], ['peakd.app', 1]], key_auths: [['STM7oldPosting', 1]] })
		const parsed = parseAccountAuthorities(RAW_ACCOUNT)
		expect(parsed.active).toEqual({ weight_threshold: 1, account_auths: [], key_auths: [['STM6oldActive', 1]] })
		expect(parsed.pending_claimed_accounts).toBe(2)
		expect(parsed.balance).toBe('12.345 HIVE')
	})
})

describe('path B builders (UI follows; built and pinned now)', () => {
	const account = parseAccountAuthorities(RAW_ACCOUNT)
	test('account_update without owner: active/posting/memo to KeepKey, metadata passed through, apps kept', () => {
		const op = buildKeyRotationOp(account, KEYS, { keepPostingAccountAuths: true, keepActiveAccountAuths: true })
		expect(JSON.stringify(op)).toBe(`["account_update",{"account":"sopadev","active":${auth(KEYS.active)},"posting":{"weight_threshold":1,"account_auths":[["ecency.app",1],["peakd.app",1]],"key_auths":[["${KEYS.posting}",1]]},"memo_key":"${KEYS.memo}","json_metadata":"{\\"profile\\":{\\"name\\":\\"Sopa\\"}}"}]`)
		expect('owner' in op[1]).toBe(false)
		expect('posting_json_metadata' in op[1]).toBe(false)
	})
	test('dropping apps empties posting account_auths', () => {
		const op = buildKeyRotationOp(account, KEYS, { keepPostingAccountAuths: false, keepActiveAccountAuths: true })
		expect((op[1].posting as any).account_auths).toEqual([])
	})
	test('multisig source: account auths are not carried into a threshold-1 authority', () => {
		const multisig = { ...account, active: { weight_threshold: 2, account_auths: [['cosigner', 1]] as [string, number][], key_auths: [['STM6a', 1], ['STM6b', 1]] as [string, number][] } }
		const op = buildKeyRotationOp(multisig, KEYS, { keepPostingAccountAuths: true, keepActiveAccountAuths: true })
		expect(op[1].active).toEqual({ weight_threshold: 1, account_auths: [], key_auths: [[KEYS.active, 1]] })
		expect(planKeyRotation(multisig, KEYS).droppedForMultisig).toEqual(['cosigner'])
	})
	test('owner rotation is separate and carries owner (needs owner authority)', () => {
		const op = buildOwnerRotationOp(account, KEYS)
		expect(Object.keys(op[1])).toEqual(['account', 'owner', 'memo_key', 'json_metadata'])
		expect(op[1].owner).toEqual({ weight_threshold: 1, account_auths: [], key_auths: [[KEYS.owner, 1]] })
	})
	test('plan detects an account already on this KeepKey', () => {
		const done = { ...account, active: normalizeAuthority({ weight_threshold: 1, key_auths: [[KEYS.active, 1]] }), posting: normalizeAuthority({ weight_threshold: 1, key_auths: [[KEYS.posting, 1]] }), memo_key: KEYS.memo }
		expect(planKeyRotation(done, KEYS).alreadyOnKeepKey).toBe(true)
		expect(planKeyRotation(account, KEYS)).toMatchObject({ alreadyOnKeepKey: false, memoChanges: true, ownerOnKeepKey: false, postingApps: [['ecency.app', 1], ['peakd.app', 1]] })
	})
})

describe('hive-chain (read-only node queries)', () => {
	const respond = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

	test('fails over to the next node and sends a JSON-RPC body', async () => {
		const seen: { node: string; body: any }[] = []
		const fake = async (node: string, init?: RequestInit) => {
			seen.push({ node, body: JSON.parse(String(init?.body)) })
			if (node === HIVE_API_NODES[0]) throw new Error('down')
			return respond({ result: [RAW_ACCOUNT] })
		}
		const account = await lookupHiveAccount('sopadev', fake as any)
		expect(seen.map(s => s.node)).toEqual(HIVE_API_NODES.slice(0, 2))
		expect(seen[1].body).toEqual({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [['sopadev']], id: 1 })
		expect(account?.posting.account_auths).toEqual([['ecency.app', 1], ['peakd.app', 1]])
	})

	test('a missing account is null; an invalid name never hits the network', async () => {
		expect(await lookupHiveAccount('nobody-here', (async () => respond({ result: [] })) as any)).toBeNull()
		let called = false
		await expect(lookupHiveAccount('No_Such', (async () => { called = true; return respond({ result: [] }) }) as any)).rejects.toThrow('Invalid Hive account name')
		expect(called).toBe(false)
	})

	test('all nodes failing throws', async () => {
		await expect(hiveRpc('x', [], (async () => respond({ error: { message: 'boom' } })) as any)).rejects.toThrow('All Hive nodes failed for x')
	})

	test('creation fee: live value, default on a malformed answer', async () => {
		expect(await hiveAccountCreationFee((async () => respond({ result: { account_creation_fee: '3.000 HIVE' } })) as any)).toBe('3.000 HIVE')
		expect(await hiveAccountCreationFee((async () => respond({ result: { account_creation_fee: '3.000 TESTS' } })) as any)).toBe('3.000 HIVE')
	})
})
