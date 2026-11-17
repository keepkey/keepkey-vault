/* Read-only adapter between pinned Monero wallet exports and the experimental
 * KeepKey native-emulator protocol. No daemon connection or spend key exists.
 * One bounded JSON request on stdin produces one JSON response on stdout.
 */
#include <algorithm>
#include <cstring>
#include <iostream>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>
#include "wallet/wallet2.h"
#include "cryptonote_basic/tx_extra.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "serialization/binary_archive.h"
#include "serialization/serialization.h"
#include "rapidjson/document.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"
#include "memwipe.h"
extern "C" {
#include "crypto/crypto-ops.h"
}

namespace {
using Json = rapidjson::Value;
using Alloc = rapidjson::Document::AllocatorType;
constexpr size_t max_request = 16 * 1024 * 1024;
constexpr size_t max_outputs = 4096;
constexpr char output_magic[] = "Monero output export\004";
struct WipedString : std::string {
  using std::string::string;
  ~WipedString() { if (!empty()) memwipe(&(*this)[0], size()); }
};
struct AdapterError : std::runtime_error { using std::runtime_error::runtime_error; };
struct Request : rapidjson::Document {
  ~Request() {
    if (IsObject() && HasMember("view_key") && (*this)["view_key"].IsString()) {
      const auto &value = (*this)["view_key"];
      memwipe(const_cast<char *>(value.GetString()), value.GetStringLength());
    }
  }
};
void require(bool valid, const char *message) {
  if (!valid) throw AdapterError(message);
}
WipedString string_field(const Json &value, const char *name) {
  require(value.HasMember(name) && value[name].IsString(), "Missing string request field");
  const auto &field = value[name];
  require(!std::memchr(field.GetString(), 0, field.GetStringLength()), "Embedded zero in request string");
  return WipedString(field.GetString(), field.GetStringLength());
}
unsigned nibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  throw AdapterError("Invalid hexadecimal input");
}
WipedString unhex(const std::string &value) {
  require(!(value.size() & 1) && value.size() <= max_request, "Invalid hexadecimal input size");
  WipedString result(value.size() / 2, '\0');
  for (size_t n = 0; n < result.size(); ++n)
    result[n] = static_cast<char>((nibble(value[n * 2]) << 4) | nibble(value[n * 2 + 1]));
  return result;
}
template<typename T> std::string hex(const T &value) {
  const auto *bytes = reinterpret_cast<const unsigned char *>(&value);
  static const char digits[] = "0123456789abcdef";
  std::string result(sizeof(T) * 2, '0');
  for (size_t n = 0; n < sizeof(T); ++n) {
    result[n * 2] = digits[bytes[n] >> 4]; result[n * 2 + 1] = digits[bytes[n] & 15];
  }
  return result;
}
Json text(const std::string &value, Alloc &allocator) {
  return Json(value.data(), static_cast<rapidjson::SizeType>(value.size()), allocator);
}
void add(Json &value, const char *name, const std::string &field, Alloc &allocator) {
  value.AddMember(Json(name, allocator), text(field, allocator), allocator);
}
void add(Json &value, const char *name, const char *field, Alloc &allocator) {
  add(value, name, std::string(field), allocator);
}
void add(Json &value, const char *name, uint64_t field, Alloc &allocator) {
  value.AddMember(Json(name, allocator), Json().SetUint64(field), allocator);
}
Json public_keys(const std::vector<crypto::public_key> &keys, Alloc &allocator) {
  Json values(rapidjson::kArrayType);
  require(keys.size() <= 16, "More than 16 additional transaction keys");
  for (const auto &key : keys) values.PushBack(text(hex(key), allocator), allocator);
  return values;
}
using Exported = tools::wallet2::exported_transfer_details;
using OutputSet = std::tuple<uint64_t, uint64_t, std::vector<Exported>>;

