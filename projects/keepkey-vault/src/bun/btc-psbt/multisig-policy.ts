/** Public multisig policy and deterministic script derivation. No USB or network. */
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { b58check, parsePath, formatPath } from "./codec";

const H = 0x80000000;
export type MultisigScriptType = "p2wsh" | "p2sh-p2wsh" | "p2sh";
export interface Cosigner {
  fingerprint: string;
  path: number[];
  xpub: string;
}
export interface MultisigPolicy {
  id: string;
  descriptor: string;
  scriptType: MultisigScriptType;
  sorted: boolean;
  threshold: number;
  cosigners: Cosigner[];
  network: "bitcoin-mainnet";
}
const PUB = new Map([
  [0x0488b21e, "xpub"],
  [0x049d7cb2, "ypub"],
  [0x04b24746, "zpub"],
  [0x0295b43f, "Ypub"],
  [0x02aa7ed3, "Zpub"],
]);
const CHECKSUM_INPUT =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [
  0xf5dee51989n,
  0xa9fdca3312n,
  0x1bab10e32dn,
  0x3706b1677an,
  0x644d626ffdn,
];
export function descriptorChecksum(body: string): string {
  let c = 1n,
    cls = 0,
    count = 0;
  const step = (v: number) => {
    const top = c >> 35n;
    c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) c ^= GENERATOR[i];
  };
  for (const char of body) {
    const p = CHECKSUM_INPUT.indexOf(char);
    if (p < 0) throw new Error("Invalid descriptor character");
    step(p & 31);
    cls = cls * 3 + (p >> 5);
    if (++count === 3) {
      step(cls);
      cls = count = 0;
    }
  }
  if (count) step(cls);
  for (let i = 0; i < 8; i++) step(0);
  c ^= 1n;
  return Array.from(
    { length: 8 },
    (_, i) => CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - i))) & 31n)]
  ).join("");
}
export function standardMultisigXpub(key: string): string {
  const bytes = b58check.decode(key);
  if (
    bytes.length !== 78 ||
    !PUB.has(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)) ||
    (bytes[45] !== 2 && bytes[45] !== 3)
  )
    throw new Error(
      "Expected a mainnet extended public key; private and testnet keys are refused"
    );
  const normalized = bytes.slice();
  new DataView(normalized.buffer).setUint32(0, 0x0488b21e);
  const xpub = b58check.encode(normalized),
    node = HDKey.fromExtendedKey(xpub);
  if (node.privateKey) throw new Error("Never import a private key");
  return xpub;
}
export function multisigAccountPath(
  scriptType: MultisigScriptType,
  account = 0
): number[] {
  if (!Number.isInteger(account) || account < 0 || account > 100)
    throw new Error("Choose account 0–100");
  if (scriptType === "p2sh") return [48 + H, H, account + H];
  return [48 + H, H, account + H, (scriptType === "p2wsh" ? 2 : 1) + H];
}
function validateOrigin(c: Cosigner, type: MultisigScriptType) {
  const p = c.path,
    n = HDKey.fromExtendedKey(c.xpub);
  const bip48 =
    p.length === 4 &&
    p[0] === 48 + H &&
    p[1] === H &&
    p[2] >= H &&
    p[2] <= H + 100 &&
    p[3] === (type === "p2wsh" ? 2 : type === "p2sh-p2wsh" ? 1 : 0) + H;
  const bip45 =
    type === "p2sh" &&
    p[0] === 45 + H &&
    (p.length === 1 || (p.length === 2 && p[1] < H));
  const legacy48 =
    type === "p2sh" &&
    p.length === 3 &&
    p[0] === 48 + H &&
    p[1] === H &&
    p[2] >= H &&
    p[2] <= H + 100;
  if (
    (!bip48 && !bip45 && !legacy48) ||
    n.depth !== p.length ||
    n.index !== p[p.length - 1]
  )
    throw new Error(
      "Cosigner key, mainnet account origin and script type must agree (BIP48 or legacy BIP45)"
    );
}
export const cosignerKey = (c: Cosigner) =>
  `[${c.fingerprint}/${formatPath(c.path).slice(2).replace(/'/g, "h")}]${
    c.xpub
  }`;
