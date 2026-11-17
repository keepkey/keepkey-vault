// Public, offline decoder fixtures only. No device, wallet RPC, signing or relay.
// Parse the existing published Core containers, change construction metadata,
// then authenticate it again with the same published test-only view key.
#include <algorithm>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include "wallet/wallet2.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "serialization/binary_archive.h"
#include "rapidjson/document.h"
#include "rapidjson/prettywriter.h"
#include "rapidjson/stringbuffer.h"

template<class T> std::string dump(T &value) {
  std::ostringstream stream;
  binary_archive<true> archive(stream);
  if (!::serialization::serialize(archive, value)) throw std::runtime_error("serialize");
  return stream.str();
}
std::string read(const std::string &path) {
  std::ifstream file(path);
  if (!file) throw std::runtime_error("read fixture");
  return std::string(std::istreambuf_iterator<char>(file), {});
}
void write(const std::string &path, const rapidjson::Document &value) {
  rapidjson::StringBuffer bytes;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> writer(bytes);
  value.Accept(writer);
  std::ofstream file(path);
  file.write(bytes.GetString(), bytes.GetSize());
  file << '\n';
  if (!file) throw std::runtime_error("write fixture");
}
void generate(const std::string &directory, const std::string &kind) {
  rapidjson::Document request;
  const auto original = read(directory + "/" + (kind == "standard" ? "base" : "subaddress") + "-request.json");
  if (request.Parse(original.data(), original.size()).HasParseError()) throw std::runtime_error("request");
  crypto::secret_key view;
  if (!epee::string_tools::hex_to_pod(request["view_key"].GetString(), view)) throw std::runtime_error("view");
  cryptonote::address_parse_info address;
  if (!cryptonote::get_account_address_from_str(address, cryptonote::MAINNET, request["address"].GetString())) throw std::runtime_error("address");
  tools::wallet2 wallet(cryptonote::MAINNET, 1, true);
  wallet.set_subaddress_lookahead(1, 1);
  wallet.generate("", epee::wipeable_string(), address.address, view, false);
  std::string encoded;
  if (!epee::string_tools::parse_hexstr_to_binbuff(request["unsigned_txset"].GetString(), encoded)) throw std::runtime_error("unsigned hex");
  tools::wallet2::unsigned_tx_set txset;
  if (!wallet.parse_unsigned_tx_from_str(encoded, txset) || txset.txes.size() != 1) throw std::runtime_error("unsigned fixture");
  const auto original_data = txset.txes.front();
  if (original_data.splitted_dsts.size() != 2 || !original_data.change_dts.amount) throw std::runtime_error("base construction");
  uint64_t total = 0, old_outputs = 0;
  for (const auto &source : original_data.sources) total += source.amount;
  for (const auto &dest : original_data.splitted_dsts) old_outputs += dest.amount;
  if (total < old_outputs) throw std::runtime_error("base totals");
  auto recipient = original_data.splitted_dsts.front();
  for (const auto &dest : original_data.splitted_dsts)
    if (!(dest.addr == original_data.change_dts.addr)) recipient = dest;
  recipient.amount = old_outputs;
  // This recovery scalar is deliberately public fixture material. It creates a
  // repeatable, standard address for Core's random zero-value change output.
  crypto::secret_key seed;
  if (!epee::string_tools::hex_to_pod(std::string("25") + std::string(62, '0'), seed)) throw std::runtime_error("dummy seed");
  cryptonote::account_base account;
  account.generate(seed, true, false);
  cryptonote::tx_destination_entry dummy;
  dummy.amount = 0;
  dummy.addr = account.get_keys().m_account_address;
  dummy.is_subaddress = false;
  dummy.is_integrated = false;
  auto sweep = original_data;
  sweep.dests = {recipient};
  sweep.change_dts = dummy;
  sweep.splitted_dsts = {recipient, dummy};

  auto emit = [&](const std::string &name, const tools::wallet2::tx_construction_data &data) {
    txset.txes.front() = data;
    const auto bytes = std::string("Monero unsigned tx set\005") + wallet.encrypt_with_view_secret_key(dump(txset));
    const auto hex = epee::string_tools::buff_to_hex_nodelimer(bytes);
    request["unsigned_txset"].SetString(hex.data(), hex.size(), request.GetAllocator());
    write(directory + "/" + name + "-request.json", request);
    if (name.find("sweep-") != 0) return;
    rapidjson::Document outputs;
    outputs.SetArray();
    auto &allocator = outputs.GetAllocator();
    for (const auto &dest : data.splitted_dsts) {
      rapidjson::Value output(rapidjson::kObjectType);
      const auto address = cryptonote::get_account_address_as_str(cryptonote::MAINNET, dest.is_subaddress, dest.addr);
      output.AddMember("amount", dest.amount, allocator);
      output.AddMember("address", rapidjson::Value(address.data(), address.size(), allocator), allocator);
      output.AddMember("is_change", false, allocator);
      output.AddMember("change_major", 0, allocator);
      output.AddMember("change_minor", 0, allocator);
      outputs.PushBack(output, allocator);
    }
    write(directory + "/" + name + "-expected-outputs.json", outputs);
  };
  emit("sweep-" + kind + "-dummy-last", sweep);
  auto reversed = sweep;
  std::reverse(reversed.splitted_dsts.begin(), reversed.splitted_dsts.end());
  emit("sweep-" + kind + "-dummy-first", reversed);
  if (kind != "standard") return;

  auto invalid = sweep;
  invalid.change_dts.addr = recipient.addr;
  emit("invalid-sweep-mismatched-dummy", invalid);
  invalid = sweep;
  invalid.change_dts.amount = 1;
  emit("invalid-sweep-positive-change", invalid);
  invalid = sweep;
  invalid.splitted_dsts.back().is_subaddress = true;
  invalid.change_dts.is_subaddress = true;
  emit("invalid-sweep-subaddress-dummy", invalid);
  invalid = sweep;
  invalid.splitted_dsts.front().amount = 0;
  emit("invalid-sweep-all-zero", invalid);
  invalid = sweep;
  invalid.splitted_dsts.push_back(dummy);
  emit("invalid-sweep-multiple-dummy", invalid);
  invalid = sweep;
  auto extra = recipient;
  extra.amount = 1;
  --invalid.splitted_dsts.front().amount;
  invalid.splitted_dsts.push_back(extra);
  emit("invalid-sweep-three-outputs", invalid);
  invalid = original_data;
  for (auto &dest : invalid.splitted_dsts)
    if (dest.addr == invalid.change_dts.addr) dest.addr = dummy.addr;
  invalid.change_dts.addr = dummy.addr;
  emit("invalid-forged-positive-change", invalid);
  std::cout << "Created authenticated public standard/subaddress sweep and refusal fixtures\n";
}
int main(int argc, char **argv) {
  if (argc != 2) throw std::runtime_error("usage: make-sweep-fixtures FIXTURE_DIRECTORY");
  el::Configurations logging;
  logging.setToDefault();
  logging.setGlobally(el::ConfigurationType::Enabled, "false");
  logging.setGlobally(el::ConfigurationType::ToFile, "false");
  logging.setGlobally(el::ConfigurationType::ToStandardOutput, "false");
  el::Loggers::setDefaultConfigurations(logging, true);
  el::Loggers::reconfigureAllLoggers(logging);
  generate(argv[1], "standard");
  generate(argv[1], "subaddress");
}