OutputSet decode_outputs(tools::wallet2 &wallet, const std::string &encoded) {
  WipedString bytes = unhex(encoded);
  const size_t prefix = sizeof(output_magic) - 1;
  require(bytes.size() > prefix && !std::memcmp(bytes.data(), output_magic, prefix),
          "Unsupported output export magic/version");
  WipedString plain;
  try { plain.assign(wallet.decrypt_with_view_secret_key(bytes.substr(prefix))); }
  catch (...) { throw AdapterError("Could not authenticate/decrypt output export"); }
  const auto &address = wallet.get_account().get_keys().m_account_address;
  require(plain.size() > 64 && !std::memcmp(plain.data(), &address.m_spend_public_key, 32) &&
      !std::memcmp(plain.data() + 32, &address.m_view_public_key, 32),
      "Output export belongs to another wallet");
  WipedString body(plain.data() + 64, plain.size() - 64);
  OutputSet outputs;
  try {
    binary_archive<false> archive{epee::strspan<std::uint8_t>(body)};
    require(::serialization::serialize(archive, outputs) && ::serialization::check_stream_state(archive),
            "Invalid output export serialization");
  } catch (...) { throw AdapterError("Invalid current-version output export serialization"); }
  const auto offset = std::get<0>(outputs), total = std::get<1>(outputs);
  const auto &entries = std::get<2>(outputs);
  require(total <= max_outputs && offset <= total && entries.size() <= total - offset,
          "Output export exceeds supported count/offset");
  require(offset == 0 && entries.size() == total, "A complete export_outputs all result is required");
  std::set<std::string> output_keys;
  for (const auto &entry : entries) {
    require(entry.m_internal_output_index <= std::numeric_limits<uint32_t>::max(), "Output index exceeds emulator bound");
    require(entry.m_additional_tx_keys.size() <= 16 &&
        (entry.m_additional_tx_keys.empty() || entry.m_internal_output_index < entry.m_additional_tx_keys.size()),
        "Invalid additional transaction key count/output index");
    require(output_keys.insert(hex(entry.m_pubkey)).second, "Duplicate exported output public key");
    wallet.create_one_off_subaddress({entry.m_subaddr_index_major, entry.m_subaddr_index_minor});
  }
  return outputs;
}
Json output_json(const Exported &entry, uint64_t transfer_index, Alloc &allocator) {
  Json value(rapidjson::kObjectType);
  add(value, "transfer_index", transfer_index, allocator);
  add(value, "amount", entry.m_amount, allocator);
  add(value, "global_index", entry.m_global_output_index, allocator);
  add(value, "out_key", hex(entry.m_pubkey), allocator);
  add(value, "tx_public_key", hex(entry.m_tx_pubkey), allocator);
  value.AddMember("additional_tx_public_keys", public_keys(entry.m_additional_tx_keys, allocator), allocator);
  add(value, "output_index", entry.m_internal_output_index, allocator);
  add(value, "subaddress_major", entry.m_subaddr_index_major, allocator);
  add(value, "subaddress_minor", entry.m_subaddr_index_minor, allocator);
  return value;
}
void sum(uint64_t &total, uint64_t amount) {
  require(amount <= std::numeric_limits<uint64_t>::max() - total, "Transaction amount overflow"); total += amount;
}

