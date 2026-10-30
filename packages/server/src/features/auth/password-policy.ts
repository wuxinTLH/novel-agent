export type AuthSecurityProfile = 'local' | 'server';

/** New credentials only: existing hashes remain usable when changing deployment profile. */
export function validPassword(
  value: unknown,
  profile: AuthSecurityProfile = 'local',
  username = '',
): value is string {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 1024) return false;
  if (profile === 'local') return true;
  const characters = Array.from(value);
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
  const account = username.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return (
    characters.length >= 15 &&
    new Set(characters).size > 2 &&
    !/^(?:password|passw0rd|qwerty|letmein|welcome|changeme|admin|1234567890)(?:\d)*$/.test(normalized) &&
    !(account.length >= 3 && normalized.includes(account))
  );
}
