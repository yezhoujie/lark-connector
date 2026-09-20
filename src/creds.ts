import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fill, msg } from './texts.js';

export interface AppCreds {
  appId: string;
  appSecret: string;
  /** open_id of the app owner; needed to seed a new group chat. */
  ownerOpenId?: string;
  brand?: string;
}

/** Which layer the credentials actually came from. Shown by `status`. */
export type CredSource = 'env' | 'keychain' | 'file';

export interface ResolvedCreds extends AppCreds {
  source: CredSource;
  /** Human-readable origin, safe to print. Never contains a secret. */
  origin: string;
}

export type StoreKind = 'keychain' | 'file' | 'none';

const SERVICE = process.env.LARK_CONNECTOR_KEYCHAIN?.trim() || 'lark-connector';
const ACCOUNT = 'app';

/** `$XDG_CONFIG_HOME/lark-connector`, i.e. `~/.config/lark-connector` by default. */
export const configDir = (): string => configDirFor('lark-connector');

/** The per-user config directory another program name would get on this platform. */
export function configDirFor(name: string): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(homedir(), platform() === 'win32' ? 'AppData/Roaming' : '.config');
  return join(base, name);
}

export const credentialsFile = (): string => join(configDir(), 'credentials.json');

/**
 * Which secret store `setup` writes to. Defaults to the OS keychain where one
 * is reachable, a 0600 file otherwise. `LARK_CONNECTOR_STORE` overrides.
 */
export function defaultStore(): StoreKind {
  const forced = process.env.LARK_CONNECTOR_STORE?.trim();
  if (forced === 'keychain' || forced === 'file' || forced === 'none') return forced;
  return keychainAvailable() ? 'keychain' : 'file';
}

/** The keychain service the credentials are filed under (`LARK_CONNECTOR_KEYCHAIN` overrides). */
export const keychainService = (): string => SERVICE;

/** Name of the per-platform secure store, for messages. */
export function keychainName(): string {
  switch (platform()) {
    case 'darwin':
      return msg.keychainDarwin;
    case 'win32':
      return msg.keychainWin32;
    default:
      return msg.keychainLinux;
  }
}