void make_plan(tools::wallet2 &wallet, const OutputSet &outputs,
               const std::string &encoded, rapidjson::Document &reply) {
  WipedString bytes = unhex(encoded);
  require(bytes.size() > 23 && !std::memcmp(bytes.data(), "Monero unsigned tx set\005", 23),
          "Only current-version unsigned transaction sets are supported");
  tools::wallet2::unsigned_tx_set txset;
  require(wallet.parse_unsigned_tx_from_str(bytes, txset), "Could not authenticate/parse unsigned transaction set");
  require(txset.txes.size() == 1, "Exactly one unsigned transaction is required");
  const auto &construction = txset.txes.front();
  require(construction.use_rct && construction.use_view_tags && construction.unlock_time == 0 &&
      construction.rct_config.bp_version == 4, "Only unlocked HF16 Bulletproof+ transactions are supported");
  require(!construction.sources.empty() && construction.sources.size() <= 4 &&
      construction.selected_transfers.size() == construction.sources.size() &&
      construction.splitted_dsts.size() >= 2 && construction.splitted_dsts.size() <= 4,
      "Transaction exceeds 1..4 inputs or 2..4 outputs");
  // The emulator intentionally carries no payment ID or other custom tx-extra.
  // Official wallets may insert a dummy, all-zero short payment ID; it is safe
  // to omit that placeholder. Any meaningful extra is refused explicitly.
  if (!construction.extra.empty()) {
    std::vector<cryptonote::tx_extra_field> fields;
    require(cryptonote::parse_tx_extra(construction.extra, fields), "Invalid unsigned transaction extra");
    unsigned main_keys = 0, additional_keys = 0, nonces = 0;
    for (const auto &field : fields) {
      // These public keys belong to the watch wallet's placeholder tx and are
      // regenerated by the emulator with fresh private transaction keys.
      if (boost::get<cryptonote::tx_extra_pub_key>(&field)) {
        require(++main_keys == 1, "Duplicate transaction public key in extra");
        continue;
      }
      if (const auto *additional = boost::get<cryptonote::tx_extra_additional_pub_keys>(&field)) {
        require(++additional_keys == 1 && additional->data.size() <= 4,
                "Invalid additional transaction public keys in extra");
        continue;
      }
      const auto *nonce = boost::get<cryptonote::tx_extra_nonce>(&field);
      crypto::hash8 payment{};
      require(nonce && ++nonces == 1 && cryptonote::get_encrypted_payment_id_from_tx_extra_nonce(nonce->nonce, payment) &&
          payment == crypto::null_hash8, "Payment IDs and custom transaction extra are unsupported");
    }
  }
  auto &allocator = reply.GetAllocator();
  add(reply, "network", uint64_t(0), allocator);
  Json inputs(rapidjson::kArrayType), destinations(rapidjson::kArrayType);
  uint64_t total_in = 0, total_out = 0;
  std::set<uint64_t> selected;
  const auto &entries = std::get<2>(outputs);
  for (const auto index : construction.selected_transfers)
    require(index < entries.size() && selected.insert(index).second, "Unknown/repeated selected transfer");
  std::set<uint64_t> matched;
  for (size_t n = 0; n < construction.sources.size(); ++n) {
    const auto &source = construction.sources[n];
    require(source.rct && source.amount && source.outputs.size() == 16 && source.real_output < 16,
            "Only positive RingCT inputs with ring size 16 are supported");
    const auto &real = source.outputs[source.real_output];
    // Core preserves original source order but sorts selected_transfers by key
    // image. Match actual output identity instead of zipping those sequences.
    auto match = std::find_if(selected.begin(), selected.end(), [&](const uint64_t index) {
      return entries[index].m_global_output_index == real.first &&
             rct::pk2rct(entries[index].m_pubkey) == real.second.dest;
    });
    require(match != selected.end() && matched.insert(*match).second, "Unsigned source is not a unique selected output");
    const auto &entry = entries[*match];
    require(source.amount == entry.m_amount && source.real_output_in_tx_index == entry.m_internal_output_index &&
        real.first == entry.m_global_output_index && real.second.dest == rct::pk2rct(entry.m_pubkey) &&
        source.real_out_tx_key == entry.m_tx_pubkey && source.real_out_additional_tx_keys == entry.m_additional_tx_keys,
        "Unsigned input does not match exported wallet output metadata");
    require(!sc_check(source.mask.bytes) && rct::commit(source.amount, source.mask) == real.second.mask,
            "Unsigned input amount/mask does not match commitment");
    Json input(rapidjson::kObjectType), ring(rapidjson::kArrayType);
    add(input, "amount", source.amount, allocator); add(input, "real_member", source.real_output, allocator);
    add(input, "output_index", source.real_output_in_tx_index, allocator);
    add(input, "subaddress_major", entry.m_subaddr_index_major, allocator);
    add(input, "subaddress_minor", entry.m_subaddr_index_minor, allocator);
    add(input, "tx_public_key", hex(source.real_out_tx_key), allocator); add(input, "mask", hex(source.mask), allocator);
    input.AddMember("additional_tx_public_keys", public_keys(source.real_out_additional_tx_keys, allocator), allocator);
    for (size_t i = 0; i < source.outputs.size(); ++i) {
      const auto &member = source.outputs[i];
      require(!i || member.first > source.outputs[i - 1].first, "Input ring indices must be strictly increasing");
      Json item(rapidjson::kObjectType); add(item, "global_index", member.first, allocator);
      add(item, "public_key", hex(member.second.dest), allocator); add(item, "commitment", hex(member.second.mask), allocator);
      ring.PushBack(item, allocator);
    }
    input.AddMember("ring", ring, allocator); inputs.PushBack(input, allocator); sum(total_in, source.amount);
  }
  unsigned change_count = 0, recipient_count = 0, dummy_count = 0;
  for (const auto &dest : construction.splitted_dsts) {
    require(!dest.is_integrated, "Integrated addresses are unsupported");
    if (dest.amount == 0) {
      // Core appends a random standard-address zero output when a single
      // recipient consumes all inputs after the fee. It is not wallet change;
      // authenticate its exact metadata without weakening positive-change checks.
      require(++dummy_count == 1 && construction.splitted_dsts.size() == 2 &&
          construction.change_dts.amount == 0 && dest.addr == construction.change_dts.addr &&
          !dest.is_subaddress && !construction.change_dts.is_subaddress && !construction.change_dts.is_integrated,
          "Invalid zero-value dummy output");
    }
    const std::string address = cryptonote::get_account_address_as_str(cryptonote::MAINNET, dest.is_subaddress, dest.addr);
    require(address.size() == 95, "Invalid destination address length");
    const bool change = construction.change_dts.amount > 0 && dest.addr == construction.change_dts.addr;
    cryptonote::subaddress_index index{};
    if (change) {
      require(++change_count == 1 && dest.amount == construction.change_dts.amount, "Ambiguous change outputs");
      const auto known = wallet.get_subaddress_index(dest.addr);
      if (known) index = *known;
      else index = {construction.subaddr_account, 0};
      require(wallet.get_subaddress(index) == dest.addr && dest.is_subaddress == (index.major || index.minor),
              "Change address is not a recognized wallet subaddress");
    } else if (dest.amount > 0) ++recipient_count;
    Json value(rapidjson::kObjectType); add(value, "amount", dest.amount, allocator); add(value, "address", address, allocator);
    value.AddMember("is_change", change, allocator); add(value, "change_major", index.major, allocator);
    add(value, "change_minor", index.minor, allocator); destinations.PushBack(value, allocator); sum(total_out, dest.amount);
  }
  require(recipient_count && total_in >= total_out, "Invalid transaction recipient set or totals");
  add(reply, "fee", total_in - total_out, allocator);
  reply.AddMember("inputs", inputs, allocator); reply.AddMember("outputs", destinations, allocator);
}
}

