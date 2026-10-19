/** Opt-in synthetic multisig hardware proof. Public keys only; never broadcasts. */
import { Keyring, Events } from "@keepkey/hdwallet-core";
import { NodeWebUSBKeepKeyAdapter } from "@keepkey/hdwallet-keepkey-nodewebusb";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  masterFingerprintFromDepth1Xpub,
  formatPath,
} from "../src/bun/btc-psbt/codec";
import {
  standardMultisigXpub,
  parseMultisigPolicy,
  multisigAccountPath,
  cosignerKey,
  deriveMultisig,
} from "../src/bun/btc-psbt/multisig-policy";
import {
  analyzeMultisig,
  multisigToSignTx,
  applyMultisigSignatures,
  firmwareMultisigType,
} from "../src/bun/btc-psbt/multisig-cosign";
import { parseForBroadcast } from "../src/bun/btc-psbt/psbt";
const dir = process.env.BTC_MULTISIG_EVIDENCE_DIR;
if (!dir)
  throw Error("Set BTC_MULTISIG_EVIDENCE_DIR (public wallet data stays local)");
mkdirSync(dir, { recursive: true });
const keepAlive = setInterval(() => {}, 1000);
const wallet = await NodeWebUSBKeepKeyAdapter.useKeyring(
  new Keyring()
).pairDevice();
if (!wallet) throw Error("No KeepKey connected");
let confirmations = 0;
wallet.transport.on(String(Events.BUTTON_REQUEST), () =>
  console.log("KeepKey confirmation", ++confirmations)
);
for (const event of [Events.PIN_REQUEST, Events.PASSPHRASE_REQUEST])
  wallet.transport.on(String(event), () => {
    console.error("Unlock the standard wallet in Desktop first");
    process.exit(2);
  });
try {
  const f: any = await wallet.getFeatures();
  console.log(
    JSON.stringify({
      firmware: `${f.majorVersion}.${f.minorVersion}.${f.patchVersion}`,
      initialized: f.initialized,
      pinCached: f.pinCached,
    })
  );
  const [root] = await wallet.getPublicKeys([
    {
      coin: "Bitcoin",
      addressNList: [44 + 0x80000000],
      scriptType: "p2pkh" as any,
      showDisplay: false,
    },
  ]);
  const fingerprint = hex.encode(masterFingerprintFromDepth1Xpub(root!.xpub!));
  console.log("Master fingerprint read");
  const reports: any[] = [];
  for (const type of ["p2wsh", "p2sh-p2wsh", "p2sh"] as const) {
    const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
    if (only && only !== type) continue;
    const path = multisigAccountPath(type),
      scriptType = firmwareMultisigType(type);
    const [pub] = await wallet.getPublicKeys([
      {
        coin: "Bitcoin",
        addressNList: path,
        scriptType: scriptType as any,
        showDisplay: false,
      },
    ]);
    const self = { fingerprint, path, xpub: standardMultisigXpub(pub!.xpub!) };
    console.log(type + ": cosigner public key read");
    const masters = [2, 3].map((n) =>
      HDKey.fromMasterSeed(new Uint8Array(32).fill(n))
    );
    const cosigners = [
      self,
      ...masters.map((k) => ({
        fingerprint: k.fingerprint.toString(16).padStart(8, "0"),
        path,
        xpub: k.derive(formatPath(path)).publicExtendedKey,
      })),
    ];
    const inner = `sortedmulti(2,${cosigners
      .map((c) => cosignerKey(c) + "/<0;1>/*")
      .join(",")})`;
    const policy = parseMultisigPolicy(
      type === "p2wsh"
        ? `wsh(${inner})`
        : type === "p2sh-p2wsh"
        ? `sh(wsh(${inner}))`
        : `sh(${inner})`
    );
    const signer = policy.cosigners.findIndex((c) => c.xpub === self.xpub);
    const addresses = [];
    for (const [branch, index] of [
      [0, 0],
      [0, 1],
      [0, 7],
      [1, 0],
    ]) {
      const derived = deriveMultisig(policy, branch, index);
      const got = await wallet.btcGetAddress({
        coin: "Bitcoin",
        addressNList: [...path, branch, index],
        scriptType: scriptType as any,
        showDisplay: false,
        multisig: derived.multisig,
      });
      if (got !== derived.address)
        throw Error(
          `${type} ${branch}/${index}: device returned a different multisig address`
        );
      addresses.push({ branch, index, address: got });
    }
    writeFileSync(
      join(dir, `${type}-policy.json`),
      JSON.stringify(
        {
          format: "keepkey-multisig-policy",
          version: 1,
          descriptor: policy.descriptor,
        },
        null,
        2
      )
    );
    console.log(`${type}: four multisig addresses match the KeepKey`);
    const payment = deriveMultisig(policy, 0, 0),
      change = deriveMultisig(policy, 1, 0);
    const prev = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      lockTime: 0,
      witnesses: undefined,
      inputs: [
        {
          txid: sha256(
            new TextEncoder().encode("KeepKey synthetic multisig QA " + type)
          ),
          index: 0,
          sequence: 0xffffffff,
          finalScriptSig: new Uint8Array(),
        },
      ],
      outputs: [{ script: payment.payment.script, amount: 100_000n }],
    });
    const tx = new btc.Transaction({ version: 2, lockTime: 0 });
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
      bip32Derivation: origins(0, 0),
    });
    const recipient = btc.p2wpkh(
      masters[0].deriveChild(
        type === "p2wsh" ? 99 : type === "p2sh-p2wsh" ? 100 : 101
      ).publicKey!
    ).address!;
    tx.addOutputAddress(recipient, 60_000n);
    tx.addOutput({
      ...change.payment,
      amount: 39_000n,
      bip32Derivation: origins(1, 0),
    });
    const unsigned = tx.toPSBT();
    writeFileSync(join(dir, `${type}-unsigned.psbt`), unsigned);
    const report: any = {
      type,
      fingerprint,
      path: formatPath(path),
      addresses,
      fee: "1000",
      deviceTotal: "61000",
      signed: false,
      broadcast: false,
    };
    if (process.argv.includes("--sign")) {
      // Add one public test cosigner first. The device must preserve that DER signature.
      tx.sign(
        masters[0].derive(formatPath(path)).deriveChild(0).deriveChild(0)
          .privateKey!
      );
      const analysis = analyzeMultisig(tx.toPSBT(), policy, signer);
      console.log(
        `${type}: SYNTHETIC 60000-sat recipient ${recipient}; 39000-sat change; 61000-sat total, 1000-sat fee. No real funding exists.`
      );
      confirmations = 0;
      const result = await wallet.btcSignTx(multisigToSignTx(analysis) as any);
      const signed = applyMultisigSignatures(analysis, result!.signatures);
      if (!signed.complete) throw Error("Expected 2-of-3 quorum");
      writeFileSync(join(dir, `${type}-cosigned.psbt`), signed.psbtBytes);
      const final = parseForBroadcast(signed.psbtBytes);
      if (final.fee !== 1000n) throw Error("Fee changed");
      Object.assign(report, { signed: true, txid: final.txid, confirmations });
      console.log(
        `${type}: KeepKey signature independently verified, earlier cosigner retained, quorum finalized. Confirmations: ${confirmations}.`
      );
    }
    reports.push(report);
    writeFileSync(
      join(dir, "hardware-report.json"),
      JSON.stringify(reports, null, 2)
    );
  }
} finally {
  await wallet.disconnect();
  clearInterval(keepAlive);
}
