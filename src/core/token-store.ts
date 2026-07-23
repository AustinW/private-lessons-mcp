/**
 * Token storage.
 *
 * Precedence: `PRIVATE_LESSONS_TOKEN` (env) wins, then the OS credential store.
 *
 * The credential store is `@napi-rs/keyring` — a maintained native binding over the
 * macOS Keychain, the Windows Credential Manager, and the Linux Secret Service.
 * (`keytar`, the usual choice, is archived and unmaintained.) It is an *optional*
 * dependency: on a platform with no prebuilt binary, or a headless box with no Secret
 * Service, the import fails and this module degrades to env-var-only. Nothing is ever
 * written to a plaintext file as a fallback — a silent downgrade from "in the keychain"
 * to "in a dotfile" is exactly the surprise a credential store exists to prevent.
 *
 * The token value is never accepted as an argv argument anywhere in this package.
 */

const SERVICE = 'private-lessons';
export const TOKEN_ENV_VAR = 'PRIVATE_LESSONS_TOKEN';

export type TokenSource = 'env' | 'keychain' | 'none';

export interface ResolvedToken {
  token: string;
  source: Exclude<TokenSource, 'none'>;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

let keyringPromise: Promise<KeyringModule | null> | undefined;

async function loadKeyring(): Promise<KeyringModule | null> {
  keyringPromise ??= import('@napi-rs/keyring')
    .then((mod) => mod as unknown as KeyringModule)
    .catch(() => null);
  return keyringPromise;
}

export class KeychainUnavailableError extends Error {
  constructor() {
    super(
      'No OS credential store is available on this platform (the optional ' +
        '@napi-rs/keyring binding could not be loaded). Set the ' +
        `${TOKEN_ENV_VAR} environment variable instead.`,
    );
    this.name = 'KeychainUnavailableError';
  }
}

/** Is a credential store usable in this process? */
export async function keychainAvailable(): Promise<boolean> {
  return (await loadKeyring()) !== null;
}

async function entryFor(profile: string): Promise<KeyringEntry> {
  const keyring = await loadKeyring();
  if (!keyring) throw new KeychainUnavailableError();
  return new keyring.Entry(SERVICE, profile);
}

/**
 * Resolve the token to use, or `null`.
 * Env wins so CI and container runs need no keychain at all.
 */
export async function getToken(profile = 'default'): Promise<ResolvedToken | null> {
  const fromEnv = process.env[TOKEN_ENV_VAR]?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  const keyring = await loadKeyring();
  if (!keyring) return null;
  try {
    const stored = new keyring.Entry(SERVICE, profile).getPassword();
    if (stored && stored.length > 0) return { token: stored, source: 'keychain' };
  } catch {
    // A locked or absent keychain is not an error here — it just means "no token".
  }
  return null;
}

/** Persist a token in the OS credential store. */
export async function setToken(token: string, profile = 'default'): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Refusing to store an empty token.');
  (await entryFor(profile)).setPassword(trimmed);
}

/** Remove a stored token. Returns whether anything was deleted. */
export async function deleteToken(profile = 'default'): Promise<boolean> {
  try {
    return (await entryFor(profile)).deletePassword();
  } catch (err) {
    if (err instanceof KeychainUnavailableError) throw err;
    return false;
  }
}

/**
 * A non-secret fingerprint for display: first 8 characters plus length.
 * Never print the token itself.
 */
export function fingerprint(token: string): string {
  const head = token.slice(0, 8);
  return `${head}… (${token.length} chars)`;
}
