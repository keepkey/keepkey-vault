# Manual password rotation from Chrome Checkup

Chrome keeps the compromised-password list in its own interface. Open `chrome://password-manager/checkup/compromised` in the Chrome profile with your saved passwords and choose one account at a time.

1. In **Vault → Passwords**, unlock the bank for the current KeepKey wallet. Create or select the entry for the login domain and account label. Approve **Find password bank** on your KeepKey when starting a new wallet session.
2. Stage the replacement and approve generation on your KeepKey. Use **Open website** to save the encrypted submission record in Vault’s database and begin the change.
3. Use **Copy** on the staged password in Vault and paste it into the website’s new-password fields. Copy works while the password is masked. Rehydrate it with KeepKey if the local cache has expired.
4. Complete the website’s authentication and MFA, submit the change, and accept Chrome’s **Save** or **Update** prompt. If the prompt is missed, update that exact password record in Chrome.
5. Verify a fresh sign-in with Chrome autofill. Then finish the change in Vault. Vault encrypts the verified entry and saves it to its database.

If a submission is uncertain, keep both password locations and resume at sign-in verification. Recovery requires the same seed and wallet passphrase plus the encrypted bank record. A working Vault database already contains that record. If you lose it, recovery requires a copy of the database or an existing encrypted backup. The seed and passphrase alone cannot identify the accounts or slots. Use **Options → Restore previous password bank** to open a compatible bank from an earlier Vault installation or preview on this computer. Updated Vault can also restore older backups and reproduce every previously allocated password. Newly allocated passwords have 24 characters and exactly one symbol from `!@#$%^&*`. After the first new allocation, the stored bank uses format version 2 and requires an updated Vault to open.

The earlier pilot restored 43 synthetic profiles from an encrypted backup using 86 of the bank’s 4,096 lifetime slots. Its Checkup intake and paired migration operations are retired.
