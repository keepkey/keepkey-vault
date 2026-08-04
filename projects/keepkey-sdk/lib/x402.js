"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertX402Eip3009 = assertX402Eip3009;
exports.x402JsonSafe = x402JsonSafe;
exports.x402SignatureHex = x402SignatureHex;
exports.x402SvmDisplayFields = x402SvmDisplayFields;
exports.base64Encode = base64Encode;
exports.base64Decode = base64Decode;
exports.x402KitTransactionToWire = x402KitTransactionToWire;
exports.x402SvmSignatureBytes = x402SvmSignatureBytes;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const EIP3009_TRANSFER_WITH_AUTHORIZATION = [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
];
/**
 * Keep the x402 adapter on the firmware ClearSign path. Other exact EVM
 * transfer methods (including Permit2) would otherwise become opaque EIP-712
 * requests and must not be accepted by this hardware-reviewed signer.
 */
function assertX402Eip3009(message, deviceAddress) {
    if (message.primaryType !== 'TransferWithAuthorization') {
        throw new Error('KeepKey x402 EVM currently supports EIP-3009 TransferWithAuthorization only');
    }
    const fields = message.types.TransferWithAuthorization;
    if (!Array.isArray(fields)
        || fields.length !== EIP3009_TRANSFER_WITH_AUTHORIZATION.length
        || !EIP3009_TRANSFER_WITH_AUTHORIZATION.every((expected, index) => {
            const field = fields[index];
            return field && typeof field === 'object'
                && field.name === expected.name
                && field.type === expected.type;
        })) {
        throw new Error('KeepKey x402 EVM requires the canonical EIP-3009 field layout');
    }
    const from = message.message.from;
    if (typeof from !== 'string' || from.toLowerCase() !== deviceAddress.toLowerCase()) {
        throw new Error('x402 EIP-3009 from address does not match the KeepKey signer');
    }
}
/** JSON-safe copy for x402/viem EIP-712 values, which commonly contain bigint. */
function x402JsonSafe(value) {
    if (typeof value === 'bigint')
        return value.toString(10);
    if (Array.isArray(value))
        return value.map(x402JsonSafe);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value))
            result[key] = x402JsonSafe(child);
        return result;
    }
    return value;
}
function x402SignatureHex(result) {
    const signature = typeof result === 'string' ? result : result?.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error('KeepKey returned an invalid EIP-712 signature');
    }
    return signature;
}
function x402SvmDisplayFields(paymentRequirements, token) {
    if (!paymentRequirements.asset)
        throw new Error('x402 SVM asset is required');
    if (!paymentRequirements.payTo)
        throw new Error('x402 SVM payTo is required');
    if (!token.symbol || token.symbol.length > 12) {
        throw new Error('x402 SVM token symbol must be 1-12 characters');
    }
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
        throw new Error('x402 SVM token decimals must be an integer from 0 to 255');
    }
    if ((token.signature === undefined) !== (token.signerKeyId === undefined)) {
        throw new Error('x402 SVM token signature and signerKeyId must be supplied together');
    }
    return {
        tokenInfo: [{
                mint: paymentRequirements.asset,
                symbol: token.symbol,
                decimals: token.decimals,
                ...(token.signature === undefined ? {} : { signature: token.signature }),
                ...(token.signerKeyId === undefined ? {} : { signerKeyId: token.signerKeyId }),
            }],
        tokenRecipientOwners: [paymentRequirements.payTo],
    };
}
function encodeShortVec(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('Invalid Solana shortvec value');
    const bytes = [];
    do {
        let next = value & 0x7f;
        value = Math.floor(value / 128);
        if (value > 0)
            next |= 0x80;
        bytes.push(next);
    } while (value > 0);
    return Uint8Array.from(bytes);
}
function decodeShortVec(bytes, start) {
    let value = 0;
    let multiplier = 1;
    let offset = start;
    for (let i = 0; i < 5; i++) {
        if (offset >= bytes.length)
            throw new Error('Truncated Solana shortvec');
        const byte = bytes[offset++];
        value += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0)
            return { value, next: offset };
        multiplier *= 128;
    }
    throw new Error('Invalid Solana shortvec');
}
function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
function base58Encode(bytes) {
    let value = 0n;
    for (const byte of bytes)
        value = value * 256n + BigInt(byte);
    let encoded = '';
    while (value > 0n) {
        const remainder = Number(value % 58n);
        encoded = BASE58_ALPHABET[remainder] + encoded;
        value /= 58n;
    }
    let leadingZeroes = 0;
    while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0)
        leadingZeroes++;
    return '1'.repeat(leadingZeroes) + encoded;
}
function base64Encode(bytes) {
    let output = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        const value = (a << 16) | (b << 8) | c;
        output += BASE64_ALPHABET[(value >> 18) & 63];
        output += BASE64_ALPHABET[(value >> 12) & 63];
        output += i + 1 < bytes.length ? BASE64_ALPHABET[(value >> 6) & 63] : '=';
        output += i + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : '=';
    }
    return output;
}
function base64Decode(value) {
    const normalized = value.replace(/\s/g, '');
    if (normalized.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(normalized)) {
        throw new Error('Invalid base64');
    }
    const bytes = [];
    for (let i = 0; i < normalized.length; i += 4) {
        const a = BASE64_ALPHABET.indexOf(normalized[i]);
        const b = BASE64_ALPHABET.indexOf(normalized[i + 1]);
        const c = normalized[i + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(normalized[i + 2]);
        const d = normalized[i + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(normalized[i + 3]);
        if (a < 0 || b < 0 || c < 0 || d < 0)
            throw new Error('Invalid base64');
        const chunk = (a << 18) | (b << 12) | (c << 6) | d;
        bytes.push((chunk >> 16) & 0xff);
        if (normalized[i + 2] !== '=')
            bytes.push((chunk >> 8) & 0xff);
        if (normalized[i + 3] !== '=')
            bytes.push(chunk & 0xff);
    }
    return Uint8Array.from(bytes);
}
/** Build a wire transaction from the compiled transaction supplied by Solana Kit. */
function x402KitTransactionToWire(transaction) {
    const message = Uint8Array.from(transaction.messageBytes);
    if (message.length < 5 || (message[0] & 0x80) === 0 || (message[0] & 0x7f) !== 0) {
        throw new Error('x402 SVM requires a v0 Solana transaction');
    }
    const requiredSignatures = message[1];
    const accountCount = decodeShortVec(message, 4);
    const accountBytes = accountCount.next;
    if (accountCount.value < requiredSignatures || accountBytes + accountCount.value * 32 > message.length) {
        throw new Error('Invalid Solana v0 static account list');
    }
    const signatures = [];
    for (let i = 0; i < requiredSignatures; i++) {
        const start = accountBytes + i * 32;
        const address = base58Encode(message.subarray(start, start + 32));
        const existing = transaction.signatures[address];
        if (existing !== null && existing !== undefined && existing.length !== 64) {
            throw new Error(`Invalid Solana signature length for ${address}`);
        }
        signatures.push(existing ? Uint8Array.from(existing) : new Uint8Array(64));
    }
    return base64Encode(concatBytes([encodeShortVec(requiredSignatures), ...signatures, message]));
}
function x402SvmSignatureBytes(result) {
    if (typeof result.signature !== 'string')
        throw new Error('KeepKey returned no Solana signature');
    const signature = base64Decode(result.signature);
    if (signature.length !== 64)
        throw new Error(`KeepKey returned a ${signature.length}-byte Solana signature`);
    return signature;
}
//# sourceMappingURL=x402.js.map