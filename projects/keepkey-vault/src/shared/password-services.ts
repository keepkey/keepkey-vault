/** Shipped, bounded recipes. No runtime download/eval of third-party scripts. */
export const PASSWORD_SERVICE_HELPERS = [
  {
    id: 'google', name: 'Google Account', version: 1,
    matchOrigins: ['https://mail.google.com', 'https://accounts.google.com', 'https://myaccount.google.com'],
    loginOrigin: 'https://accounts.google.com', settingsUrl: 'https://myaccount.google.com/security',
    sourceUrl: 'https://support.google.com/accounts/answer/41078',
    instructions: [
      'Gmail uses the Google Account password. Identify the exact signed-in email from the account control or tab title; never read inbox messages to identify it.',
      'Create/find the Vault profile under https://accounts.google.com and the exact email. Do not store it as a mail.google.com password.',
      'Check an existing submitted rotation first. Do not allocate another password or resubmit if the previous result is uncertain.',
      'Stage a new slot. Export and save the encrypted backup containing both locations; acknowledge the saved revision. Record the submitted/uncertain state BEFORE the website mutation.',
      'Open Google Account → Security and sign-in → Password. Verify the same email again. Let the user complete existing-password, passkey and MFA challenges without exposing values to the agent.',
      'Discover BEX password fields on the exact Google origin. Queue separate Vault-approved fills for new password and confirmation using pending=true. Never use bex_type with password text.',
      'The user has authorized rotation only for the identified account. Explain that changing it signs out many sessions. If account/scope changed, clarify before submission. Submit once, then check the result.',
      'Verify a fresh sign-in with the staged password; an existing Gmail session is not proof. Keep browser fill pending=true until the rotation is verified. Do not invoke final activation without explicit user confirmation or independently verified fresh-login evidence.',
      'Activate only the verified new slot, export the updated recovery manifest, and leave ambiguous results in submitted state with both locations preserved.',
    ],
  },
  {
    id: 'github', name: 'GitHub', version: 1,
    matchOrigins: ['https://github.com'], loginOrigin: 'https://github.com', settingsUrl: 'https://github.com/settings/security',
    sourceUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/updating-your-github-access-credentials',
    instructions: [
      'Identify the exact GitHub username before modifying its password. SSO-managed accounts may require their identity provider instead.',
      'Use the shared stage → save encrypted backup → mark submitted → approved field fills → submit once → verify fresh sign-in → activate flow.',
      'Open account security/password settings, confirm the username, and leave existing-password, sudo-mode, passkey and MFA challenges to the user.',
      'Fill password/confirmation through opaque Vault approval requests on https://github.com. Never expose values in browser typing, snapshots or logs.',
      'Do not treat existing authenticated tabs or a click as verification; preserve both slots on an ambiguous result.',
    ],
  },
  {
    id: 'microsoft', name: 'Microsoft personal account', version: 1,
    matchOrigins: ['https://login.live.com', 'https://account.microsoft.com', 'https://account.live.com'], loginOrigin: 'https://login.live.com', settingsUrl: 'https://account.microsoft.com/security',
    sourceUrl: 'https://support.microsoft.com/account-billing/change-your-microsoft-account-password-fdde885b-86da-2965-69fd-4871309ef1f1',
    instructions: [
      'Identify the exact personal-account email. Work/school tenant credentials have a different administrator/identity-provider flow; stop and select the correct helper.',
      'Use the shared stage → save encrypted backup → mark submitted → approved field fills → submit once → verify fresh sign-in → activate flow.',
      'Open Microsoft account security and password settings. Recheck the email and let the user complete existing-password, authenticator and recovery challenges.',
      'The official Change Password link opens https://account.live.com. Use opaque Vault-approved fills on the explicitly allowed login/settings origins. Do not let an arbitrary redirect expand the origin grant.',
      'Keep both slots until a fresh sign-in with the staged password is verified. Preserve submitted state on an uncertain result.',
    ],
  },
] as const

export function passwordServiceHelper(id: string) {
  const helper = PASSWORD_SERVICE_HELPERS.find(h => h.id === id)
  if (!helper) throw new Error('Unsupported service helper')
  return helper
}
