import { test, expect } from "bun:test";
import { HDKey } from "@scure/bip32";
import {
  parseMultisigPolicy,
  cosignerKey,
  multisigAccountPath,
  deriveMultisig,
} from "./multisig-policy";
import {
  readMultisigCosigner,
  matchMultisigDevice,
  verifyMultisigPolicy,
} from "./multisig-device";
import { MultisigRegistry } from "./multisig-registry";
import { formatPath } from "./codec";
const masters = [1, 2, 3].map((n) =>
  HDKey.fromMasterSeed(new Uint8Array(32).fill(n))
);
const cs = masters.map((m) => {
  const path = multisigAccountPath("p2wsh");
  return {
    fingerprint: m.fingerprint.toString(16).padStart(8, "0"),
    path,
    xpub: m.derive(formatPath(path)).publicExtendedKey,
  };
});
const policy = parseMultisigPolicy(
  `wsh(sortedmulti(2,${cs.map((c) => cosignerKey(c) + "/<0;1>/*").join(",")}))`
);
const own = policy.cosigners.findIndex((c) => c.xpub === cs[0].xpub);
const wallet = {
  async getPublicKeys(requests: any[]) {
    return requests.map((r) => ({
      xpub: masters[0].derive(formatPath(r.addressNList)).publicExtendedKey,
    }));
  },
  async btcGetAddress(request: any) {
    expect(request.showDisplay).toBe(true);
    expect(request.multisig.m).toBe(2);
    return deriveMultisig(policy, 0, 0).address;
  },
};
const record = {
  name: "Test",
  descriptor: policy.descriptor,
  fingerprint: cs[0].fingerprint,
  xpub: cs[0].xpub,
  verifiedAt: 1234,
};
test("matches the actual device public key, then displays the first policy address", async () => {
  expect(await matchMultisigDevice(wallet, policy)).toBe(own);
  expect(await verifyMultisigPolicy(wallet, policy, own)).toBe(
    deriveMultisig(policy, 0, 0).address
  );
  expect(await readMultisigCosigner(wallet, "p2wsh")).toMatchObject({
    fingerprint: cs[0].fingerprint,
    xpub: cs[0].xpub,
  });
});
test("a fingerprint collision, missing device, rejected address or cancellation cannot enroll", async () => {
  await expect(matchMultisigDevice(wallet, policy, "00000000")).rejects.toThrow(
    "not a cosigner"
  );
  await expect(
    matchMultisigDevice(
      { ...wallet, getPublicKeys: async () => [{ xpub: cs[1].xpub }] },
      policy,
      cs[0].fingerprint
    )
  ).rejects.toThrow("not this KeepKey");
  await expect(
    verifyMultisigPolicy(
      { ...wallet, btcGetAddress: async () => "wrong" },
      policy,
      own
    )
  ).rejects.toThrow("different");
  await expect(
    verifyMultisigPolicy(
      {
        ...wallet,
        btcGetAddress: async () => {
          throw Error("cancelled");
        },
      },
      policy,
      own
    )
  ).rejects.toThrow("cancelled");
});
test("normal policies survive restart; hidden policies never write to settings and expire on session change", () => {
  let text: string | null = null,
    writes = 0,
    hidden = false,
    epoch = 1;
  const create = () =>
    new MultisigRegistry(
      () => text,
      (_k, v) => {
        writes++;
        text = v;
      },
      () => ({ hidden, epoch })
    );
  let store = create();
  store.write([record]);
  expect(writes).toBe(1);
  store = create();
  expect(store.read()).toEqual([record]);
  hidden = true;
  expect(store.read()).toEqual([]);
  store.write([{ ...record, name: "Hidden" }]);
  expect(writes).toBe(1);
  expect(store.read()[0].name).toBe("Hidden");
  epoch++;
  expect(store.read()).toEqual([]);
  hidden = false;
  expect(store.read()).toEqual([record]);
});
test("invalid enrollment records, corrupt settings and unsuccessful persistence fail closed", () => {
  const store = new MultisigRegistry(
    () => null,
    () => {},
    () => ({ hidden: false, epoch: 0 })
  );
  expect(() => store.write([record])).toThrow("Could not save");
  expect(() => store.write([{ ...record, verifiedAt: 0 }])).toThrow("invalid");
  expect(() => store.write([{ ...record, xpub: cs[1].xpub }])).toThrow(
    "matching"
  );
  expect(() => store.write(Array(33).fill(record))).toThrow("32");
  expect(() =>
    new MultisigRegistry(
      () => "{",
      () => {},
      () => ({ hidden: false, epoch: 0 })
    ).read()
  ).toThrow();
  expect(() =>
    new MultisigRegistry(
      () => JSON.stringify([{}]),
      () => {},
      () => ({ hidden: false, epoch: 0 })
    ).read()
  ).toThrow("invalid");
});
