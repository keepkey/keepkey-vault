import hashlib
import hmac
import json
import re
import struct
import sys
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

BASE = Path(__file__).parent
SRC = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else BASE / 'source'
vectors = (SRC / 'unittests/firmware/zcash_tex_vectors.h').read_text()
def const(name):
    return bytes.fromhex(re.search(r'\b' + name + r'\[\]\s*=\s*"([0-9a-f]+)"', vectors)[1])
def u32(n): return struct.pack('<I', n)
def u64(n): return struct.pack('<Q', n)
def digest(person, data=b''): return hashlib.blake2b(data, digest_size=32, person=person).digest()
def pub(k):
    return ec.derive_private_key(k, ec.SECP256K1()).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint)
def derive(scope):
    seed = hashlib.pbkdf2_hmac('sha512', ('all ' * 12).strip().encode(), b'mnemonic', 2048)
    raw = hmac.digest(b'Bitcoin seed', seed, 'sha512')
    key, chain = int.from_bytes(raw[:32], 'big'), raw[32:]
    order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    for i in [44 | 0x80000000, 133 | 0x80000000, 0x80000000, scope, 0]:
        data = b'\0' + key.to_bytes(32, 'big') if i & 0x80000000 else pub(key)
        raw = hmac.digest(chain, data + struct.pack('>I', i), 'sha512')
        key, chain = (key + int.from_bytes(raw[:32], 'big')) % order, raw[32:]
    pk = pub(key)
    return pk, b'\x76\xa9\x14' + hashlib.new('ripemd160', hashlib.sha256(pk).digest()).digest() + b'\x88\xac'
def reference(version, scope, branch, expiry):
    pk, script = derive(scope)
    prevout = const('kZcashTexStep2V%dPrevoutTxid' % version) + u32(0)
    encoded_script = bytes([len(script)]) + script
    seq = u32(0xffffffff)
    out_script = const('kZcashTexStep2OutputScript')
    prevouts = digest(b'ZTxIdPrevoutHash', prevout)
    amounts = digest(b'ZTxTrAmountsHash', u64(1010000))
    scripts = digest(b'ZTxTrScriptsHash', encoded_script)
    sequences = digest(b'ZTxIdSequencHash', seq)
    outputs = digest(b'ZTxIdOutputsHash', u64(1000000) + bytes([len(out_script)]) + out_script)
    txin = digest(b'Zcash___TxInHash', prevout + u64(1010000) + encoded_script + seq)
    transparent = digest(b'ZTxIdTranspaHash', b'\1' + prevouts + amounts + scripts + sequences + outputs + txin)
    header = digest(b'ZTxIdHeadersHash', u32(0x80000000 | version) + u32(0xD884B698 if version == 6 else 0x26A7270A) + u32(branch) + u32(0) + u32(expiry))
    body = header + transparent + digest(b'ZTxIdSaplingHash') + digest(b'ZTxIdOrchardH_v6' if version == 6 else b'ZTxIdOrchardHash')
    if version == 6: body += digest(b'ZTxIdIronwd_H_v6')
    return pk, script, digest(b'ZcashTxHash_' + u32(branch), body)

# Validate the standalone reference against the release's canonical librustzcash vectors.
for v, branch in [(5, 0x5437F330), (6, 0x37A5165B)]:
    pk, script, sighash = reference(v, 2, branch, 69121)
    assert pk == const('kZcashTexEphemeralPubkey')
    assert script == const('kZcashTexStep1OutputScript')
    assert sighash == const('kZcashTexStep2V%dSighash' % v), (v, sighash.hex())

cases = []
for v in [5, 6]:
    for scope in [0, 1, 2]:
        pk, script, sighash = reference(v, scope, 0x77190AD9, 3560120)
        cases.append(dict(version=v, scope=scope, pubkey=pk.hex(), script=script.hex(), sighash=sighash.hex()))
