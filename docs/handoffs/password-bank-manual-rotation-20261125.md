# Manual password rotation from Chrome Checkup

Chrome keeps the compromised-password list in its own interface. Open `chrome://password-manager/checkup/compromised` in the Chrome profile with your saved passwords and choose one account at a time.

1. In **Vault → Passwords**, unlock the bank for the current KeepKey wallet. Create or select the entry for the login domain and account label.
2. Stage the replacement and approve generation on your KeepKey. Save the encrypted recovery backup and use **Open website** to begin the change.
3. Use **Copy** on the staged password in Vault and paste it into the website’s new-password fields. Copy works while the password is masked. Rehydrate it with KeepKey if the local cache has expired.
4. Complete the website’s authentication and MFA, submit the change, and accept Chrome’s **Save** or **Update** prompt. If the prompt is missed, update that exact password record in Chrome.
5. Verify a fresh sign-in with Chrome autofill. Then finish the change in Vault and save the final encrypted backup.

If a submission is uncertain, keep both password locations and resume at sign-in verification. Keep the encrypted manifest with your wallet recovery plan. Recovery requires the same seed and wallet passphrase. Updated Vault can restore older backups and reproduce every previously allocated password. Newly allocated passwords have 24 characters and exactly one symbol from `!@#$%^&*`. After the first new allocation, backups use version 2 and require an updated Vault to open.

The earlier pilot restored 43 synthetic profiles from an encrypted backup using 86 of the bank’s 4,096 lifetime slots. Its Checkup intake and paired migration operations are retired.
