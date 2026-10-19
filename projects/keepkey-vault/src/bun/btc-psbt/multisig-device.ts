/** Public-key ownership and an explicit on-device policy enrollment. */
import { hex } from "@scure/base";
import { masterFingerprintFromDepth1Xpub, formatPath } from "./codec";
import {
  deriveMultisig,
  standardMultisigXpub,
  multisigAccountPath,
  exportCosigner,
  type MultisigPolicy,
  type MultisigScriptType,
} from "./multisig-policy";
import { firmwareMultisigType } from "./multisig-cosign";

interface Device {
  getPublicKeys: (requests: any[]) => Promise<Array<{ xpub?: string } | null>>;
  btcGetAddress: (request: any) => Promise<string>;
}
export async function readMultisigFingerprint(wallet: Device): Promise<string> {
  const [key] = await wallet.getPublicKeys([
    {
      coin: "Bitcoin",
      addressNList: [44 + 0x80000000],
      scriptType: "p2pkh",
      curve: "secp256k1",
      showDisplay: false,
    },
  ]);
  if (!key?.xpub)
    throw new Error("KeepKey did not return its public fingerprint");
  return hex.encode(masterFingerprintFromDepth1Xpub(key.xpub));
}
export async function readMultisigCosigner(
  wallet: Device,
  scriptType: MultisigScriptType,
  account = 0
) {
  const path = multisigAccountPath(scriptType, account),
    fingerprint = await readMultisigFingerprint(wallet);
  const [key] = await wallet.getPublicKeys([
    {
      coin: "Bitcoin",
      addressNList: path,
      scriptType: firmwareMultisigType(scriptType),
      curve: "secp256k1",
      showDisplay: false,
    },
  ]);
  if (!key?.xpub)
    throw new Error("KeepKey did not return its public multisig key");
  const cosigner = { fingerprint, path, xpub: standardMultisigXpub(key.xpub) };
  return {
    ...cosigner,
    key: exportCosigner(cosigner, scriptType),
    scriptType,
    derivation: formatPath(path),
    network: "bitcoin-mainnet" as const,
  };
}
export async function matchMultisigDevice(
  wallet: Device,
  policy: MultisigPolicy,
  fingerprint?: string
): Promise<number> {
  const fp = fingerprint ?? (await readMultisigFingerprint(wallet)),
    index = policy.cosigners.findIndex((c) => c.fingerprint === fp);
  if (index < 0)
    throw new Error(
      "This KeepKey is not a cosigner of this policy. Check the device and passphrase."
    );
  const cosigner = policy.cosigners[index];
  const [actual] = await wallet.getPublicKeys([
    {
      coin: "Bitcoin",
      addressNList: cosigner.path,
      scriptType: firmwareMultisigType(policy.scriptType),
      curve: "secp256k1",
      showDisplay: false,
    },
  ]);
  if (!actual?.xpub || standardMultisigXpub(actual.xpub) !== cosigner.xpub)
    throw new Error(
      "The policy fingerprint matches, but its public key is not this KeepKey’s. Refusing."
    );
  return index;
}
export async function verifyMultisigPolicy(
  wallet: Device,
  policy: MultisigPolicy,
  signerIndex: number
): Promise<string> {
  const derived = deriveMultisig(policy, 0, 0),
    cosigner = policy.cosigners[signerIndex];
  if (!cosigner) throw new Error("No matching KeepKey cosigner");
  const address = await wallet.btcGetAddress({
    coin: "Bitcoin",
    addressNList: [...cosigner.path, 0, 0],
    scriptType: firmwareMultisigType(policy.scriptType),
    showDisplay: true,
    multisig: derived.multisig,
  });
  if (address !== derived.address)
    throw new Error(
      "KeepKey and Desktop derived different multisig addresses. Policy was not saved."
    );
  return address;
}