(BASE / 'reference-vectors.json').write_text(json.dumps(cases, indent=2) + '\n')
rows = '\n'.join('    {%d, %d, "%s", "%s", "%s"},' % (c['version'], c['scope'], c['pubkey'], c['script'], c['sighash']) for c in cases)
code = r'''
#if ZCASH_PRIVACY && !BITCOIN_ONLY
// Audit tests only. The release's firmware implementation is unchanged.
TEST_F(ReviewHandlers, Nu7AuditTransparentSignsWithoutFirmwareChanges) {
  struct Vector { unsigned version, scope; const char *pubkey, *script, *hash; };
  const Vector vectors[] = {
ROWS
  };
  for (const auto& v : vectors) for (bool tex : {false, true}) {
    SCOPED_TRACE(std::to_string(v.version) + "/" + std::to_string(v.scope) + (tex ? "/TEX" : "/t1"));
    ZcashTexStep2 t = zcashTexStep2(v.version == 6);
    zcashSetPath(t.input.address_n, &t.input.address_n_count, 0, v.scope, 0);
    zcashSet(t.input.script_pubkey, zcashHex(v.script));
    t.output.is_tex = tex;
    t.msg.branch_id = 0x77190AD9;
    t.msg.expiry_height = 3560120;
    ASSERT_TRUE(zcash_compute_header_digest(t.msg.tx_version, t.msg.version_group_id,
        t.msg.branch_id, 0, t.msg.expiry_height, t.msg.header_digest.bytes));
    zcashTexClaimDigest(t);
    const auto run = zcashRunTex(t.msg, {t.output}, {t.input}, {});
    ASSERT_EQ(0, fsm_test_lastFailureCode()) << fsm_test_lastFailureMessage();
    ASSERT_TRUE(run.signed_pczt);
    ASSERT_TRUE(run.orchard.empty());
    ASSERT_EQ(1u, run.transparent.size());
    EXPECT_TRUE(zcashShown(run, "Confirm transaction fee?"));
    EXPECT_TRUE(zcashShown(run, "Amount: 0.01000000 ZEC"));
    uint8_t sig[64];
    ASSERT_EQ(0, ecdsa_sig_from_der(run.transparent[0].data(), run.transparent[0].size(), sig));
    const auto pk = zcashHex(v.pubkey), hash = zcashHex(v.hash);
    EXPECT_EQ(0, ecdsa_verify_digest(&secp256k1, pk.data(), sig, hash.data()));
    auto wrong_hash = hash; wrong_hash[0] ^= 1;
    EXPECT_NE(0, ecdsa_verify_digest(&secp256k1, pk.data(), sig, wrong_hash.data()));
  }
}

TEST_F(ReviewHandlers, Nu7AuditTransparentTamperingProducesNoSignature) {
  for (int mutation : {0, 1, 2}) {
    SCOPED_TRACE(mutation);
    ZcashTexStep2 t = zcashTexStep2(true);
    t.msg.branch_id = 0x77190AD9;
    t.msg.expiry_height = 3560120;
    ASSERT_TRUE(zcash_compute_header_digest(6, 0xD884B698, t.msg.branch_id,
        0, t.msg.expiry_height, t.msg.header_digest.bytes));
    zcashTexClaimDigest(t);
    if (mutation == 0) t.msg.branch_id = 0x37A5165B;
    if (mutation == 1) t.input.amount++;
    if (mutation == 2) t.output.script_pubkey.bytes[5] ^= 1;
    const auto run = zcashRunTex(t.msg, {t.output}, {t.input}, {});
    EXPECT_NE(0, fsm_test_lastFailureCode());
    EXPECT_FALSE(run.signed_pczt);
    EXPECT_TRUE(run.transparent.empty());
    EXPECT_TRUE(run.orchard.empty());
  }
}

TEST_F(ReviewHandlers, Nu7AuditIronwoodAndMigrationFailAtBranchGuards) {
  for (bool migration : {false, true}) for (uint32_t branch : {0x37A5165Bu, 0x77190AD9u}) {
    SCOPED_TRACE(std::to_string(branch) + (migration ? "/migration" : "/Ironwood"));
    uint8_t empty[32];
    zcashPersonal("ZTxIdOrchardH_v6", {}, empty);
    auto msg = zcashV6Request(1, empty, migration ? 3 : 7, 0, 0);
    msg.branch_id = branch;
    if (migration) {
      uint8_t ironwood[32]; zcashPersonal("ZTxIdIronwd_H_v6", {}, ironwood);
      zcashAddIronwood(msg, 1, ironwood, 7, 0);
    } else {
      msg.has_shielded_pool = true;
      msg.shielded_pool = ZcashShieldedPool_ZCASH_SHIELDED_POOL_IRONWOOD;
      msg.has_ironwood_digest = true;
      msg.ironwood_digest.size = 32;
      zcashPersonal("ZTxIdIronwd_H_v6", {}, msg.ironwood_digest.bytes);
    }
    ASSERT_TRUE(zcash_compute_header_digest(6, 0xD884B698, branch, 0,
        msg.expiry_height, msg.header_digest.bytes));
    ASSERT_TRUE(kkconfirm_preload(2, 0));
    fsm_test_clearLastFailure();
    kkconfirm_capture_start();
    fsm_msgZcashSignPCZT(&msg);
    const auto screens = kkconfirm_capture_finish();
    if (branch == 0x77190AD9) {
      EXPECT_STREQ(migration ? "Invalid pool-crossing transaction" : "Invalid Ironwood transaction", fsm_test_lastFailureMessage());
      EXPECT_FALSE(zcash_signing_is_active());
      EXPECT_TRUE(screens.empty());
    } else {
      EXPECT_EQ(0, fsm_test_lastFailureCode()) << fsm_test_lastFailureMessage();
      EXPECT_TRUE(zcash_signing_is_active());
      EXPECT_FALSE(screens.empty());
    }
    EXPECT_FALSE(zcashSignatureEmitted(kkconfirm_readResponseIds()));
    fsm_abort_workflows();
    (void)kkconfirm_drain();
  }
}
#endif
'''.replace('ROWS', rows)
p = SRC / 'unittests/firmware/review_handlers.cpp'
original = p.read_text()
assert 'Nu7AuditTransparentSignsWithoutFirmwareChanges' not in original
p.write_text(original + code)
print('Added 3 audit tests; 12 transparent signature cases, 3 tamper cases, 4 admission cases.')
