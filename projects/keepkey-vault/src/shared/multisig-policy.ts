export const MULTISIG_POLICY_EVENT = "keepkey-multisig-policy";
export const MULTISIG_ENROLLED_EVENT = "keepkey-multisig-enrolled";
export function looksLikeMultisigPolicy(text: string): boolean {
  const t = text.trimStart();
  if (/^(wsh|sh)\(/.test(t)) return true;
  return (
    t.startsWith("{") &&
    (/"format"\s*:\s*"keepkey-multisig-policy"/.test(t) ||
      /"wallet_type"\s*:\s*"\d+of\d+"/.test(t))
  );
}
export interface MultisigPolicyPreview {
  id: string;
  name: string;
  descriptor: string;
  scriptType: string;
  threshold: number;
  cosigners: Array<{
    fingerprint: string;
    path: string;
    xpub: string;
    ours: boolean;
  }>;
  address: string;
  saved: boolean;
  sessionOnly: boolean;
}
export interface MultisigCosignerExport {
  fingerprint: string;
  path: number[];
  xpub: string;
  key: string;
  scriptType: string;
  derivation: string;
  network: "bitcoin-mainnet";
}
export interface BtcPsbtSigned {
  filePath: string;
  psbtBase64: string;
  txHex: string | null;
  txid: string | null;
  complete: boolean;
  signaturesAdded?: number;
  threshold?: number;
  cosigners?: number;
  signedCounts?: number[];
}
