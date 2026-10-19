import { describe, test, expect } from "bun:test";
import {
  MultisigFeature,
  BTC_MULTISIG_SETTING,
  btcMultisigEnabled,
  hasMultisigSigningData,
} from "./multisig-feature";
import { parseForBroadcast } from "./psbt";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";

describe("runtime multisig Settings flag", () => {
  test("defaults off even when an existing policy is saved, and only explicit persisted opt-in enables it", () => {
    for (const stored of [undefined, null, "", "0", "true", "false", "yes"])
      expect(btcMultisigEnabled(() => stored)).toBe(false);
    expect(
      btcMultisigEnabled((key) => (key === BTC_MULTISIG_SETTING ? "1" : null))
    ).toBe(true);
    const data = new Map([
      ["btc_multisig_policies_v1", '[{"descriptor":"saved"}]'],
    ]);
    expect(
      new MultisigFeature(
        (k) => data.get(k),
        (k, v) => data.set(k, v)
      ).enabled
    ).toBe(false);
  });
  test("toggle survives restart and does not require a build or connected device", () => {
    const data = new Map<string, string>(),
      create = () =>
        new MultisigFeature(
          (k) => data.get(k),
          (k, v) => data.set(k, v)
        );
    const f = create();
    expect(() => f.capture()).toThrow("Settings");
    f.update(true, false);
    expect(create().enabled).toBe(true);
    f.update(false, false);
    expect(create().enabled).toBe(false);
  });
  test("failed persistence and malformed requests do not enable the feature", () => {
    const f = new MultisigFeature(
      () => null,
      () => {}
    );
    expect(() => f.update("true", false)).toThrow("boolean");
    expect(() => f.update(true, false)).toThrow("Could not save");
    expect(f.enabled).toBe(false);
  });
  test("disable/re-enable invalidates in-flight key, policy and signing sessions", () => {
    let value: string | null = "1";
    const f = new MultisigFeature(
      () => value,
      (_k, v) => {
        value = v;
      }
    );
    const check = f.capture();
    check();
    f.update(false, false);
    expect(() => check()).toThrow("off");
    f.update(true, false);
    expect(() => check()).toThrow("changed");
    f.capture()();
    expect(() => f.update(false, true)).toThrow("Finish");
    expect(f.enabled).toBe(true);
  });
  test("detects native/wrapped and legacy multisig at low-level API boundaries", () => {
    for (const request of [
      { inputs: [{ multisig: { m: 2 } }] },
      { outputs: [{ multisig: { m: 2 } }] },
      { inputs: [{ scriptType: "p2sh" }] },
      { inputs: [{ multisig: null }] },
    ])
      expect(hasMultisigSigningData(request)).toBe(true);
    for (const request of [
      undefined,
      {},
      { inputs: [{ scriptType: "p2wpkh" }] },
      { inputs: [{ scriptType: "p2tr" }] },
      { outputs: [{ address: "bc1q" }] },
    ])
      expect(hasMultisigSigningData(request)).toBe(false);
  });
  test("final transaction review remains available with multisig disabled", () => {
    const gate = new MultisigFeature(
      () => null,
      () => {}
    );
    const raw = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      lockTime: 0,
      witnesses: undefined,
      inputs: [
        {
          txid: new Uint8Array(32).fill(1),
          index: 0,
          sequence: 0xffffffff,
          finalScriptSig: new Uint8Array([0]),
        },
      ],
      outputs: [{ amount: 1000n, script: new Uint8Array([0x6a]) }],
    });
    expect(gate.enabled).toBe(false);
    expect(parseForBroadcast(hex.encode(raw)).outputs[0].amount).toBe(1000n);
  });
});
