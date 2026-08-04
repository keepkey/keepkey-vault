import type { SignedTx, SolanaTokenInfo, X402SvmKitTransaction, X402SvmPaymentRequirements, X402SvmTokenDisplay } from './types';
/**
 * Keep the x402 adapter on the firmware ClearSign path. Other exact EVM
 * transfer methods (including Permit2) would otherwise become opaque EIP-712
 * requests and must not be accepted by this hardware-reviewed signer.
 */
export declare function assertX402Eip3009(message: {
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
}, deviceAddress: string): void;
/** JSON-safe copy for x402/viem EIP-712 values, which commonly contain bigint. */
export declare function x402JsonSafe(value: unknown): any;
export declare function x402SignatureHex(result: any): `0x${string}`;
export declare function x402SvmDisplayFields(paymentRequirements: X402SvmPaymentRequirements, token: X402SvmTokenDisplay): {
    tokenInfo: SolanaTokenInfo[];
    tokenRecipientOwners: string[];
};
export declare function base64Encode(bytes: Uint8Array): string;
export declare function base64Decode(value: string): Uint8Array;
/** Build a wire transaction from the compiled transaction supplied by Solana Kit. */
export declare function x402KitTransactionToWire(transaction: X402SvmKitTransaction): string;
export declare function x402SvmSignatureBytes(result: SignedTx): Uint8Array;
//# sourceMappingURL=x402.d.ts.map