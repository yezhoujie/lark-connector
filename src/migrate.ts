// Carry-over from agent-lark, the name this program shipped under before.
// A machine set up under that name still has its state directory, its
// credentials and its project state directories filed under the old names;
// the first run of any command moves them, so nothing has to be set up
// twice. Only names change hands here: no file is deleted, no value is read
// from an old environment variable.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { configDir, configDirFor, defaultStore, keychainClear, keychainRead, keychainService, keychainWrite, type AppCreds } from './creds.js';
import { isDaemonListening } from './ipc.js';
import { defaultHomeDir, homeDir, ipcEndpointFor, projectStateDir } from './paths.js';
import { fill, msg } from './texts.js';

/** Every name the earlier version used; what sits under them is carried over. */
export const LEGACY = {
  name: 'agent-lark',
  homeDirName: '.agent-lark',
  configDirName: 'agent-lark',
  service: 'agent-lark',
  account: 'app',
  projectDirName: '.agent-lark',
  pipePrefix: 'agent-lark-',
  envPrefix: 'AGENT_LARK_',
} as const;

const ENV_PREFIX = 'LARK_CONNECTOR_';

/** The description the earlier daemon wrote on a group it created for `root`. */
export const legacyGroupMarker = (root: string): string => `${LEGACY.name} · ${root}`;

/** Where a daemon of the earlier version listens when its state directory is `legacyHome`. */
export const legacyIpcEndpoint = (legacyHome: string): string => ipcEndpointFor(legacyHome, LEGACY.pipePrefix);

/** A daemon of the earlier version still answers on its endpoint: nothing is moved under it. */
export class LegacyDaemonRunning extends Error {
  constructor(readonly endpoint: string) {
    super(`a daemon of the earlier version is still listening at ${endpoint}`);
    this.name = 'LegacyDaemonRunning';
  }
}

export interface MigrateDeps {
  /** The state directory of this run (`--home` / LARK_CONNECTOR_HOME included): when it is the old directory itself, nothing is moved from under it. */
  homeDir: () => string;
  /** Where the old state directory goes: the default location, whatever this run's `--home` says — a one-off `--home /tmp/x` must not swallow it. */
  defaultHomeDir: () => string;
  legacyHomeDir: () => string;
  configDir: () => string;
  legacyConfigDir: () => string;
  isLegacyDaemonListening: () => Promise<boolean>;
  /** null: no keychain on this platform, or credentials are not kept in one. */
  keychain: {
    read: (service: string) => AppCreds | null;
    write: (service: string, creds: AppCreds) => void;
    clear: (service: string) => void;
  } | null;
  /** The keychain service the credentials are filed under now. */
  service: string;
  env: NodeJS.ProcessEnv;
  stderr: (line: string) => void;
}

const defaultStderr = (line: string): void => {
  process.stderr.write(`${msg.prefix}${line}\n`);
};

