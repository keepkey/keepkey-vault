/** Runtime Settings flag. Existing policy records never enable this feature. */
export const BTC_MULTISIG_SETTING = "btc_multisig_enabled";
export const BTC_MULTISIG_DISABLED =
  "Bitcoin multisig co-signing is off. Enable it in Settings → Feature Flags.";
type ReadSetting = (key: string) => string | null | undefined;
export function btcMultisigEnabled(get: ReadSetting): boolean {
  return get(BTC_MULTISIG_SETTING) === "1";
}
export function requireBtcMultisig(get: ReadSetting): void {
  if (!btcMultisigEnabled(get)) throw new Error(BTC_MULTISIG_DISABLED);
}
/** Low-level APIs can also carry native/wrapped multisig in an ordinary input. */
export function hasMultisigSigningData(
  request: { inputs?: unknown; outputs?: unknown } | undefined
): boolean {
  return [request?.inputs, request?.outputs].some(
    (items) =>
      Array.isArray(items) &&
      items.some(
        (item) =>
          item && (item.multisig !== undefined || item.scriptType === "p2sh")
      )
  );
}
export class MultisigFeature {
  private revision = 0;
  constructor(
    private readonly get: ReadSetting,
    private readonly set: (key: string, value: string) => void
  ) {}
  get enabled(): boolean {
    return btcMultisigEnabled(this.get);
  }
  assertEnabled(): void {
    requireBtcMultisig(this.get);
  }
  capture(): () => void {
    this.assertEnabled();
    const revision = this.revision;
    return () => {
      this.assertEnabled();
      if (revision !== this.revision)
        throw new Error(
          "Multisig settings changed. Review the file or policy again."
        );
    };
  }
  update(enabled: unknown, signing: boolean): void {
    if (typeof enabled !== "boolean")
      throw new Error("Multisig co-signing requires an enabled boolean");
    if (signing)
      throw new Error(
        "Finish the current multisig signing request before changing this setting"
      );
    this.set(BTC_MULTISIG_SETTING, enabled ? "1" : "0");
    if (this.get(BTC_MULTISIG_SETTING) !== (enabled ? "1" : "0"))
      throw new Error("Could not save multisig co-signing. Try again.");
    this.revision++;
  }
}
