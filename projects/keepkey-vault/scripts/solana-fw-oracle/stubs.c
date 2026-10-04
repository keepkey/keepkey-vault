/* Link symbols solana.c references but the certified decision never reaches
 * (signing, attestation checks, ATA derivation). Kept apart from harness.c
 * so their real prototypes are not in scope. Abort loudly if one is called. */
#include <stdio.h>
#include <stdlib.h>

#define UNREACHED(name) \
  void name(void) { fprintf(stderr, "unreached " #name " called\n"); abort(); }
UNREACHED(clearsign_root_verify_delegate_attestation)
UNREACHED(signed_metadata_verify_attestation)
UNREACHED(hasher_Raw)
UNREACHED(random_buffer)
UNREACHED(ed25519_sign)
UNREACHED(ed25519_sign_open)
UNREACHED(ge25519_unpack_vartime)
