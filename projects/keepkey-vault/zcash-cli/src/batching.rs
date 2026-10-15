//! Fit Ironwood spends to the KeepKey 7.15 per-transaction limits.
//!
//! Firmware 7.15 signs at most 16 Orchard-family actions per transaction.
//! When the notes needed for a payment would exceed that, the payment is split
//! into consecutive transactions over disjoint notes: every transaction but
//! the last spends 16 notes and pays all of them (minus its fee) to the
//! recipient, and the last one pays the rest with change. No transaction
//! depends on another, so they can be signed and broadcast back to back
//! without waiting for confirmations.

use orchard::{builder::BundleType, bundle::BundleVersion};

/// Firmware 7.15: Orchard-family actions per transaction.
pub const MAX_SHIELDED_ACTIONS: usize = 16;

const MARGINAL_FEE: u64 = 5000;
const GRACE_ACTIONS: u64 = 2;

/// What a spend pays to, which fixes its output shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendKind {
    /// Ironwood → Ironwood: payee output + change output.
    Shielded,
    /// Ironwood → transparent: one transparent output + Ironwood change.
    Deshield,
}

impl SpendKind {
    fn shielded_outputs(self) -> usize {
        match self {
            SpendKind::Shielded => 2,
            SpendKind::Deshield => 1,
        }
    }
    fn transparent_outputs(self) -> usize {
        match self {
            SpendKind::Shielded => 0,
            SpendKind::Deshield => 1,
        }
    }
}

/// Ironwood actions for this many spends and outputs, padded exactly as the
/// orchard builder pads them.
pub fn ironwood_actions(n_spends: usize, n_outputs: usize) -> usize {
    BundleType::DEFAULT
        .num_actions(
            BundleVersion::ironwood_v3().default_flags(),
            n_spends,
            n_outputs,
        )
        .expect("Ironwood bundles enable spends and outputs")
}

/// ZIP-317 fee: the final (padded) Ironwood action count plus one logical
/// action per transparent output.
pub fn spend_fee(n_spends: usize, kind: SpendKind) -> u64 {
    let logical = ironwood_actions(n_spends, kind.shielded_outputs()) as u64
        + kind.transparent_outputs() as u64;
    MARGINAL_FEE * std::cmp::max(GRACE_ACTIONS, logical)
}

/// The most notes one transaction of this kind can spend.
pub fn max_spends(kind: SpendKind) -> usize {
    (1..=MAX_SHIELDED_ACTIONS)
        .rev()
        .find(|&n| ironwood_actions(n, kind.shielded_outputs()) <= MAX_SHIELDED_ACTIONS)
        .expect("one spend always fits")
}

/// One transaction of a payment: which notes it spends (indices into the
/// caller's slice) and how the value splits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendStep {
    pub notes: Vec<usize>,
    pub pay: u64,
    pub fee: u64,
    pub change: u64,
}

/// Note indices worth spending, largest first. A note at or below the
/// marginal fee costs more to spend than it carries.
fn spend_order(values: &[u64]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..values.len())
        .filter(|&i| values[i] > MARGINAL_FEE)
        .collect();
    order.sort_by(|&a, &b| values[b].cmp(&values[a]).then(a.cmp(&b)));
    order
}

/// The most this wallet can pay with notes `values`, in as many
/// transactions as it takes.
pub fn max_spendable(values: &[u64], kind: SpendKind) -> u64 {
    spend_order(values)
        .chunks(max_spends(kind))
        .map(|chunk| {
            let sum: u64 = chunk.iter().map(|&i| values[i]).sum();
            sum.saturating_sub(spend_fee(chunk.len(), kind))
        })
        .sum()
}

