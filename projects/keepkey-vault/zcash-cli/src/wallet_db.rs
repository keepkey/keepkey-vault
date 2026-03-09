//! SQLite-backed wallet database for persisting scanned Orchard notes.
//!
//! Stores decrypted notes, scan progress, and nullifier tracking
//! to enable incremental scanning and spending.

use anyhow::{Result, Context};
use rusqlite::{Connection, params};
use std::path::PathBuf;
use log::{info, debug};

/// A scanned Orchard note with all fields needed to reconstruct it for spending.
#[derive(Debug, Clone)]
pub struct ScannedNote {
    pub value: u64,
    pub recipient: Vec<u8>,    // 43-byte Orchard address
    pub rho: [u8; 32],
    pub rseed: [u8; 32],
    pub cmx: [u8; 32],
    pub nullifier: [u8; 32],
    pub block_height: u64,
    pub tx_index: u32,
    pub action_index: u32,
}

/// A spendable (unspent) note with its database ID.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SpendableNote {
    pub id: i64,
    pub value: u64,
    pub recipient: Vec<u8>,
    pub rho: [u8; 32],
    pub rseed: [u8; 32],
    pub cmx: [u8; 32],
    pub nullifier: [u8; 32],
    pub block_height: u64,
    pub tx_index: u32,
    pub action_index: u32,
    pub position: Option<u64>,
}

pub struct WalletDb {
    conn: Connection,
}

impl WalletDb {
    /// Open the wallet database at the default location (~/.keepkey/zcash_wallet.db).
    pub fn open_default() -> Result<Self> {
        let db_dir = dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?
            .join(".keepkey");

        std::fs::create_dir_all(&db_dir)
            .context("Failed to create ~/.keepkey directory")?;

        let db_path = db_dir.join("zcash_wallet.db");
        Self::open(&db_path)
    }

    /// Open (or create) the wallet database at a specific path.
    pub fn open(path: &PathBuf) -> Result<Self> {
        debug!("Opening wallet database: {}", path.display());
        let conn = Connection::open(path)
            .context("Failed to open wallet database")?;

        let db = Self { conn };
        db.initialize_schema()?;
        Ok(db)
    }

