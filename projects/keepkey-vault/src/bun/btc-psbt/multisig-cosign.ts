/** Hostile PSBT -> one enrolled KeepKey cosigner -> verified partial PSBT. */
import * as btc from "@scure/btc-signer";
import { RawPSBTV0 } from "@scure/btc-signer/psbt";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  decode,
  prevOut,
  checkAmount,
  scriptToAddress,
  opReturnData,
  printable,
  legacySighash,
  parseForBroadcast,
  type PsbtAnalysis,
  type AnalyzedInput,
  type AnalyzedOutput,
} from "./psbt";
import {
  deriveMultisig,
  type MultisigPolicy,
  type MultisigScriptType,
} from "./multisig-policy";

const eq = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  !!a && !!b && hex.encode(a) === hex.encode(b);
const fp = (value: string) => parseInt(value, 16);
const countSize = (n: number) => (n < 253 ? 1 : n <= 65535 ? 3 : 5);
const pushSize = (n: number) => (n < 76 ? 1 : n < 256 ? 2 : 3);
export const firmwareMultisigType = (type: MultisigScriptType) =>
  type === "p2wsh" ? "p2wpkh" : type === "p2sh-p2wsh" ? "p2sh-p2wpkh" : "p2sh";
type Input = ReturnType<btc.Transaction["getInput"]>;
type Output = ReturnType<btc.Transaction["getOutput"]>;
export interface MultisigInput extends Omit<AnalyzedInput, "scriptType"> {
  scriptType: MultisigScriptType;
  branch: number;
  index: number;
  digest: Uint8Array;
  multisig: ReturnType<typeof deriveMultisig>["multisig"];
  signatures: number;
}
type MultisigOutput = Omit<AnalyzedOutput, "owner"> & {
  owner?: { accountPath: number[]; addressNList: number[] };
};
export interface MultisigAnalysis
  extends Omit<PsbtAnalysis, "inputs" | "outputs"> {
  outputs: MultisigOutput[];
  multisig: {
    policy: MultisigPolicy;
    signerIndex: number;
    fingerprint: string;
  };
  inputs: MultisigInput[];
}
export function isMultisigPsbt(input: Uint8Array | string): boolean {
  const d = decode(input, 15);
  if (d.kind !== "psbt") return false;
  for (let i = 0; i < d.tx.inputsLength; i++) {
    const data = d.tx.getInput(i),
      script = data.witnessScript ?? data.redeemScript;
    if (script) {
      try {
        if (btc.OutScript.decode(script).type === "ms") return true;
      } catch {
        /* analysis rejects malformed scripts */
      }
    }
  }
  return false;
}
function locate(policy: MultisigPolicy, data: Input | Output) {
  const origins = data.bip32Derivation ?? [];
  if (origins.length !== policy.cosigners.length)
    throw new Error("Include every cosigner key origin in this multisig PSBT");
  const first = origins[0][1],
    member = policy.cosigners.find(
      (c) => fp(c.fingerprint) === first.fingerprint
    );
  if (
    !member ||
    first.path.length !== member.path.length + 2 ||
    !member.path.every((p, i) => p === first.path[i])
  )
    throw new Error("PSBT cosigner origin does not match the imported policy");
  const [branch, index] = first.path.slice(-2),
    derived = deriveMultisig(policy, branch, index);
  for (const [key, origin] of origins) {
    const item = derived.members.find((m) => eq(m.pubkey, key));
    if (
      !item ||
      origin.fingerprint !== fp(item.cosigner.fingerprint) ||
      origin.path.length !== item.cosigner.path.length + 2 ||
      !item.cosigner.path.every((p, i) => p === origin.path[i]) ||
      origin.path.at(-2) !== branch ||
      origin.path.at(-1) !== index
    )
      throw new Error(
        "PSBT public key, fingerprint or path conflicts with the imported multisig policy"
      );
  }
  if (policy.scriptType === "p2sh") {
    if (data.witnessScript || !eq(data.redeemScript, derived.script))
      throw new Error(
        "Legacy multisig redeem script does not match the policy"
      );
  } else {
    if (!eq(data.witnessScript, derived.script))
      throw new Error("Multisig witness script does not match the policy");
    if (
      policy.scriptType === "p2sh-p2wsh"
        ? !eq(
            data.redeemScript,
            btc.p2wsh(
              btc.p2ms(
                policy.threshold,
                derived.members.map((m) => m.pubkey)
              )
            ).script
          )
        : data.redeemScript !== undefined
    )
      throw new Error("Multisig wrapper does not match the policy");
  }
  return { branch, index, ...derived };
}
export function matchesMultisigPolicy(
  input: Uint8Array,
  policy: MultisigPolicy
): boolean {
  try {
    const d = decode(input, 15);
    if (d.kind !== "psbt" || !d.tx.inputsLength) return false;
    locate(policy, d.tx.getInput(0));
    return true;
  } catch {
    return false;
  }
}
function verify(sig: Uint8Array, digest: Uint8Array, key: Uint8Array): boolean {
  if (sig.length < 9 || sig.length > 73 || sig.at(-1) !== btc.SigHash.ALL)
    return false;
  try {
    return secp256k1.verify(sig.subarray(0, -1), digest, key, {
      prehash: false,
      format: "der",
      lowS: true,
    });
  } catch {
    return false;
  }
}
export function analyzeMultisig(
  input: Uint8Array | string,
  policy: MultisigPolicy,
  signerIndex: number
): MultisigAnalysis {
  const d = decode(input, 15);
  if (d.kind !== "psbt" || !d.tx.inputsLength || !d.tx.outputsLength)
    throw new Error("Expected a nonempty multisig PSBT");
  const tx = d.tx,
    own = policy.cosigners[signerIndex];
  if (!own) throw new Error("The connected KeepKey is not a cosigner");
  const inputs: MultisigInput[] = [];
  const outpoints = new Set<string>();
  for (let i = 0; i < tx.inputsLength; i++) {
    const data = tx.getInput(i);
    const outpoint = `${hex.encode(data.txid!)}:${data.index}`;
    if (outpoints.has(outpoint))
      throw new Error("Duplicate multisig input outpoint");
    outpoints.add(outpoint);
    if (
      data.finalScriptSig?.length ||
      data.finalScriptWitness?.length ||
      data.tapKeySig ||
      data.tapScriptSig?.length
    )
      throw new Error(
        `Input #${i} is finalized or uses an unsupported signature type`
      );
    if (data.sighashType !== undefined && data.sighashType !== btc.SigHash.ALL)
      throw new Error("Multisig co-signing requires SIGHASH_ALL");
    const located = locate(policy, data),
      previous = prevOut(tx, i);
    if (!previous.verified)
      throw new Error(
        `Input #${i}: include the full previous transaction to verify its amount and fee before offline co-signing`
      );
    if (!eq(previous.script, located.payment.script))
      throw new Error(
        `Input #${i}: previous output script does not match this multisig policy`
      );
    const ourKey = located.members.find((m) => m.cosigner === own)!.pubkey;
    const digest =
      policy.scriptType === "p2sh"
        ? legacySighash(tx, i, located.script)
        : tx.preimageWitnessV0(
            i,
            located.script,
            btc.SigHash.ALL,
            previous.amount
          );
    const sigs = data.partialSig ?? [];
    for (const [key, sig] of sigs) {
      if (
        !located.members.some((m) => eq(m.pubkey, key)) ||
        !verify(sig, digest, key)
      )
        throw new Error(
          `Input #${i}: an existing cosigner signature is invalid`
        );
      if (eq(key, ourKey))
        throw new Error(
          `Input #${i} already has this KeepKey's signature; return the PSBT to your coordinator`
        );
    }
    if (sigs.length >= policy.threshold)
      throw new Error(
        `Input #${i} already has its required signatures; finalize it in the coordinator`
      );
    const multisig = {
      ...located.multisig,
      signatures: located.members.map((m) => {
        const s = sigs.find(([key]) => eq(key, m.pubkey));
        return s ? hex.encode(s[1].subarray(0, -1)) : "";
      }),
    };
    inputs.push({
      txid: hex.encode(data.txid!),
      vout: data.index!,
      sequence: data.sequence!,
      amount: previous.amount,
      amountVerified: true,
      scriptType: policy.scriptType,
      accountPath: own.path,
      addressNList: [...own.path, located.branch, located.index],
      address: located.address,
      pubkey: ourKey,
      prevTxHex: previous.prevTxHex,
      branch: located.branch,
      index: located.index,
      digest,
      multisig,
      signatures: sigs.length,
    });
  }
  const outputs: MultisigOutput[] = [];
  let changeTaken = false;
  for (let i = 0; i < tx.outputsLength; i++) {
    const data = tx.getOutput(i),
      script = data.script!,
      amount = checkAmount(data.amount!, `Output #${i}`),
      base = { index: i, amount, scriptHex: hex.encode(script) };
    if (script[0] === 0x6a) {
      const op = opReturnData(script);
      if (!op || amount !== 0n)
        throw new Error("Unsupported or funded OP_RETURN output");
      outputs.push({
        ...base,
        opReturn: { hex: hex.encode(op), text: printable(op) },
        kind: "op-return",
        deviceWillShow: "op-return",
      });
      continue;
    }
    const address = scriptToAddress(script);
    const claims = (data.bip32Derivation ?? []).some(([, origin]) =>
      policy.cosigners.some((c) => fp(c.fingerprint) === origin.fingerprint)
    );
    if (!claims) {
      outputs.push({
        ...base,
        address,
        kind: "payment",
        deviceWillShow: "address",
      });
      continue;
    }
    const located = locate(policy, data);
    if (!eq(script, located.payment.script))
      throw new Error(
        `Output #${i}: claimed multisig change pays a different script`
      );
    const maxIndex = Math.max(
      0,
      ...inputs.filter((x) => x.branch === located.branch).map((x) => x.index)
    );
    const hidden =
      !changeTaken &&
      amount > 0n &&
      located.index <= Math.min(maxIndex + 1000, 1_000_000);
    if (hidden) changeTaken = true;
    outputs.push({
      ...base,
      address,
      kind: hidden ? "change" : "own",
      deviceWillShow: hidden ? "hidden-change" : "address",
      owner: {
        accountPath: own.path,
        addressNList: [...own.path, located.branch, located.index],
      },
    });
  }
  const totalIn = checkAmount(
      inputs.reduce((s, x) => s + x.amount, 0n),
      "Total input"
    ),
    totalOut = checkAmount(
      outputs.reduce((s, x) => s + x.amount, 0n),
      "Total output"
    ),
    fee = totalIn - totalOut;
  if (fee < 0n) throw new Error("Outputs spend more than the inputs");
  const change = outputs
      .filter((x) => x.kind === "change")
      .reduce((s, x) => s + x.amount, 0n),
    sent = totalOut - change;
  const baseBytes = btc.RawTx.encode({
    version: tx.version,
    segwitFlag: false,
    lockTime: tx.lockTime,
    witnesses: undefined,
    inputs: inputs.map((x) => ({
      txid: hex.decode(x.txid),
      index: x.vout,
      sequence: x.sequence,
      finalScriptSig: new Uint8Array(),
    })),
    outputs: outputs.map((o) => ({
      amount: o.amount,
      script: hex.decode(o.scriptHex),
    })),
  }).length;
  let weight = baseBytes * 4 + (policy.scriptType === "p2sh" ? 0 : 2);
  for (const item of inputs) {
    const len = deriveMultisig(policy, item.branch, item.index).script.length;
    if (policy.scriptType === "p2sh") {
      const scriptLen = 1 + policy.threshold * 74 + pushSize(len) + len;
      weight += (scriptLen + countSize(scriptLen) - 1) * 4;
    } else {
      weight +=
        countSize(policy.threshold + 2) +
        1 +
        policy.threshold * 74 +
        countSize(len) +
        len;
      if (policy.scriptType === "p2sh-p2wsh") weight += 35 * 4;
    }
  }
  const estVsize = Math.ceil(weight / 4);
  return {
    multisig: { policy, signerIndex, fingerprint: own.fingerprint },
    psbtBytes: d.bytes,
    version: tx.version,
    locktime: tx.lockTime,
    inputs,
    outputs,
    totalIn,
    totalOut,
    fee,
    change,
    sent,
    deviceTotal: totalIn - change,
    estVsize,
    satPerVbyte: Math.round((Number(fee) * 100) / estVsize) / 100,
    feePercent: sent ? Number((fee * 10000n) / sent) / 100 : null,
    flags: {
      nonZeroLocktime: tx.lockTime !== 0,
      rbf: inputs.some((x) => x.sequence < 0xfffffffe),
      unusualVersion: tx.version !== 1 && tx.version !== 2,
      noChange: !changeTaken,
      multiAccount: false,
      unverifiedAmounts: false,
      ownOutputShown: outputs.some((x) => x.kind === "own"),
    },
  };
}
export function multisigToSignTx(a: MultisigAnalysis) {
  const { policy } = a.multisig;
  return {
    coin: "Bitcoin",
    version: a.version,
    locktime: a.locktime,
    inputs: a.inputs.map((x) => ({
      addressNList: x.addressNList,
      scriptType: firmwareMultisigType(x.scriptType),
      amount: x.amount.toString(),
      vout: x.vout,
      txid: x.txid,
      sequence: x.sequence,
      hex: x.prevTxHex,
      multisig: x.multisig,
    })),
    outputs: a.outputs.map((o) => {
      if (o.deviceWillShow === "hidden-change") {
        const path = o.owner!.addressNList;
        return {
          addressNList: path,
          scriptType: firmwareMultisigType(policy.scriptType),
          amount: o.amount.toString(),
          isChange: true,
          addressType: "change",
          multisig: deriveMultisig(policy, path.at(-2)!, path.at(-1)!).multisig,
        };
      }
      if (o.opReturn)
        return {
          opReturnData: hex.decode(o.opReturn.hex),
          amount: "0",
          addressType: "spend",
        };
      return {
        address: o.address!,
        amount: o.amount.toString(),
        addressType: "spend",
      };
    }),
  };
}
/** Raw signatures are DER without sighash on the wire. Validate all before
 * changing any PSBT field; retain existing partial signatures and unknown maps. */
