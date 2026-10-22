import { describe, test, expect } from "bun:test";
import * as btc from "@scure/btc-signer";
import { RawPSBTV0 } from "@scure/btc-signer/psbt";
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  parseMultisigPolicy,
  deriveMultisig,
  multisigAccountPath,
  cosignerKey,
  descriptorChecksum,
  exportCosigner,
  type MultisigScriptType,
} from "./multisig-policy";
import {
  analyzeMultisig,
  applyMultisigSignatures,
  multisigToSignTx,
} from "./multisig-cosign";
import { formatPath } from "./codec";
import { parseForBroadcast } from "./psbt";
const masters = [1, 2, 3].map((n) =>
  HDKey.fromMasterSeed(new Uint8Array(32).fill(n))
);
const DEST = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
function fixture(type: MultisigScriptType = "p2wsh", sorted = true, threshold = 2, count = 3) {
  const keys = count === 3 ? masters : Array.from({length:count}, (_,i)=>HDKey.fromMasterSeed(new Uint8Array(32).fill(i+1)))
  const cs = keys.map((m, i) => {
    const path = multisigAccountPath(type, type === "p2sh" ? 0 : i);
    return {
      fingerprint: m.fingerprint.toString(16).padStart(8, "0"),
      path,
      xpub: m.derive(formatPath(path)).publicExtendedKey,
    };
  });
  const core = `${sorted ? "sortedmulti" : "multi"}(${threshold},${cs
    .map((c) => cosignerKey(c) + "/<0;1>/*")
    .join(",")})`;
  const descriptor =
    type === "p2wsh"
      ? `wsh(${core})`
      : type === "p2sh-p2wsh"
      ? `sh(wsh(${core}))`
      : `sh(${core})`;
  const policy = parseMultisigPolicy(descriptor),
    own = policy.cosigners.findIndex(
      (c) => c.fingerprint === cs[0].fingerprint
    );
  const payment = deriveMultisig(policy, 0, 7);
  const prev = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    lockTime: 0,
    witnesses: undefined,
    inputs: [
      {
        txid: new Uint8Array(32).fill(99),
        index: 0,
        sequence: 0xffffffff,
        finalScriptSig: new Uint8Array(),
      },
    ],
    outputs: [{ amount: 100_000n, script: payment.payment.script }],
  });
  const tx = new btc.Transaction({ version: 2, lockTime: 500_000 });
  const origins = (branch: number, index: number) =>
    deriveMultisig(policy, branch, index).members.map(
      (m) =>
        [
          m.pubkey,
          {
            fingerprint: parseInt(m.cosigner.fingerprint, 16),
            path: [...m.cosigner.path, branch, index],
          },
        ] as [Uint8Array, { fingerprint: number; path: number[] }]
    );
  tx.addInput({
    txid: hex.encode(sha256(sha256(prev)).reverse()),
    index: 0,
    sequence: 0xfffffffd,
    nonWitnessUtxo: prev,
    witnessUtxo: { script: payment.payment.script, amount: 100_000n },
    ...payment.payment,
    bip32Derivation: origins(0, 7),
  });
  tx.addOutputAddress(DEST, 60_000n);
  tx.addOutput({
    ...deriveMultisig(policy, 1, 0).payment,
    amount: 39_000n,
    bip32Derivation: origins(1, 0),
  });
  const key = (n: number) =>
    keys[n].derive(formatPath(cs[n].path)).deriveChild(0).deriveChild(7)
      .privateKey!;
  return { policy, own, cs, tx, key, descriptor };
}
function rawSignature(digest: Uint8Array, key: Uint8Array) {
  return hex.encode(
    secp256k1.sign(digest, key, { prehash: false }).toDERRawBytes()
  );
}
describe("multisig policy", () => {
  test("BIP380 checksum known vector", () =>
    expect(descriptorChecksum("raw(deadbeef)")).toBe("89f8spxm"));
  for (const type of ["p2wsh", "p2sh-p2wsh", "p2sh"] as const)
    for (const sorted of [true, false])
      test(`${type} ${
        sorted ? "sorted" : "preserved"
      } strict descriptor roundtrip`, () => {
        const { policy, descriptor } = fixture(type, sorted);
        expect(parseMultisigPolicy(policy.descriptor)).toEqual(policy);
        expect(parseMultisigPolicy(descriptor)).toEqual(policy);
        expect(deriveMultisig(policy, 0, 0).address).toMatch(
          type === "p2wsh" ? /^bc1q/ : /^3/
        );
        expect(exportCosigner(policy.cosigners[0], type)).toContain(
          type === "p2wsh" ? "Zpub" : type === "p2sh-p2wsh" ? "Ypub" : "xpub"
        );
        expect(() =>
          parseMultisigPolicy(policy.descriptor.slice(0, -1) + "q")
        ).toThrow("checksum");
      });
  test("refuses omitted/reordered branches, missing origins, duplicates, private and wrong-network keys", () => {
    const { descriptor, cs } = fixture();
    expect(() =>
      parseMultisigPolicy(descriptor.replace("/<0;1>/*", "/1/*"))
    ).toThrow("branches");
    expect(() =>
      parseMultisigPolicy(descriptor.replace(/\[[^\]]+\]/, ""))
    ).toThrow("Each cosigner");
    expect(() =>
      parseMultisigPolicy(descriptor.replace(cs[1].xpub, cs[0].xpub))
    ).toThrow();
    expect(() =>
      parseMultisigPolicy(
        descriptor.replace(
          cs[0].xpub,
          masters[0].derive(formatPath(cs[0].path)).privateExtendedKey
        )
      )
    ).toThrow();
    expect(() =>
      parseMultisigPolicy(descriptor.replace("/48h/0h/", "/48h/1h/"))
    ).toThrow("origin");
    expect(() =>
      parseMultisigPolicy(
        descriptor.replace("sortedmulti(2,", "sortedmulti(4,")
      )
    ).toThrow("threshold");
    expect(() =>
      parseMultisigPolicy(descriptor.replace("/<0;1>/*", "/<1;0>/*"))
    ).toThrow();
  });
  test("imports public Electrum multisig metadata and refuses seed wallets", () => {
    const { policy, cs } = fixture();
    const wallet: any = { wallet_type: "2of3" };
    cs.forEach(
      (c, i) =>
        (wallet[`x${i + 1}/`] = {
          xpub: exportCosigner(c, "p2wsh").split("]")[1],
          root_fingerprint: c.fingerprint,
          derivation: formatPath(c.path),
          type: "hardware",
        })
    );
    expect(parseMultisigPolicy(JSON.stringify(wallet)).id).toBe(policy.id);
    wallet["x2/"].xprv = "secret";
    expect(() => parseMultisigPolicy(JSON.stringify(wallet))).toThrow(
      "private"
    );
  });
});
describe("multisig co-signing", () => {
  for (const type of ["p2wsh", "p2sh-p2wsh", "p2sh"] as const)
    for (const sorted of [true, false])
      test(`${type} ${
        sorted ? "sorted" : "preserved"
      } adds verified signature, retains earlier signer, finalizes only at quorum`, () => {
        const f = fixture(type, sorted),
          unsigned = f.tx.toPSBT(),
          a = analyzeMultisig(unsigned, f.policy, f.own);
        expect(a.fee).toBe(1000n);
        expect(a.change).toBe(39_000n);
        expect(a.deviceTotal).toBe(61_000n);
        const req = multisigToSignTx(a);
        expect(req.inputs[0].sequence).toBe(0xfffffffd);
        expect(req.locktime).toBe(500_000);
        expect(req.outputs[1]).toMatchObject({
          isChange: true,
          multisig: { m: 2 },
        });
        const first = applyMultisigSignatures(a, [
          rawSignature(a.inputs[0].digest, f.key(0)),
        ]);
        expect(first.complete).toBe(false);
        expect(first.txHex).toBeNull();
        expect(() => parseForBroadcast(first.psbtBytes)).toThrow(
          "not fully signed"
        );
        const fromDesktop = btc.Transaction.fromPSBT(first.psbtBytes);
        expect(fromDesktop.getInput(0).partialSig?.length).toBe(1);
        expect(() => analyzeMultisig(first.psbtBytes, f.policy, f.own)).toThrow(
          "already has"
        );
        fromDesktop.sign(f.key(1));
        const all = parseForBroadcast(fromDesktop.toPSBT());
        expect(all.fee).toBe(1000n);
        f.tx.sign(f.key(1));
        const before = RawPSBTV0.decode(f.tx.toPSBT()).inputs[0].partialSig!;
        const b = analyzeMultisig(f.tx.toPSBT(), f.policy, f.own),
          second = applyMultisigSignatures(b, [
            rawSignature(b.inputs[0].digest, f.key(0)),
          ]);
        expect(second.complete).toBe(true);
        expect(second.txid).toBe(all.txid);
        const after = RawPSBTV0.decode(second.psbtBytes).inputs[0].partialSig!;
        expect(
          after.find(([key]) => hex.encode(key) === hex.encode(before[0][0]))
        ).toEqual(before[0]);
        // Firmware appends sighash itself: the existing signature slot is bare DER.
        const previousSig = b.inputs[0].multisig.signatures.find(
          (s) => s.length
        )!;
        expect(previousSig.length / 2).toBe(before[0][1].length - 1);
      });
  test("refuses witness-only amounts, wrong previous tx, hostile change and existing signatures", () => {
    const f = fixture(),
      raw = RawPSBTV0.decode(f.tx.toPSBT());
    const check = (mutate: (r: typeof raw) => void) => {
      const r = RawPSBTV0.decode(f.tx.toPSBT());
      mutate(r);
      return () => analyzeMultisig(RawPSBTV0.encode(r), f.policy, f.own);
    };
    expect(
      check((r) => {
        r.inputs[0].nonWitnessUtxo = undefined;
      })
    ).toThrow("full previous");
    expect(
      check((r) => {
        r.inputs[0].witnessUtxo!.amount = 100_001n;
      })
    ).toThrow(/different|disagrees/);
    expect(
      check((r) => {
        r.inputs[0].sighashType = btc.SigHash.NONE;
      })
    ).toThrow("SIGHASH_ALL");
    expect(
      check((r) => {
        r.outputs[1].bip32Derivation![0][1].path[5] = 999;
      })
    ).toThrow();
    expect(
      check((r) => {
        r.inputs[0].bip32Derivation![0][1].fingerprint = 0;
      })
    ).toThrow();
    f.tx.sign(f.key(1));
    const signed = RawPSBTV0.decode(f.tx.toPSBT());
    signed.inputs[0].partialSig![0][1][10] ^= 1;
    expect(() =>
      analyzeMultisig(RawPSBTV0.encode(signed), f.policy, f.own)
    ).toThrow("signature is invalid");
  });
  test("rejects a wrong or modified device signature without exporting any new PSBT", () => {
    const f = fixture(),
      a = analyzeMultisig(f.tx.toPSBT(), f.policy, f.own);
    expect(() => applyMultisigSignatures(a, [])).toThrow("number");
    expect(() =>
      applyMultisigSignatures(a, [rawSignature(a.inputs[0].digest, f.key(2))])
    ).toThrow("does not verify");
    expect(() => applyMultisigSignatures(a, ["00"])).toThrow("malformed");
  });
  test("preserves unknown/proprietary PSBT maps and distinguishes script order", () => {
    const f = fixture(),
      raw = RawPSBTV0.decode(f.tx.toPSBT());
    raw.global.unknown = [
      [{ type: 250, key: new Uint8Array([1, 2]) }, new Uint8Array([3, 4])],
    ];
    raw.inputs[0].unknown = [
      [{ type: 251, key: new Uint8Array([4]) }, new Uint8Array([5])],
    ];
    const a = analyzeMultisig(RawPSBTV0.encode(raw), f.policy, f.own),
      result = applyMultisigSignatures(a, [
        rawSignature(a.inputs[0].digest, f.key(0)),
      ]);
    const after = RawPSBTV0.decode(result.psbtBytes);
    expect(after.global.unknown).toEqual(raw.global.unknown);
    expect(after.inputs[0].unknown).toEqual(raw.inputs[0].unknown);
  });
});

