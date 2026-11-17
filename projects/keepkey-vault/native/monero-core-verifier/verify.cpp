/*
Copyright (c) 2014-2022, The Monero Project

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
this list of conditions and the following disclaimer in the documentation
and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
may be used to endorse or promote products derived from this software without
specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Parts of the project are originally copyright (c) 2012-2013 The Cryptonote
developers

Parts of the project are originally copyright (c) 2014 The Boolberry
developers, distributed under the MIT licence:

  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


*/
// Verification-only bridge to Monero Core v0.18.5.4. No device, wallet key, signing or network API.
#include "core-plan.h"
#include <cstring>
#include <limits>
#include <mutex>
#include <set>
#include <string>
#include <vector>
#include "crypto/crypto.h"
extern "C" {
#include "crypto/crypto-ops.h"
}
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "ringct/rctSigs.h"
namespace {
std::mutex engine_mutex;
bool fail(char *error,const char *message) {
 if(error){std::strncpy(error,message,MONERO_CORE_ERROR_CAPACITY-1);error[MONERO_CORE_ERROR_CAPACITY-1]=0;}return false;
}
template<typename T> T pod(const uint8_t *bytes) {T value;static_assert(sizeof(T)==32,"32-byte Core value");std::memcpy(&value,bytes,32);return value;}
bool point(const uint8_t bytes[32]) {
 ge_p3 decoded;uint8_t canonical[32];if(ge_frombytes_vartime(&decoded,bytes))return false;
 ge_p3_tobytes(canonical,&decoded);if(std::memcmp(canonical,bytes,32))return false;
 const rct::key value=pod<rct::key>(bytes);return !(value==rct::identity())&&rct::isInMainSubgroup(value);
}
bool add_amount(uint64_t &total,uint64_t amount){if(amount>std::numeric_limits<uint64_t>::max()-total)return false;total+=amount;return true;}
bool verify(const monero_core_plan *plan, const uint8_t *bytes, size_t size, char *error) {
  if (!plan || !bytes || !size || size > MONERO_CORE_MAX_TX_BYTES ||
      plan->input_count < 1 || plan->input_count > MONERO_CORE_MAX_INPUTS ||
      plan->output_count < 2 || plan->output_count > MONERO_CORE_MAX_OUTPUTS)
    return fail(error, "Invalid verification inputs");
  cryptonote::transaction tx;
  crypto::hash hash, prefix;
  const cryptonote::blobdata raw(reinterpret_cast<const char *>(bytes), size);
  if (!cryptonote::parse_and_validate_tx_from_blob(raw, tx, hash, prefix) ||
      cryptonote::tx_to_blob(tx) != raw || tx.version != 2 || tx.unlock_time != 0 ||
      tx.vin.size() != plan->input_count || tx.vout.size() != plan->output_count ||
      tx.rct_signatures.type != rct::RCTTypeBulletproofPlus ||
      tx.rct_signatures.txnFee != plan->fee || !cryptonote::check_outs_valid(tx))
    return fail(error, "Invalid serialized HF16 Bulletproof+ transaction");
  auto &signature = tx.rct_signatures;
  for (const auto &output : tx.vout)
    if (output.amount || !boost::get<cryptonote::txout_to_tagged_key>(&output.target))
      return fail(error, "HF16 requires tagged confidential outputs");
  if (signature.p.CLSAGs.size() != tx.vin.size()) return fail(error, "Invalid CLSAG count");
  signature.message = rct::hash2rct(prefix);
  signature.mixRing.resize(tx.vin.size());
  std::set<std::string> images;
  std::vector<bool> used(plan->input_count, false);
  for (unsigned i = 0; i < tx.vin.size(); ++i) {
    const auto *input = boost::get<cryptonote::txin_to_key>(&tx.vin[i]);
    if (!input || input->amount != 0 || input->key_offsets.size() != MONERO_CORE_RING_SIZE ||
        !point(reinterpret_cast<const uint8_t *>(&input->k_image)) ||
        !images.insert(std::string(reinterpret_cast<const char *>(&input->k_image), 32)).second)
      return fail(error, "Invalid input ring or key image");
    std::vector<uint64_t> absolute;
    uint64_t value = 0;
    for (const uint64_t relative : input->key_offsets) {
      if (!add_amount(value, relative)) return fail(error, "Ring index overflow");
      absolute.push_back(value);
    }
    unsigned match = plan->input_count;
    for (unsigned n = 0; n < plan->input_count; ++n) {
      if (used[n]) continue;
      bool same = true;
      for (unsigned j = 0; j < MONERO_CORE_RING_SIZE; ++j)
        same &= absolute[j] == plan->sources[n].ring[j].global_index;
      if (same) { match = n; break; }
    }
    if (match == plan->input_count) return fail(error, "Transaction ring is not in the supplied plan");
    used[match] = true;
    for (const auto &member : plan->sources[match].ring) {
      if (!point(member.public_key) || !point(member.commitment)) return fail(error, "Invalid verification ring point");
      signature.mixRing[i].push_back({pod<rct::key>(member.public_key), pod<rct::key>(member.commitment)});
    }
    signature.p.CLSAGs[i].I = rct::ki2rct(input->k_image);
    if (i && std::memcmp(&boost::get<cryptonote::txin_to_key>(tx.vin[i - 1]).k_image,
                         &input->k_image, 32) <= 0)
      return fail(error, "Key images are not canonically sorted");
  }
  if (!rct::verRctSemanticsSimple(signature) || !rct::verRctNonSemanticsSimple(signature))
    return fail(error, "Ring signature or Bulletproof+ verification failed");
  return true;
}
}
extern "C" int monero_core_verify(const monero_core_plan *plan,const uint8_t *bytes,size_t size,char error[MONERO_CORE_ERROR_CAPACITY]){
 if(error)error[0]=0;try{std::lock_guard<std::mutex> lock(engine_mutex);return verify(plan,bytes,size,error);}catch(...){return fail(error,"Monero Core rejected the serialized transaction");}
}
extern "C" size_t monero_core_plan_size(void){return sizeof(monero_core_plan);}
