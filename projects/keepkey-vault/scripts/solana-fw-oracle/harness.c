/*
 * Firmware oracle for Vault's certified Solana rule (solana-certified-match.ts).
 *
 * Links the firmware's real lib/firmware/solana.c and replays the certified
 * branch of fsm_msgSolanaSignTx in its order: inspect the message (with the
 * trusted LUT keys when there are any), MALFORMED, LUT shape, schema parse,
 * schema_applies(certified), then solana_validatePriorityFee (fee.inc, cut
 * verbatim from fsm_msg_solana.h by gen-corpus.sh). The certificate, delegate
 * signature, LUT signature and signer checks are elided: they bind material,
 * not the message shape Vault decides on.
 *
 * stdin, one case per line: <schema payload hex> <message hex> <LUT key count>
 * stdout, one verdict per line: "ACCEPT <instruction index>" or "REJECT <why>".
 */
#include "keepkey/firmware/solana.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fee.inc"

static size_t unhex(const char* h, uint8_t* out, size_t max) {
  size_t n = strlen(h) / 2;
  if (n > max) {
    fprintf(stderr, "input too long\n");
    exit(2);
  }
  for (size_t i = 0; i < n; i++) sscanf(h + 2 * i, "%2hhx", &out[i]);
  return n;
}

int main(void) {
  static char schema_hex[4096], message_hex[8192];
  static uint8_t payload[1024], raw[4096];
  unsigned lut_n;
  while (scanf("%4095s %8191s %u", schema_hex, message_hex, &lut_n) == 3) {
    size_t payload_len = unhex(schema_hex, payload, sizeof payload);
    size_t raw_len = unhex(message_hex, raw, sizeof raw);
    if (lut_n > SOL_MAX_LUT_ACCOUNTS) {
      /* The LUT account list is a bounded protobuf field. */
      printf("REJECT lut-count\n");
      continue;
    }
    uint8_t keys[SOL_MAX_LUT_ACCOUNTS][SOL_PUBKEY_SIZE];
    for (unsigned i = 0; i < SOL_MAX_LUT_ACCOUNTS; i++)
      memset(keys[i], 0x60 + i, SOL_PUBKEY_SIZE);

    SolanaParsedTx tx;
    memset(&tx, 0, sizeof tx);
    SolanaTxReview review =
        lut_n > 0 ? solana_inspectTxWithTrustedLut(
                        raw, raw_len, (const uint8_t (*)[SOL_PUBKEY_SIZE])keys,
                        lut_n, &tx)
                  : solana_inspectTx(raw, raw_len, &tx);
    SolanaInstrSchema schema;
    memset(&schema, 0, sizeof schema);
    uint8_t index = 0xff;
    if (review == SOL_TX_REVIEW_MALFORMED) {
      printf("REJECT malformed\n");
    } else if (!solana_certifiedLutShapeMatches(&tx, lut_n)) {
      printf("REJECT lut-shape\n");
    } else if (!solana_parseInstrSchema(payload, payload_len, &schema)) {
      printf("REJECT schema\n");
    } else if (!solana_schemaAppliesCertified(&schema, &tx, &index)) {
      printf("REJECT applies\n");
    } else if (!solana_validatePriorityFee(&tx)) {
      printf("REJECT fee\n");
    } else {
      printf("ACCEPT %u\n", index);
    }
  }
  return 0;
}