test("two-input signing validates every returned signature before adding any", () => {
  const f = fixture();
  const tx = btc.Transaction.fromPSBT(f.tx.toPSBT());
  const second = tx.getInput(0);
  // Same previous transaction, distinct output index with the same multisig script.
  const prev = btc.RawTx.decode(btc.RawTx.encode(second.nonWitnessUtxo!));
  prev.outputs.push({ ...prev.outputs[0] });
  const prevBytes = btc.RawTx.encode(prev),
    txid = hex.encode(sha256(sha256(prevBytes)).reverse());
  const two = new btc.Transaction({ version: 2, lockTime: 500_000 });
  two.addInput({ ...second, txid, nonWitnessUtxo: prevBytes });
  two.addInput({ ...second, txid, index: 1, nonWitnessUtxo: prevBytes });
  for (let i = 0; i < tx.outputsLength; i++) two.addOutput(tx.getOutput(i));
  const a = analyzeMultisig(two.toPSBT(), f.policy, f.own);
  const sigs = a.inputs.map((input) => rawSignature(input.digest, f.key(0)));
  expect(applyMultisigSignatures(a, sigs).signedCounts).toEqual([1, 1]);
  expect(() => applyMultisigSignatures(a, [sigs[0], sigs[0]])).toThrow(
    "does not verify"
  );
  expect(
    RawPSBTV0.decode(a.psbtBytes).inputs.every((i) => !i.partialSig?.length)
  ).toBe(true);
});

test("duplicate outpoints cannot inflate the reviewed input total and fee", () => {
  const f = fixture(),
    tx = btc.Transaction.fromPSBT(f.tx.toPSBT());
  tx.addInput(tx.getInput(0));
  expect(() => analyzeMultisig(tx.toPSBT(), f.policy, f.own)).toThrow(
    /Duplicate|same coin/
  );
});


for(const [threshold,count] of [[1,2],[8,15]])test(`${threshold}-of-${count} policy supports its full origin count and quorum`,()=>{
 const f=fixture('p2wsh',true,threshold,count),a=analyzeMultisig(f.tx.toPSBT(),f.policy,f.own)
 expect(a.inputs[0].multisig.pubkeys.length).toBe(count)
 const signed=applyMultisigSignatures(a,[rawSignature(a.inputs[0].digest,f.key(0))])
 expect(signed.complete).toBe(threshold===1)
 const tx=btc.Transaction.fromPSBT(signed.psbtBytes)
 for(let i=1;i<threshold;i++)tx.sign(f.key(i))
 expect(parseForBroadcast(tx.toPSBT()).fee).toBe(1000n)
})
