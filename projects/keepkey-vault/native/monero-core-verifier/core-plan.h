#ifndef KEEPKEY_MONERO_CORE_VERIFICATION_PLAN_H
#define KEEPKEY_MONERO_CORE_VERIFICATION_PLAN_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MONERO_CORE_MAX_INPUTS 4u
#define MONERO_CORE_MAX_OUTPUTS 4u
#define MONERO_CORE_RING_SIZE 16u
#define MONERO_CORE_MAX_ADDITIONAL_KEYS 16u
#define MONERO_CORE_MAX_TX_BYTES 16384u
#define MONERO_CORE_ERROR_CAPACITY 192u

typedef struct monero_core_ring_member {
  uint64_t global_index;
  uint8_t public_key[32];
  uint8_t commitment[32];
} monero_core_ring_member;

typedef struct monero_core_source {
  uint64_t amount;
  uint32_t real_member;
  uint32_t output_index;
  uint32_t subaddress_major;
  uint32_t subaddress_minor;
  uint8_t tx_public_key[32];
  uint8_t mask[32];
  uint32_t additional_key_count;
  uint8_t additional_tx_public_keys[MONERO_CORE_MAX_ADDITIONAL_KEYS][32];
  monero_core_ring_member ring[MONERO_CORE_RING_SIZE];
} monero_core_source;

typedef struct monero_core_destination {
  uint64_t amount;
  char address[96];
  uint32_t is_change;
  uint32_t change_major;
  uint32_t change_minor;
} monero_core_destination;

typedef struct monero_core_plan {
  uint32_t network;
  uint32_t input_count;
  uint32_t output_count;
  uint64_t fee;
  monero_core_source sources[MONERO_CORE_MAX_INPUTS];
  monero_core_destination destinations[MONERO_CORE_MAX_OUTPUTS];
} monero_core_plan;

/* Public serialized transaction and reviewed plan only; no wallet secret or signing entry point. */
int monero_core_verify(const monero_core_plan *plan, const uint8_t *bytes, size_t size,
                       char error[MONERO_CORE_ERROR_CAPACITY]);
size_t monero_core_plan_size(void);
#ifdef __cplusplus
}
static_assert(sizeof(monero_core_plan) == 7544, "Monero plan ABI changed");
#endif
#endif
