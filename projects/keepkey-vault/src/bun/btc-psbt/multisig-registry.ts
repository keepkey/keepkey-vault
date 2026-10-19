/** Public policy persistence. Hidden-wallet policies live only in the current session. */
import { parseMultisigPolicy } from "./multisig-policy";
export interface SavedMultisigPolicy {
  name: string;
  descriptor: string;
  fingerprint: string;
  xpub: string;
  verifiedAt: number;
}
const SETTING = "btc_multisig_policies_v1";
export class MultisigRegistry {
  private hidden = { epoch: -1, records: [] as SavedMultisigPolicy[] };
  constructor(
    private readonly get: (key: string) => string | null | undefined,
    private readonly set: (key: string, value: string) => void,
    private readonly context: () => { hidden: boolean; epoch: number }
  ) {}
  private validate(records: unknown): SavedMultisigPolicy[] {
    if (!Array.isArray(records) || records.length > 32)
      throw new Error(
        "Saved multisig policy data is invalid (maximum 32 policies)"
      );
    return records.map((r) => {
      if (
        !r ||
        typeof r.name !== "string" ||
        r.name.length > 40 ||
        typeof r.descriptor !== "string" ||
        typeof r.fingerprint !== "string" ||
        typeof r.xpub !== "string" ||
        !Number.isSafeInteger(r.verifiedAt) ||
        r.verifiedAt <= 0
      )
        throw new Error("Saved multisig policy data is invalid");
      const policy = parseMultisigPolicy(r.descriptor);
      if (
        !policy.cosigners.some(
          (c) => c.fingerprint === r.fingerprint && c.xpub === r.xpub
        )
      )
        throw new Error("Saved multisig policy has no matching enrolled key");
      return {
        name: r.name,
        descriptor: policy.descriptor,
        fingerprint: r.fingerprint,
        xpub: r.xpub,
        verifiedAt: r.verifiedAt,
      };
    });
  }
  read(): SavedMultisigPolicy[] {
    const context = this.context();
    // Forget hidden records when any session changes, even during a normal session.
    if (context.epoch !== this.hidden.epoch)
      this.hidden = { epoch: context.epoch, records: [] };
    if (context.hidden) return this.validate(this.hidden.records);
    const text = this.get(SETTING);
    if (!text) return [];
    if (text.length > 2_000_000)
      throw new Error("Saved multisig policy data exceeds its size limit");
    return this.validate(JSON.parse(text));
  }
  write(records: SavedMultisigPolicy[]): void {
    const valid = this.validate(records),
      context = this.context();
    if (context.hidden) {
      this.hidden = { epoch: context.epoch, records: valid };
      return;
    }
    const value = JSON.stringify(valid);
    this.set(SETTING, value);
    if (this.get(SETTING) !== value)
      throw new Error("Could not save the multisig policy");
  }
}