export function exportCosigner(c: Cosigner, type: MultisigScriptType): string {
  validateOrigin(c, type);
  const bytes = b58check.decode(c.xpub).slice();
  new DataView(bytes.buffer).setUint32(
    0,
    type === "p2wsh"
      ? 0x02aa7ed3
      : type === "p2sh-p2wsh"
      ? 0x0295b43f
      : 0x0488b21e
  );
  return cosignerKey({ ...c, xpub: b58check.encode(bytes) });
}
function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("Policy JSON is too deeply nested");
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (
      /^(seed|xprv|private_key|private_keys|keypairs|mnemonic|privkey)$/i.test(
        k
      ) &&
      v !== null &&
      v !== undefined &&
      v !== ""
    )
      throw new Error(
        "Import public wallet metadata only; never a seed or private key"
      );
    rejectSecrets(v, depth + 1);
  }
}
export function parseMultisigPolicy(input: string): MultisigPolicy {
  if (typeof input !== "string" || input.length > 1_048_576)
    throw new Error("Multisig policy exceeds 1 MB");
  let text = input.trim();
  if (text.startsWith("{")) {
    const json = JSON.parse(text);
    rejectSecrets(json);
    if (
      json.format === "keepkey-multisig-policy" &&
      json.version === 1 &&
      typeof json.descriptor === "string"
    )
      text = json.descriptor.trim();
    else {
      const match = /^(\d+)of(\d+)$/.exec(String(json.wallet_type));
      if (!match)
        throw new Error(
          "Expected a multisig descriptor or public Electrum multisig wallet"
        );
      const threshold = Number(match[1]),
        n = Number(match[2]);
      if (n < 2 || n > 15) throw new Error("Multisig requires 2–15 cosigners");
      if (Object.keys(json).filter((k) => /^x\d+\/$/.test(k)).length !== n)
        throw new Error(
          "Electrum cosigner count does not match its wallet type"
        );
      let type: MultisigScriptType | undefined;
      const keys = Array.from({ length: n }, (_, i) => {
        const k = json[`x${i + 1}/`];
        if (
          !k ||
          typeof k.xpub !== "string" ||
          typeof k.derivation !== "string" ||
          !/^[a-f0-9]{8}$/i.test(k.root_fingerprint)
        )
          throw new Error(
            "Every Electrum cosigner needs its xpub, master fingerprint and full origin"
          );
        const bytes = b58check.decode(k.xpub),
          version = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
        const t: MultisigScriptType =
          version === 0x02aa7ed3
            ? "p2wsh"
            : version === 0x0295b43f
            ? "p2sh-p2wsh"
            : version === 0x0488b21e
            ? "p2sh"
            : (() => {
                throw new Error("Unsupported Electrum multisig key type");
              })();
        if (type && type !== t)
          throw new Error("Electrum cosigner script types disagree");
        type = t;
        return `[${k.root_fingerprint}/${k.derivation.replace(/^m\//, "")}]${
          k.xpub
        }/<0;1>/*`;
      });
      text = `sortedmulti(${threshold},${keys.join(",")})`;
      text =
        type === "p2wsh"
          ? `wsh(${text})`
          : type === "p2sh-p2wsh"
          ? `sh(wsh(${text}))`
          : `sh(${text})`;
    }
  }
  const parts = text.split("#");
  if (
    parts.length > 2 ||
    (parts[1] !== undefined && descriptorChecksum(parts[0]) !== parts[1])
  )
    throw new Error("Descriptor checksum mismatch");
  const body = parts[0];
  const scriptType: MultisigScriptType = body.startsWith("sh(wsh(")
    ? "p2sh-p2wsh"
    : body.startsWith("wsh(")
    ? "p2wsh"
    : body.startsWith("sh(")
    ? "p2sh"
    : (() => {
        throw new Error(
          "Use a P2WSH, wrapped P2WSH or legacy P2SH multisig descriptor"
        );
      })();
  const inner =
    scriptType === "p2sh-p2wsh"
      ? body.slice(7, -2)
      : scriptType === "p2wsh"
      ? body.slice(4, -1)
      : body.slice(3, -1);
  const multi = /^(sortedmulti|multi)\((\d+),(.+)\)$/.exec(inner);
  if (!multi)
    throw new Error(
      "Only explicit multi() and sortedmulti() policies are supported"
    );
  const threshold = Number(multi[2]),
    sorted = multi[1] === "sortedmulti",
    keys = multi[3].split(",");
  if (
    keys.length < 2 ||
    keys.length > 15 ||
    !Number.isInteger(threshold) ||
    threshold < 1 ||
    threshold > keys.length
  )
    throw new Error("Invalid multisig threshold; expected m of 2–15 cosigners");
  let suffix: string | undefined;
  const cosigners = keys.map((key) => {
    const m =
      /^\[([0-9a-fA-F]{8})\/([0-9hH'/]+)\]([1-9A-HJ-NP-Za-km-z]+)(\/(?:[01]\/\*|<0;1>\/\*|\*\*))$/.exec(
        key
      );
    if (!m)
      throw new Error(
        "Each cosigner needs [master-fingerprint/full-origin]xpub and matching /0/*, /1/* or /<0;1>/* branches"
      );
    if (suffix && suffix !== m[4])
      throw new Error("Cosigner receive/change branches must agree");
    suffix = m[4];
    const c = {
      fingerprint: m[1].toLowerCase(),
      path: parsePath("m/" + m[2]),
      xpub: standardMultisigXpub(m[3]),
    };
    validateOrigin(c, scriptType);
    return c;
  });
  if (
    new Set(cosigners.map((c) => c.xpub)).size !== keys.length ||
    new Set(cosigners.map((c) => c.fingerprint)).size !== keys.length
  )
    throw new Error(
      "Duplicate cosigner key or fingerprint; each cosigner must be distinct"
    );
  if (sorted)
    cosigners.sort((a, b) =>
      cosignerKey(a) < cosignerKey(b)
        ? -1
        : cosignerKey(a) > cosignerKey(b)
        ? 1
        : 0
    );
  const core = `${sorted ? "sortedmulti" : "multi"}(${threshold},${cosigners
    .map((c) => cosignerKey(c) + "/<0;1>/*")
    .join(",")})`;
  const normalized =
    scriptType === "p2wsh"
      ? `wsh(${core})`
      : scriptType === "p2sh-p2wsh"
      ? `sh(wsh(${core}))`
      : `sh(${core})`;
  const descriptor = normalized + "#" + descriptorChecksum(normalized);
  return {
    id: hex.encode(sha256(new TextEncoder().encode(descriptor))),
    descriptor,
    scriptType,
    sorted,
    threshold,
    cosigners,
    network: "bitcoin-mainnet",
  };
}
export function deriveMultisig(
  policy: MultisigPolicy,
  branch: number,
  index: number
) {
  if (
    (branch !== 0 && branch !== 1) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= H
  )
    throw new Error("Invalid public receive/change index");
  const members = policy.cosigners.map((c) => ({
    cosigner: c,
    pubkey: HDKey.fromExtendedKey(c.xpub).deriveChild(branch).deriveChild(index)
      .publicKey!,
  }));
  if (policy.sorted)
    members.sort((a, b) =>
      hex.encode(a.pubkey) < hex.encode(b.pubkey)
        ? -1
        : hex.encode(a.pubkey) > hex.encode(b.pubkey)
        ? 1
        : 0
    );
  const ms = btc.p2ms(
    policy.threshold,
    members.map((m) => m.pubkey)
  );
  const payment =
    policy.scriptType === "p2wsh"
      ? btc.p2wsh(ms)
      : policy.scriptType === "p2sh-p2wsh"
      ? btc.p2sh(btc.p2wsh(ms))
      : btc.p2sh(ms);
  return {
    members,
    script: ms.script,
    payment,
    address: payment.address!,
    multisig: {
      m: policy.threshold,
      pubkeys: members.map((m) => ({
        xpub: m.cosigner.xpub,
        addressNList: [branch, index],
      })),
      signatures: members.map(() => ""),
    },
  };
}