function resolveDeps(partial: Partial<MigrateDeps>): MigrateDeps {
  const legacyHomeDir = partial.legacyHomeDir ?? (() => join(homedir(), LEGACY.homeDirName));
  return {
    homeDir: partial.homeDir ?? homeDir,
    defaultHomeDir: partial.defaultHomeDir ?? defaultHomeDir,
    legacyHomeDir,
    configDir: partial.configDir ?? configDir,
    legacyConfigDir: partial.legacyConfigDir ?? (() => configDirFor(LEGACY.configDirName)),
    isLegacyDaemonListening: partial.isLegacyDaemonListening ?? (() => isDaemonListening(1000, { endpoint: legacyIpcEndpoint(legacyHomeDir()) })),
    // Windows keeps the keychain equivalent as a file in the config directory,
    // which the directory move carries along.
    keychain:
      partial.keychain !== undefined
        ? partial.keychain
        : platform() !== 'win32' && defaultStore() === 'keychain'
          ? { read: keychainRead, write: (service, creds) => keychainWrite(creds, service), clear: keychainClear }
          : null,
    service: partial.service ?? keychainService(),
    env: partial.env ?? process.env,
    stderr: partial.stderr ?? defaultStderr,
  };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Outcome = { moved: string[]; warnings: string[] };

function warn(out: Outcome, stderr: (line: string) => void, line: string): void {
  out.warnings.push(line);
  stderr(line);
}

/**
 * Move directory `from` to `to` when only `from` exists. Both present: `from`
 * is left as it is and the caller is told — the user decides which to keep.
 */
function moveDir(from: string, to: string, out: Outcome, stderr: (line: string) => void): boolean {
  if (!existsSync(from)) return false;
  if (existsSync(to)) {
    warn(out, stderr, fill(msg.migrateBothExist, { old: from, current: to }));
    return false;
  }
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch (err) {
    warn(out, stderr, fill(msg.migrateMoveFailed, { from, to, error: errorText(err) }));
    return false;
  }
  out.moved.push(to);
  stderr(fill(msg.migrateMoved, { from, to }));
  return true;
}

/**
 * The keychain entry, when there is none under the current service: copied,
 * then the old one removed. Every failure ends in a warning that says what
 * to do by hand — a locked keychain must not turn every command into a crash,
 * and this step is not repeated (it runs only on the run that found the old
 * state directory), so the warning must not promise a retry.
 */
function moveKeychainEntry(kc: NonNullable<MigrateDeps['keychain']>, service: string, out: Outcome, stderr: (line: string) => void): void {
  try {
    if (kc.read(service) !== null) return;
    const creds = kc.read(LEGACY.service);
    if (!creds) return;
    kc.write(service, creds);
  } catch (err) {
    warn(out, stderr, fill(msg.migrateKeychainCopyFailed, { from: LEGACY.service, to: service, account: LEGACY.account, error: errorText(err) }));
    return;
  }
  out.moved.push(service);
  stderr(fill(msg.migrateKeychain, { from: LEGACY.service, to: service }));
  // keychainClear reports nothing either way (a missing entry and a refused
  // delete look the same to it), so whether the entry is gone is read back.
  let stillThere: boolean;
  try {
    kc.clear(LEGACY.service);
    stillThere = kc.read(LEGACY.service) !== null;
  } catch {
    stillThere = true;
  }
  if (stillThere) warn(out, stderr, fill(msg.migrateKeychainClearFailed, { service: LEGACY.service, account: LEGACY.account }));
}

/**
 * Carry over what the earlier version left in the user's account, in this
 * order: refuse while its daemon is still up (it would keep writing under the
 * old name); the state directory, to its default location; the config
 * directory; the keychain entry; then a warning for every environment
 * variable still under the old prefix. Every step is a no-op once done, so
 * running this on every command is fine.
 */
export async function migrateLegacy(deps: Partial<MigrateDeps> = {}): Promise<Outcome> {
  const d = resolveDeps(deps);
  const out: Outcome = { moved: [], warnings: [] };

  // The old directory may be this run's own state directory (LARK_CONNECTOR_HOME
  // pointed at it): the daemon answering there is the current one, and the
  // directory is in use — neither the guard nor the move applies.
  const legacyHome = d.legacyHomeDir();
  const leftover = resolve(legacyHome) !== resolve(d.homeDir()) && existsSync(legacyHome);
  if (leftover && (await d.isLegacyDaemonListening())) throw new LegacyDaemonRunning(legacyIpcEndpoint(legacyHome));

  if (leftover) moveDir(legacyHome, d.defaultHomeDir(), out, d.stderr);
  moveDir(d.legacyConfigDir(), d.configDir(), out, d.stderr);

  // Only on the run that found the old directory: a locked keychain prompts
  // or fails on every read, and the entry has to be looked for just once.
  if (leftover && d.keychain) moveKeychainEntry(d.keychain, d.service, out, d.stderr);

  // Names only: an old variable's value is never consulted, so a setting the
  // user forgot to rename cannot silently keep working under the old name.
  const stale = Object.keys(d.env).filter((k) => k.startsWith(LEGACY.envPrefix));
  if (stale.length) {
    const pairs = stale.map((k) => `${k} → ${ENV_PREFIX}${k.slice(LEGACY.envPrefix.length)}`).join(', ');
    warn(out, d.stderr, fill(msg.migrateEnvVars, { pairs }));
  }
  return out;
}

/**
 * The project's state directory under the earlier name becomes the current
 * one. Called wherever a command has just resolved its project root, before
 * anything reads or writes the state file. True when a move happened.
 */
export function migrateProjectState(root: string, deps: Partial<Pick<MigrateDeps, 'stderr'>> = {}): boolean {
  const out: Outcome = { moved: [], warnings: [] };
  return moveDir(join(root, LEGACY.projectDirName), projectStateDir(root), out, deps.stderr ?? defaultStderr);
}