/// Split a payment of `amount` over notes `values` into transactions that
/// each fit the firmware's action limit.
pub fn plan_spend(values: &[u64], amount: u64, kind: SpendKind) -> Result<Vec<SpendStep>, String> {
    if amount == 0 {
        return Err("Amount must be greater than zero".into());
    }
    let order = spend_order(values);
    let per_tx = max_spends(kind);
    let mut steps = Vec::new();
    let mut remaining = amount;
    let mut cursor = 0;

    while remaining > 0 {
        let rest = &order[cursor..];
        // Last transaction: the fewest of the remaining largest notes that
        // cover what is left plus their own fee.
        let mut sum = 0u64;
        for (k, &i) in rest.iter().take(per_tx).enumerate() {
            sum += values[i];
            let fee = spend_fee(k + 1, kind);
            if sum >= remaining.saturating_add(fee) {
                steps.push(SpendStep {
                    notes: rest[..=k].to_vec(),
                    pay: remaining,
                    fee,
                    change: sum - remaining - fee,
                });
                return Ok(steps);
            }
        }
        // Otherwise spend a full batch and pay all of it.
        let fee = spend_fee(per_tx, kind);
        if rest.len() <= per_tx || sum <= fee {
            return Err(format!(
                "Insufficient shielded funds: can send at most {} ZAT after fees, asked for {} ZAT",
                max_spendable(values, kind),
                amount
            ));
        }
        steps.push(SpendStep {
            notes: rest[..per_tx].to_vec(),
            pay: sum - fee,
            fee,
            change: 0,
        });
        remaining -= sum - fee;
        cursor += per_tx;
    }
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZEC: u64 = 100_000_000;

    fn check_plan(values: &[u64], amount: u64, kind: SpendKind, steps: &[SpendStep]) {
        let mut seen = std::collections::HashSet::new();
        let mut paid = 0;
        for s in steps {
            assert!(
                ironwood_actions(s.notes.len(), kind.shielded_outputs()) <= MAX_SHIELDED_ACTIONS
            );
            let sum: u64 = s.notes.iter().map(|&i| values[i]).sum();
            assert_eq!(sum, s.pay + s.fee + s.change, "value conserved");
            assert_eq!(s.fee, spend_fee(s.notes.len(), kind));
            assert!(s.pay > 0);
            for &i in &s.notes {
                assert!(seen.insert(i), "note {} spent twice", i);
            }
            paid += s.pay;
        }
        assert_eq!(paid, amount);
        // Only the last step may carry change.
        for s in &steps[..steps.len() - 1] {
            assert_eq!(s.change, 0);
        }
    }

    #[test]
    fn action_count_matches_the_orchard_builder() {
        assert_eq!(ironwood_actions(1, 2), 2);
        assert_eq!(ironwood_actions(16, 2), 16);
        assert_eq!(ironwood_actions(17, 2), 17);
        assert_eq!(ironwood_actions(0, 1), 2);
        assert_eq!(max_spends(SpendKind::Shielded), 16);
        assert_eq!(max_spends(SpendKind::Deshield), 16);
    }

    #[test]
    fn fees_match_the_previous_formulas() {
        // zip317_fee(n, 2) and zip317_deshield_fee(n) before this module.
        for n in 1..=16usize {
            let old_send = 5000 * std::cmp::max(2, std::cmp::max(n, 2)) as u64;
            let old_deshield = 5000 * (std::cmp::max(2, std::cmp::max(n, 1)) as u64 + 1);
            assert_eq!(spend_fee(n, SpendKind::Shielded), old_send);
            assert_eq!(spend_fee(n, SpendKind::Deshield), old_deshield);
        }
    }

    #[test]
    fn sixteen_notes_fit_one_transaction() {
        let values = vec![ZEC; 16];
        let amount = 16 * ZEC - spend_fee(16, SpendKind::Shielded);
        let steps = plan_spend(&values, amount, SpendKind::Shielded).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].notes.len(), 16);
        assert_eq!(steps[0].change, 0);
        check_plan(&values, amount, SpendKind::Shielded, &steps);
    }

    #[test]
    fn seventeen_notes_split_into_two() {
        let values = vec![ZEC; 17];
        let amount = 16 * ZEC; // needs a 17th note
        let steps = plan_spend(&values, amount, SpendKind::Shielded).unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].notes.len(), 16);
        assert_eq!(steps[1].notes.len(), 1);
        check_plan(&values, amount, SpendKind::Shielded, &steps);
    }

    #[test]
    fn small_payment_spends_only_the_largest_note() {
        let values = vec![10_000, 5 * ZEC, 20_000, ZEC];
        let steps = plan_spend(&values, ZEC, SpendKind::Deshield).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].notes, vec![1]);
        check_plan(&values, ZEC, SpendKind::Deshield, &steps);
    }

    #[test]
    fn forty_notes_send_everything_in_three_transactions() {
        let values: Vec<u64> = (1..=40).map(|i| i * 1_000_000).collect();
        for kind in [SpendKind::Shielded, SpendKind::Deshield] {
            let max = max_spendable(&values, kind);
            let steps = plan_spend(&values, max, kind).unwrap();
            assert_eq!(
                steps.iter().map(|s| s.notes.len()).collect::<Vec<_>>(),
                [16, 16, 8]
            );
            check_plan(&values, max, kind, &steps);
            assert!(plan_spend(&values, max + 1, kind).is_err());
        }
    }

    #[test]
    fn dust_notes_are_never_spent() {
        let values = vec![5000, ZEC, 4000];
        assert_eq!(max_spendable(&values, SpendKind::Shielded), ZEC - 10_000);
        let steps = plan_spend(&values, ZEC - 10_000, SpendKind::Shielded).unwrap();
        assert_eq!(steps[0].notes, vec![1]);
    }

    #[test]
    fn max_is_exact_for_mixed_wallets() {
        // Deterministic pseudo-random wallets: planning the max always
        // succeeds, one zatoshi more never does.
        let mut seed = 0x9e37_79b9u64;
        for n in [1usize, 2, 15, 16, 17, 31, 32, 33, 40, 57] {
            let values: Vec<u64> = (0..n)
                .map(|_| {
                    seed = seed
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    (seed >> 33) % (2 * ZEC) + 1
                })
                .collect();
            for kind in [SpendKind::Shielded, SpendKind::Deshield] {
                let max = max_spendable(&values, kind);
                if max == 0 {
                    continue;
                }
                let steps = plan_spend(&values, max, kind).unwrap();
                check_plan(&values, max, kind, &steps);
                assert!(plan_spend(&values, max + 1, kind).is_err());
            }
        }
    }

    #[test]
    fn insufficient_funds_is_an_error() {
        assert!(plan_spend(&[ZEC], ZEC, SpendKind::Shielded).is_err());
        assert!(plan_spend(&[], 1, SpendKind::Shielded).is_err());
        assert!(plan_spend(&[ZEC], 0, SpendKind::Shielded).is_err());
    }
}