export function applyMultisigSignatures(
  a: MultisigAnalysis,
  signatures: string[]
) {
  if (!Array.isArray(signatures) || signatures.length !== a.inputs.length)
    throw new Error("KeepKey returned the wrong number of signatures");
  const newSignatures = a.inputs.map((input, i) => {
    const raw = hex.decode(signatures[i] ?? "");
    if (raw[0] !== 0x30 || raw.length < 8 || raw.length !== raw[1] + 2)
      throw new Error(`Input #${i}: KeepKey returned malformed DER`);
    const signature = new Uint8Array([...raw, btc.SigHash.ALL]);
    if (!verify(signature, input.digest, input.pubkey))
      throw new Error(
        `Input #${i}: KeepKey signature does not verify against the reviewed transaction`
      );
    return [input.pubkey, signature] as [Uint8Array, Uint8Array];
  });
  const raw = RawPSBTV0.decode(a.psbtBytes);
  raw.inputs.forEach((data, i) => {
    data.partialSig = [...(data.partialSig ?? []), newSignatures[i]];
  });
  const psbtBytes = RawPSBTV0.encode(raw),
    signedCounts = a.inputs.map((x) => x.signatures + 1),
    complete = signedCounts.every((n) => n >= a.multisig.policy.threshold);
  const final = complete ? parseForBroadcast(psbtBytes) : null;
  return {
    psbtBytes,
    psbtBase64: base64.encode(psbtBytes),
    complete,
    txHex: final?.txHex ?? null,
    txid: final?.txid ?? null,
    signaturesAdded: newSignatures.length,
    signedCounts,
    threshold: a.multisig.policy.threshold,
    cosigners: a.multisig.policy.cosigners.length,
  };
}
