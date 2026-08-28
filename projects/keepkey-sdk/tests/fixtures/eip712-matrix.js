/** Representative EIP-712 documents for structured device-review coverage. */

const ADDRESS = {
  owner: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
}

const domain = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

const permitDetails = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint160' },
  { name: 'expiration', type: 'uint48' },
  { name: 'nonce', type: 'uint48' },
]

const fixtures = {
  'permit2-single': {
    purpose: 'A bounded Uniswap Permit2 token allowance with a nested struct',
    typedData: {
      types: {
        EIP712Domain: domain.filter(field => field.name !== 'version'),
        PermitDetails: permitDetails,
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      primaryType: 'PermitSingle',
      domain: { name: 'Permit2', chainId: 1, verifyingContract: ADDRESS.permit2 },
      message: {
        details: { token: ADDRESS.usdc, amount: '1000000000', expiration: '1893456000', nonce: '0' },
        spender: ADDRESS.spender,
        sigDeadline: '1893456000',
      },
    },
  },
  'permit2-batch': {
    purpose: 'Permit2 array traversal with two independently reviewed allowances',
    typedData: {
      types: {
        EIP712Domain: domain.filter(field => field.name !== 'version'),
        PermitDetails: permitDetails,
        PermitBatch: [
          { name: 'details', type: 'PermitDetails[]' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      primaryType: 'PermitBatch',
      domain: { name: 'Permit2', chainId: 1, verifyingContract: ADDRESS.permit2 },
      message: {
        details: [
          { token: ADDRESS.usdc, amount: '250000000', expiration: '1893456000', nonce: '1' },
          { token: ADDRESS.dai, amount: '500000000000000000000', expiration: '1893456000', nonce: '2' },
        ],
        spender: ADDRESS.spender,
        sigDeadline: '1893456000',
      },
    },
  },
  'erc2612-usdc-permit': {
    purpose: 'ERC-2612 allowance with owner, spender, exact amount, nonce and deadline',
    typedData: {
      types: {
        EIP712Domain: domain,
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: ADDRESS.usdc },
      message: {
        owner: ADDRESS.owner,
        spender: ADDRESS.spender,
        value: '1000000000',
        nonce: '7',
        deadline: '1893456000',
      },
    },
  },
  'dai-permit': {
    purpose: 'DAI-style boolean allowance whose field names differ from ERC-2612',
    typedData: {
      types: {
        EIP712Domain: domain,
        Permit: [
          { name: 'holder', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'allowed', type: 'bool' },
        ],
      },
      primaryType: 'Permit',
      domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: ADDRESS.dai },
      message: {
        holder: ADDRESS.owner,
        spender: ADDRESS.spender,
        nonce: '8',
        expiry: '1893456000',
        allowed: true,
      },
    },
  },
  'x402-transfer-authorization': {
    purpose: 'Circle EIP-3009/x402 payment authorization with bytes32 nonce',
    typedData: {
      types: {
        EIP712Domain: domain,
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ADDRESS.usdc },
      message: {
        from: ADDRESS.owner,
        to: ADDRESS.recipient,
        value: '1250000',
        validAfter: '0',
        validBefore: '1893456000',
        nonce: '0x' + '42'.repeat(32),
      },
    },
  },
  'eip712-mail': {
    purpose: 'Published EIP-712 nested-struct reference shape',
    typedData: {
      types: {
        EIP712Domain: domain,
        Person: [
          { name: 'name', type: 'string' },
          { name: 'wallet', type: 'address' },
        ],
        Mail: [
          { name: 'from', type: 'Person' },
          { name: 'to', type: 'Person' },
          { name: 'contents', type: 'string' },
        ],
      },
      primaryType: 'Mail',
      domain: {
        name: 'Ether Mail',
        version: '1',
        chainId: 1,
        verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
      },
      message: {
        from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
        to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
        contents: 'Hello, Bob!',
      },
    },
  },
}

module.exports = { fixtures }