    fn initialize_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY,
                value INTEGER NOT NULL,
                recipient BLOB NOT NULL,
                rho BLOB NOT NULL,
                rseed BLOB NOT NULL,
                cmx BLOB NOT NULL,
                nullifier BLOB NOT NULL UNIQUE,
                block_height INTEGER NOT NULL,
                tx_index INTEGER NOT NULL,
                action_index INTEGER NOT NULL,
                is_spent INTEGER NOT NULL DEFAULT 0,
                position INTEGER
            );

            CREATE TABLE IF NOT EXISTS scan_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tree_state (
                id INTEGER PRIMARY KEY,
                data BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fvk_store (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                ak BLOB NOT NULL,
                nk BLOB NOT NULL,
                rivk BLOB NOT NULL,
                ak_hash TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_notes_nullifier ON notes(nullifier);
            CREATE INDEX IF NOT EXISTS idx_notes_unspent ON notes(is_spent) WHERE is_spent = 0;
            "
        ).context("Failed to initialize database schema")?;

        // Migration: add position column if missing (for existing databases)
        let has_position = self.conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name='position'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0);
        if has_position == 0 {
            self.conn.execute("ALTER TABLE notes ADD COLUMN position INTEGER", [])
                .context("Failed to add position column")?;
            info!("Migrated notes table: added position column");
        }

        debug!("Database schema initialized");
        Ok(())
    }

    /// Get the last scanned block height, or None if never scanned.
    pub fn last_scanned_height(&self) -> Result<Option<u64>> {
        let result: Option<String> = self.conn.query_row(
            "SELECT value FROM scan_state WHERE key = 'last_scanned_height'",
            [],
            |row| row.get(0),
        ).ok();

        match result {
            Some(s) => Ok(Some(s.parse().context("Invalid last_scanned_height")?)),
            None => Ok(None),
        }
    }

    /// Update the last scanned block height.
    pub fn set_last_scanned_height(&self, height: u64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO scan_state (key, value) VALUES ('last_scanned_height', ?1)",
            params![height.to_string()],
        ).context("Failed to update scan height")?;
        Ok(())
    }

    /// Insert a newly discovered note.
    /// Returns true if the note was inserted, false if it already exists (duplicate nullifier).
    pub fn insert_note(&self, note: &ScannedNote) -> Result<bool> {
        let result = self.conn.execute(
            "INSERT OR IGNORE INTO notes (value, recipient, rho, rseed, cmx, nullifier, block_height, tx_index, action_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                note.value as i64,
                note.recipient,
                note.rho.as_slice(),
                note.rseed.as_slice(),
                note.cmx.as_slice(),
                note.nullifier.as_slice(),
                note.block_height as i64,
                note.tx_index as i64,
                note.action_index as i64,
            ],
        ).context("Failed to insert note")?;

        Ok(result > 0)
    }

    /// Mark a note as spent by its nullifier.
    pub fn mark_note_spent(&self, nullifier: &[u8; 32]) -> Result<bool> {
        let updated = self.conn.execute(
            "UPDATE notes SET is_spent = 1 WHERE nullifier = ?1 AND is_spent = 0",
            params![nullifier.as_slice()],
        ).context("Failed to mark note spent")?;

        if updated > 0 {
            debug!("Marked note as spent: {}", hex::encode(nullifier));
        }
        Ok(updated > 0)
    }

    /// Get all unspent notes that can be used for spending.
    pub fn get_spendable_notes(&self) -> Result<Vec<SpendableNote>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, value, recipient, rho, rseed, cmx, nullifier, block_height, tx_index, action_index, position
             FROM notes WHERE is_spent = 0 ORDER BY value DESC"
        )?;

        let notes = stmt.query_map([], |row| {
            let rho_blob: Vec<u8> = row.get(3)?;
            let rseed_blob: Vec<u8> = row.get(4)?;
            let cmx_blob: Vec<u8> = row.get(5)?;
            let nf_blob: Vec<u8> = row.get(6)?;

            let mut rho = [0u8; 32];
            let mut rseed = [0u8; 32];
            let mut cmx = [0u8; 32];
            let mut nullifier = [0u8; 32];
            rho.copy_from_slice(&rho_blob);
            rseed.copy_from_slice(&rseed_blob);
            cmx.copy_from_slice(&cmx_blob);
            nullifier.copy_from_slice(&nf_blob);

            Ok(SpendableNote {
                id: row.get(0)?,
                value: row.get::<_, i64>(1)? as u64,
                recipient: row.get(2)?,
                rho,
                rseed,
                cmx,
                nullifier,
                block_height: row.get::<_, i64>(7)? as u64,
                tx_index: row.get::<_, i64>(8)? as u32,
                action_index: row.get::<_, i64>(9)? as u32,
                position: row.get::<_, Option<i64>>(10)?.map(|p| p as u64),
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()
        .context("Failed to read spendable notes")?;

        Ok(notes)
    }

    /// Update the tree position for a note after computing it from the chain.
    pub fn update_note_position(&self, note_id: i64, position: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET position = ?1 WHERE id = ?2",
            params![position as i64, note_id],
        ).context("Failed to update note position")?;
        debug!("Updated note {} position to {}", note_id, position);
        Ok(())
    }

    /// Get the total balance of unspent notes (in zatoshis).
    pub fn get_balance(&self) -> Result<u64> {
        let balance: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(value), 0) FROM notes WHERE is_spent = 0",
            [],
            |row| row.get(0),
        )?;
        Ok(balance as u64)
    }

    /// Get total count of notes (spent + unspent).
    pub fn get_note_count(&self) -> Result<(u64, u64)> {
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM notes", [], |row| row.get(0),
        )?;
        let unspent: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE is_spent = 0", [], |row| row.get(0),
        )?;
        Ok((total as u64, unspent as u64))
    }

    /// Save the FVK to the database for auto-loading on restart.
    /// Stores an ak_hash fingerprint to detect firmware/basepoint changes.
    pub fn save_fvk(&self, fvk_bytes: &[u8; 96]) -> Result<()> {
        let ak_hash = hex::encode(&fvk_bytes[..8]); // First 8 bytes of ak as fingerprint
        self.conn.execute(
            "INSERT OR REPLACE INTO fvk_store (id, ak, nk, rivk, ak_hash) VALUES (1, ?1, ?2, ?3, ?4)",
            params![
                &fvk_bytes[..32],
                &fvk_bytes[32..64],
                &fvk_bytes[64..96],
                &ak_hash,
            ],
        ).context("Failed to save FVK")?;
        info!("FVK saved to database (ak_hash={})", ak_hash);
        Ok(())
    }

    /// Load a previously saved FVK, or None if no FVK has been stored.
    pub fn load_fvk(&self) -> Result<Option<[u8; 96]>> {
        let result = self.conn.query_row(
            "SELECT ak, nk, rivk FROM fvk_store WHERE id = 1",
            [],
            |row| {
                let ak: Vec<u8> = row.get(0)?;
                let nk: Vec<u8> = row.get(1)?;
                let rivk: Vec<u8> = row.get(2)?;
                Ok((ak, nk, rivk))
            },
        );

        match result {
            Ok((ak, nk, rivk)) => {
                if ak.len() != 32 || nk.len() != 32 || rivk.len() != 32 {
                    return Err(anyhow::anyhow!("Corrupt FVK in database"));
                }
                let mut fvk_bytes = [0u8; 96];
                fvk_bytes[..32].copy_from_slice(&ak);
                fvk_bytes[32..64].copy_from_slice(&nk);
                fvk_bytes[64..96].copy_from_slice(&rivk);
                Ok(Some(fvk_bytes))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Failed to load FVK: {}", e)),
        }
    }

    /// Delete all data for a full rescan, including stored FVK.
    pub fn reset(&self) -> Result<()> {
        self.conn.execute_batch(
            "DELETE FROM notes;
             DELETE FROM scan_state;
             DELETE FROM tree_state;
             DELETE FROM fvk_store;"
        ).context("Failed to reset wallet database")?;
        info!("Wallet database reset for rescan (FVK cleared)");
        Ok(())
    }

    /// Check if a new FVK matches the stored one (by ak fingerprint).
    /// Returns true if they match or no FVK is stored yet.
    pub fn fvk_matches(&self, new_fvk_bytes: &[u8; 96]) -> Result<bool> {
        let new_hash = hex::encode(&new_fvk_bytes[..8]);
        let result = self.conn.query_row(
            "SELECT ak_hash FROM fvk_store WHERE id = 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        );
        match result {
            Ok(Some(stored_hash)) => Ok(stored_hash == new_hash),
            Ok(None) | Err(rusqlite::Error::QueryReturnedNoRows) => Ok(true),
            Err(e) => Err(anyhow::anyhow!("Failed to check FVK: {}", e)),
        }
    }
}
