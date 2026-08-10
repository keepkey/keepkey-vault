#!/usr/bin/env node

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const require = createRequire(import.meta.url)
const protocolRoot = resolve(process.argv[2] ?? new URL("../../../modules/device-protocol", import.meta.url).pathname)
const zcash = require(resolve(protocolRoot, "lib/messages-zcash_pb.js"))

assert.equal(zcash.ZcashShieldedPool.ZCASH_SHIELDED_POOL_IRONWOOD, 1, "Ironwood pool enum is missing")

const digest = Uint8Array.from({ length: 32 }, (_, index) => index)
const request = new zcash.ZcashSignPCZT()
assert.equal(typeof request.setShieldedPool, "function", "ZcashSignPCZT field 19 is missing")
assert.equal(typeof request.setIronwoodDigest, "function", "ZcashSignPCZT field 20 is missing")
request.setShieldedPool(zcash.ZcashShieldedPool.ZCASH_SHIELDED_POOL_IRONWOOD)
request.setIronwoodDigest(digest)

const roundTrip = zcash.ZcashSignPCZT.deserializeBinary(request.serializeBinary())
assert.equal(roundTrip.getShieldedPool(), 1, "Ironwood pool did not survive protobuf serialization")
assert.deepEqual(roundTrip.getIronwoodDigest_asU8(), digest, "Ironwood digest did not survive protobuf serialization")

const action = new zcash.ZcashPCZTAction()
action.setIsSpend(true)
const actionRoundTrip = zcash.ZcashPCZTAction.deserializeBinary(action.serializeBinary())
assert.equal(actionRoundTrip.getIsSpend(), true, "google-protobuf runtime is too old for generated boolean fields")

console.log("[device-protocol] Ironwood fields 19/20 and action booleans round-trip: ok")