function has(cmd: string): boolean {
  try {
    execFileSync(platform() === 'win32' ? 'where' : 'sh', platform() === 'win32' ? [cmd] : ['-c', `command -v ${cmd}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function keychainAvailable(): boolean {
  if (platform() === 'darwin') return true;
  if (platform() === 'win32') return has('powershell');
  return has('secret-tool');
}

/** Windows has no keychain CLI; DPAPI-encrypting a file is the no-native-dep
 * equivalent — the blob is readable only by this user on this machine. */
const dpapiFile = (): string => join(configDir(), 'credentials.dpapi');

function psRun(script: string, input: string): string {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

function dpapiWrite(blob: string): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const enc = psRun(
    '$p = [Console]::In.ReadToEnd(); ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $p -AsPlainText -Force)',
    blob,
  );
  writeFileSync(dpapiFile(), `${enc}\n`, { mode: 0o600 });
}

function dpapiRead(): string | null {
  try {
    const enc = readFileSync(dpapiFile(), 'utf8').trim();
    if (!enc) return null;
    return psRun(
      '$e = [Console]::In.ReadToEnd().Trim(); ' +
        '$s = ConvertTo-SecureString -String $e; ' +
        '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
      enc,
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- keychain
// `service` selects the entry on macOS and Linux; Windows keeps one DPAPI
// file per config directory instead, so the argument means nothing there.

export function keychainRead(service = SERVICE): AppCreds | null {
  try {
    if (platform() === 'win32') {
      const raw = dpapiRead();
      return raw ? (JSON.parse(raw) as AppCreds) : null;
    }
    if (platform() === 'darwin') {
      const raw = execFileSync('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return raw ? (JSON.parse(raw) as AppCreds) : null;
    }
    const raw = execFileSync('secret-tool', ['lookup', 'service', service, 'account', ACCOUNT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw ? (JSON.parse(raw) as AppCreds) : null;
  } catch {
    return null;
  }
}

export function keychainWrite(creds: AppCreds, service = SERVICE): void {
  const blob = JSON.stringify(creds);
  if (platform() === 'win32') {
    dpapiWrite(blob);
    return;
  }
  if (platform() === 'darwin') {
    // -U updates in place. The blob travels in argv of `security` only; it is
    // never written to a file we control and never printed.
    execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', blob], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return;
  }
  execFileSync('secret-tool', ['store', '--label', 'lark-connector', 'service', service, 'account', ACCOUNT], {
    input: blob,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

export function keychainClear(service = SERVICE): void {
  try {
    if (platform() === 'win32') {
      if (existsSync(dpapiFile())) unlinkSync(dpapiFile());
      return;
    }
    if (platform() === 'darwin')
      execFileSync('security', ['delete-generic-password', '-s', service, '-a', ACCOUNT], { stdio: 'ignore' });
    else execFileSync('secret-tool', ['clear', 'service', service, 'account', ACCOUNT], { stdio: 'ignore' });
  } catch {
    // nothing stored
  }
}

// ---------------------------------------------------------------- file store

function fileRead(): AppCreds | null {
  const f = credentialsFile();
  try {
    const st = statSync(f);
    // 0600 is the contract; anything looser is a real exposure, not a nit.
    if (platform() !== 'win32' && (st.mode & 0o077) !== 0)
      process.stderr.write(`${fill(msg.credsPermWarning, { file: f, mode: (st.mode & 0o777).toString(8) })}\n`);
    return JSON.parse(readFileSync(f, 'utf8')) as AppCreds;
  } catch {
    return null;
  }
}

function fileWrite(creds: AppCreds): void {
  const f = credentialsFile();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, f);
}

// ---------------------------------------------------------------- resolution

function pair(id: string | undefined, secret: string | undefined): { appId: string; appSecret: string } | null {
  const a = id?.trim();
  const s = secret?.trim();
  return a && s ? { appId: a, appSecret: s } : null;
}

/**
 * Resolution order, highest first. Documented in README — users on a shared
 * machine need to know which layer wins.
 *
 *   1. LARK_CONNECTOR_APP_ID / LARK_CONNECTOR_APP_SECRET       (environment, a runtime override)
 *   2. the OS keychain                                  (what `setup` writes)
 *   3. <config>/credentials.json, mode 0600             (what `LARK_CONNECTOR_STORE=file`, or a platform without a keychain, writes)
 *
 * Nothing else is read: no env file, no unprefixed LARK_* names.
 */
export function resolveCreds(): ResolvedCreds | null {
  const prefixed = pair(process.env.LARK_CONNECTOR_APP_ID, process.env.LARK_CONNECTOR_APP_SECRET);
  if (prefixed)
    return { ...prefixed, ownerOpenId: process.env.LARK_CONNECTOR_OWNER_OPEN_ID?.trim(), source: 'env', origin: msg.originEnv };

  const kc = keychainRead();
  if (kc?.appId && kc.appSecret) return { ...kc, source: 'keychain', origin: `${keychainName()} (service: ${SERVICE})` };

  const f = fileRead();
  if (f?.appId && f.appSecret) return { ...f, source: 'file', origin: credentialsFile() };

  return null;
}

export function writeCreds(creds: AppCreds, store: StoreKind = defaultStore()): string {
  if (store === 'none') return msg.credsNotPersisted;
  if (store === 'keychain') {
    keychainWrite(creds);
    return `${keychainName()} (service: ${SERVICE})`;
  }
  fileWrite(creds);
  return credentialsFile();
}

export function clearCreds(): void {
  keychainClear();
  try {
    if (existsSync(credentialsFile())) unlinkSync(credentialsFile());
    if (existsSync(dpapiFile())) unlinkSync(dpapiFile());
  } catch {
    // best effort
  }
}

/** Every place credentials could come from, for `status` / diagnostics. */
export function credsReport(): string[] {
  const lines: string[] = [];
  const mark = (ok: boolean): string => (ok ? '✓' : '·');
  lines.push(`${mark(!!pair(process.env.LARK_CONNECTOR_APP_ID, process.env.LARK_CONNECTOR_APP_SECRET))} ${msg.reportEnv}`);
  lines.push(`${mark(!!keychainRead())} ${keychainName()} (service: ${SERVICE})${keychainAvailable() ? '' : msg.reportUnavailable}`);
  lines.push(`${mark(!!fileRead())} ${credentialsFile()}`);
  return lines;
}