int main() {
  // Disable all Core logging before handling credentials: no log files and no
  // incidental diagnostic bytes in the JSON protocol.
  el::Configurations logging; logging.setToDefault();
  logging.setGlobally(el::ConfigurationType::Enabled, "false");
  logging.setGlobally(el::ConfigurationType::ToFile, "false");
  logging.setGlobally(el::ConfigurationType::ToStandardOutput, "false");
  el::Loggers::setDefaultConfigurations(logging, true); el::Loggers::reconfigureAllLoggers(logging);
  rapidjson::Document reply; reply.SetObject();
  int status = 0;
  try {
    WipedString input;
    char buffer[4096];
    while (std::cin.good()) {
      std::cin.read(buffer, sizeof(buffer));
      const auto got = std::cin.gcount();
      require(input.size() + got <= max_request, "JSON request exceeds 16 MiB bound");
      input.append(buffer, static_cast<size_t>(got));
    }
    memwipe(buffer, sizeof(buffer));
    Request request;
    require(!request.Parse(input.data(), input.size()).HasParseError() && request.IsObject(), "Invalid JSON request");
    const auto op = string_field(request, "op");
    require(op == "outputs" || op == "plan", "Unsupported adapter operation");
    for (auto member = request.MemberBegin(); member != request.MemberEnd(); ++member) {
      const std::string name(member->name.GetString(), member->name.GetStringLength());
      require(name == "op" || name == "address" || name == "view_key" || name == "outputs_data_hex" || name == "unsigned_txset",
              "Unknown request field (spend keys are never accepted)");
    }
    cryptonote::address_parse_info address{};
    const auto address_string = string_field(request, "address");
    require(address_string.size() == 95 && cryptonote::get_account_address_from_str(address, cryptonote::MAINNET, address_string) &&
        !address.is_subaddress && !address.has_payment_id, "A mainnet-format primary wallet address is required");
    WipedString view_bytes = unhex(string_field(request, "view_key"));
    require(view_bytes.size() == 32 && sc_check(reinterpret_cast<const unsigned char *>(view_bytes.data())) == 0,
            "Invalid canonical private view key");
    crypto::secret_key view;
    std::memcpy(&view, view_bytes.data(), 32);
    crypto::public_key view_public;
    require(crypto::secret_key_to_public_key(view, view_public) && view_public == address.address.m_view_public_key,
            "Private view key does not match wallet address");
    tools::wallet2 wallet(cryptonote::MAINNET, 1, true);
    wallet.set_subaddress_lookahead(1, 1);
    wallet.generate("", epee::wipeable_string(), address.address, view, false);
    require(wallet.watch_only(), "Adapter wallet must remain watch-only");
    const auto outputs = decode_outputs(wallet, string_field(request, "outputs_data_hex"));
    add(reply, "status", "pass", reply.GetAllocator());
    if (op == "outputs") {
      add(reply, "offset", std::get<0>(outputs), reply.GetAllocator());
      add(reply, "total", std::get<1>(outputs), reply.GetAllocator());
      Json values(rapidjson::kArrayType);
      for (size_t n = 0; n < std::get<2>(outputs).size(); ++n)
        values.PushBack(output_json(std::get<2>(outputs)[n], n, reply.GetAllocator()), reply.GetAllocator());
      reply.AddMember("outputs", values, reply.GetAllocator());
    } else make_plan(wallet, outputs, string_field(request, "unsigned_txset"), reply);
    // RapidJSON owns another copy of the view-key text; overwrite it before
    // releasing the request allocator. The wallet and Core secret types scrub.
    auto &secret = request["view_key"];
    memwipe(const_cast<char *>(secret.GetString()), secret.GetStringLength());
  } catch (const std::exception &error) {
    reply.SetObject(); add(reply, "status", "error", reply.GetAllocator());
    // Core exceptions may embed transaction/account data. Only emit our fixed
    // validation messages; other errors receive a generic public diagnostic.
    const auto *known = dynamic_cast<const AdapterError *>(&error);
    std::string message = known ? known->what() : "Core could not decode wallet data";
    if (message.size() > 160) message = "Core could not decode wallet data";
    add(reply, "error", message, reply.GetAllocator()); status = 1;
  } catch (...) {
    reply.SetObject(); add(reply, "status", "error", reply.GetAllocator());
    add(reply, "error", "Core could not decode wallet data", reply.GetAllocator()); status = 1;
  }
  rapidjson::StringBuffer output; rapidjson::Writer<rapidjson::StringBuffer> writer(output);
  reply.Accept(writer); std::cout.write(output.GetString(), output.GetSize()); std::cout << '\n';
  return status;
}
