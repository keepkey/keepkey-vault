/*
 * The firmware's own Universal Router decoder (lib/firmware/uniswap_ur.c) as a
 * filter: one call per input line, "router value calldata" in hex; one output
 * line per call, in the format of the firmware's uniswap_ur_expected.txt
 * without its key: "D 0", or "D 1 n {step}*n H nh hook* S 0|S 1 {review}".
 * Built and run by gen-fixture.sh only.
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "keepkey/firmware/uniswap_ur.h"

static size_t unhex(const char* h, uint8_t* out, size_t max) {
  size_t n = strlen(h) / 2;
  if (n > max) exit(2);
  for (size_t i = 0; i < n; i++) {
    unsigned v;
    if (sscanf(h + 2 * i, "%2x", &v) != 1) exit(2);
    out[i] = (uint8_t)v;
  }
  return n;
}

static void hex(const uint8_t* p, size_t n) {
  putchar(' ');
  for (size_t i = 0; i < n; i++) printf("%02x", p[i]);
}

int main(void) {
  static char line[1 << 21];
  static uint8_t cd[1 << 20];
  while (fgets(line, sizeof line, stdin)) {
    char* r = strtok(line, " \n");
    char* v = strtok(NULL, " \n");
    char* c = strtok(NULL, " \n");
    if (!r || !v) return 2;
    uint8_t router[20] = {0}, value[32] = {0};
    if (unhex(r, router, 20) != 20 || unhex(v, value, 32) != 32) return 2;
    const size_t n = c ? unhex(c, cd, sizeof cd) : 0;
    UrPlan plan;
    UrSummary s;
    if (!ur_decode(cd, n, &plan)) {
      printf("D 0\n");
      continue;
    }
    printf("D 1 %u", (unsigned)plan.n);
    for (uint8_t i = 0; i < plan.n; i++) {
      const UrStep* t = &plan.steps[i];
      printf(" %d", (int)t->kind);
      hex(t->token_in, 20);
      hex(t->token_out, 20);
      hex(t->recipient, 20);
      hex(t->amount, 32);
      hex(t->limit, 32);
      printf(" %d %" PRIu64, (int)t->payer_is_user, t->expiration);
    }
    printf(" H %u", (unsigned)plan.n_hooks);
    for (uint8_t i = 0; i < plan.n_hooks; i++) hex(plan.hooks[i], 20);
    if (!ur_summarize(&plan, router, value, &s)) {
      printf(" S 0\n");
      continue;
    }
    printf(" S 1 %d %d %d", s.exact_in, s.in_is_eth, s.out_is_eth);
    hex(s.token_in, 20);
    hex(s.token_out, 20);
    hex(s.amount_in, 32);
    hex(s.amount_out, 32);
    hex(s.recipient, 20);
    printf(" %d %d", s.recipient_is_sender, s.has_permit);
    hex(s.permit_token, 20);
    hex(s.permit_amount, 32);
    printf(" %" PRIu64 " %d %u", s.permit_expiration, s.has_fee,
           (unsigned)s.fee_bips);
    hex(s.fee_recipient, 20);
    /* Not in the Python model's line: the hooks the review shows. */
    printf(" R %u", (unsigned)s.n_hooks);
    for (uint8_t i = 0; i < s.n_hooks; i++) hex(s.hooks[i], 20);
    putchar('\n');
  }
  return 0;
}
