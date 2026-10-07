/*
 * Firmware oracle for Vault's Solana AdvancedMode gate
 * (solanaFirmwareRequiresAdvancedMode in src/bun/solana-consent.ts).
 *
 * Links the firmware's own transaction classifier (lib/firmware/solana.c, cut
 * by gen-verdicts.sh just after solana_inspectTx) and asks it how it reviews
 * each message. fsm_msgSolanaSignTx refuses an OPAQUE review with "Enable
 * AdvancedMode to blind-sign", signs a VERIFIED one with per-instruction
 * screens, and refuses a MALFORMED one whatever the policy.
 *
 * stdin, one message per line: <message hex> (the bytes the device signs)
 * stdout, one verdict per line: VERIFIED, OPAQUE or MALFORMED
 */
#include "keepkey/firmware/solana.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  static char hex[16384];
  static uint8_t raw[8192];
  static SolanaParsedTx tx;
  while (scanf("%16383s", hex) == 1) {
    size_t n = strlen(hex) / 2;
    if (n > sizeof raw) {
      fprintf(stderr, "message too long\n");
      return 2;
    }
    for (size_t i = 0; i < n; i++) sscanf(hex + 2 * i, "%2hhx", &raw[i]);
    switch (solana_inspectTx(raw, n, &tx)) {
      case SOL_TX_REVIEW_VERIFIED:
        puts("VERIFIED");
        break;
      case SOL_TX_REVIEW_OPAQUE:
        puts("OPAQUE");
        break;
      default:
        puts("MALFORMED");
    }
  }
  return 0;
}
