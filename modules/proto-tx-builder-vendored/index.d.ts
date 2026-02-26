/**
 * Vendored proto-tx-builder — Cosmos SIGN_MODE_DIRECT transaction builder.
 * Self-contained single-file bundle with all proto codecs and amino converters inlined.
 * No external dependencies at runtime.
 *
 * Original: @shapeshiftoss/proto-tx-builder v0.10.0
 * Bundled with: bun build --bundle --minify (923 modules → 4.2MB)
 *
 * To rebuild: cd modules/proto-tx-builder && bun build ./dist/index.js --outdir ../proto-tx-builder-vendored --target node --format cjs --bundle --minify
 */

export interface ProtoTx {
  readonly msg: readonly { typeUrl: string; value: any }[];
  readonly fee: {
    readonly amount: readonly { denom: string; amount: string }[];
    readonly gas: string;
  };
  readonly signatures: readonly { pub_key: { type: string; value: string }; signature: string }[];
  readonly memo: string | undefined;
}

export declare function sign(
  signerAddress: string,
  tx: any,
  signer: any,
  signerData: { accountNumber: number; sequence: number; chainId: string },
  prefix?: string,
): Promise<{
  serialized: string;
  body: string;
  authInfoBytes: string;
  signatures: string[];
}>;
