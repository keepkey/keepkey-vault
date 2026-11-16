//! Offline reference checks using the published NU7 consensus implementation.
//! Run with `cargo test --locked --manifest-path tests/nu7-reference/Cargo.toml`.

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use zcash_primitives::transaction::{
        self,
        sighash::{PrecomputedSighashData, SignableInput},
        Transaction, TxVersion,
    };
    use zcash_protocol::{consensus::BranchId, value::Zatoshis};
    use zcash_transparent::{
        address::Script,
        bundle,
        sighash::{SighashType, TransparentAuthorizingContext},
    };

    #[derive(Clone, Deserialize)]
    struct Input {
        prevout_hash: String,
        prevout_index: u32,
        value: u64,
        sequence: u32,
        script_pubkey: String,
        sighash: String,
    }

    #[derive(Clone, Deserialize)]
    struct Output {
        value: u64,
        script_pubkey: String,
    }

    #[derive(Clone, Deserialize)]
    struct Fixture {
        branch_id: u32,
        tx_version: u32,
        version_group_id: u32,
        lock_time: u32,
        expiry_height: u32,
        raw_tx: String,
        txid: String,
        inputs: Vec<Input>,
        outputs: Vec<Output>,
    }

    fn fixture() -> Fixture {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/transparent-nu7.json");
        serde_json::from_slice(&std::fs::read(path).expect("public production-generated fixture"))
            .expect("fixture schema")
    }

    fn script(hex_value: &str) -> Script {
        let bytes = hex::decode(hex_value).expect("hex script");
        assert!(
            bytes.len() < 253,
            "fixtures only use standard transparent scripts"
        );
        let mut encoded = vec![bytes.len() as u8];
        encoded.extend_from_slice(&bytes);
        Script::read(&encoded[..]).expect("canonical script")
    }

    // Authorized transactions contain their scriptSigs but not the prior coins'
    // amounts/scripts. Supply this independent UTXO context for ZIP-244 S.2c/d.
    #[derive(Clone, Debug)]
    struct Prevouts {
        amounts: Vec<Zatoshis>,
        scripts: Vec<Script>,
    }

    impl bundle::Authorization for Prevouts {
        type ScriptSig = Script;
    }
    impl TransparentAuthorizingContext for Prevouts {
        fn input_amounts(&self) -> Vec<Zatoshis> {
            self.amounts.clone()
        }
        fn input_scriptpubkeys(&self) -> Vec<Script> {
            self.scripts.clone()
        }
    }
    impl bundle::MapAuth<bundle::Authorized, Prevouts> for Prevouts {
        fn map_script_sig(&self, value: Script) -> Script {
            value
        }
        fn map_authorization(&self, _: bundle::Authorized) -> Prevouts {
            self.clone()
        }
    }

    struct WithPrevouts;
    impl transaction::Authorization for WithPrevouts {
        type TransparentAuth = Prevouts;
        type SaplingAuth = <transaction::Authorized as transaction::Authorization>::SaplingAuth;
        type OrchardAuth = <transaction::Authorized as transaction::Authorization>::OrchardAuth;
    }

    fn read(raw: &str, branch: u32) -> Transaction {
        let bytes = hex::decode(raw).expect("raw transaction hex");
        let mut reader = &bytes[..];
        let tx = Transaction::read(
            &mut reader,
            BranchId::try_from(branch).expect("known branch"),
        )
        .expect("modern canonical transaction reader");
        assert!(
            reader.is_empty(),
            "canonical reader must consume the entire transaction"
        );
        tx
    }

    fn hashes(f: &Fixture) -> Vec<String> {
        let tx = read(&f.raw_tx, f.branch_id);
        let context = Prevouts {
            amounts: f
                .inputs
                .iter()
                .map(|i| Zatoshis::from_u64(i.value).expect("monetary amount"))
                .collect(),
            scripts: f.inputs.iter().map(|i| script(&i.script_pubkey)).collect(),
        };
        let tx = tx
            .into_data()
            .map_authorization::<WithPrevouts>(context, (), ());
        let precomputed = PrecomputedSighashData::new_zip244(tx).expect("ZIP-244 transaction");
        let bundle = precomputed
            .tx()
            .transparent_bundle()
            .expect("transparent bundle");
        f.inputs
            .iter()
            .enumerate()
            .map(|(index, input)| {
                let script = script(&input.script_pubkey);
                let signable = zcash_transparent::sighash::SignableInput::from_parts(
                    bundle,
                    SighashType::ALL,
                    index,
                    &script,
                    &script,
                    Zatoshis::from_u64(input.value).expect("input amount"),
                )
                .expect("in-range transparent input");
                hex::encode(
                    precomputed
                        .signature_hash(&SignableInput::Transparent(signable))
                        .as_ref(),
                )
            })
            .collect()
    }

    #[test]
    fn production_bytes_are_canonical_nu7_and_preserve_every_input_and_output() {
        let f = fixture();
        assert_eq!(f.branch_id, 0x7719_0ad9);
        assert_eq!(f.tx_version, 6);
        assert_eq!(f.version_group_id, 0xd884_b698);
        let tx = read(&f.raw_tx, f.branch_id);
        assert_eq!(tx.version(), TxVersion::V6);
        assert_eq!(tx.consensus_branch_id(), BranchId::Nu7);
        assert!(tx.version().valid_in_branch(BranchId::Nu7));
        assert_eq!(tx.lock_time(), f.lock_time);
        assert_eq!(u32::from(tx.expiry_height()), f.expiry_height);
        assert_eq!(hex::encode(tx.txid().as_ref()), f.txid);
        assert!(tx.sapling_bundle().is_none());
        assert!(tx.orchard_bundle().is_none());
        assert!(tx.ironwood_bundle().is_none());
        let bundle = tx.transparent_bundle().expect("transparent bundle");
        assert_eq!(bundle.vin.len(), f.inputs.len());
        assert_eq!(bundle.vout.len(), f.outputs.len());
        for (actual, expected) in bundle.vin.iter().zip(&f.inputs) {
            assert_eq!(hex::encode(actual.prevout().hash()), expected.prevout_hash);
            assert_eq!(actual.prevout().n(), expected.prevout_index);
            assert_eq!(actual.sequence(), expected.sequence);
        }
        for (actual, expected) in bundle.vout.iter().zip(&f.outputs) {
            assert_eq!(u64::from(actual.value()), expected.value);
            assert_eq!(actual.script_pubkey(), &script(&expected.script_pubkey));
        }
    }

    #[test]
    fn every_production_input_sighash_matches_the_independent_nu7_implementation() {
        let f = fixture();
        assert!(
            f.inputs.len() >= 2,
            "exercise distinct inputs and derivations"
        );
        assert_eq!(
            hashes(&f),
            f.inputs
                .iter()
                .map(|i| i.sighash.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn all_input_amounts_and_scripts_are_committed_even_when_signing_another_input() {
        let f = fixture();
        let original = hashes(&f);
        let mut changed = f.clone();
        changed.inputs[0].value += 1;
        assert!(hashes(&changed).iter().zip(&original).all(|(a, b)| a != b));
        let mut changed = f.clone();
        let mut bytes = hex::decode(&changed.inputs[0].script_pubkey).unwrap();
        bytes[3] ^= 1;
        changed.inputs[0].script_pubkey = hex::encode(bytes);
        assert!(hashes(&changed).iter().zip(&original).all(|(a, b)| a != b));
        assert_eq!(
            hex::encode(read(&f.raw_tx, f.branch_id).txid().as_ref()),
            f.txid,
            "UTXO context is authorizing data and must not change the transaction id"
        );
    }

    #[test]
    fn the_consensus_branch_and_every_output_are_committed_by_all_inputs() {
        let f = fixture();
        let original = hashes(&f);
        let mut changed = f.clone();
        let mut raw = hex::decode(&changed.raw_tx).unwrap();
        raw[8..12].copy_from_slice(&0x37a5_165bu32.to_le_bytes());
        changed.raw_tx = hex::encode(raw);
        assert!(hashes(&changed).iter().zip(&original).all(|(a, b)| a != b));

        let mut changed = f.clone();
        let mut raw = hex::decode(&changed.raw_tx).unwrap();
        let mut output = f.outputs[0].value.to_le_bytes().to_vec();
        let script = hex::decode(&f.outputs[0].script_pubkey).unwrap();
        output.push(script.len() as u8);
        output.extend_from_slice(&script);
        let matches = raw
            .windows(output.len())
            .enumerate()
            .filter_map(|(index, bytes)| (bytes == output).then_some(index))
            .collect::<Vec<_>>();
        assert_eq!(matches.len(), 1, "locate the exact serialized output once");
        raw[matches[0]] ^= 1;
        changed.raw_tx = hex::encode(raw);
        assert!(hashes(&changed).iter().zip(&original).all(|(a, b)| a != b));
        assert_ne!(
            hex::encode(read(&changed.raw_tx, f.branch_id).txid().as_ref()),
            f.txid
        );
    }

    #[test]
    fn nu7_disallows_v4_while_the_reviewed_modern_formats_remain_valid() {
        assert!(!TxVersion::V4.valid_in_branch(BranchId::Nu7));
        assert!(TxVersion::V5.valid_in_branch(BranchId::Nu7));
        assert!(TxVersion::V6.valid_in_branch(BranchId::Nu7));
    }
}
