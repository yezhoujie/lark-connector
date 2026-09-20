// What a machine set up under the earlier name (agent-lark) leaves behind, and
// how the first run carries it over: directories, the keychain entry, the
// project state directory. Everything runs in temporary directories with an
// injected keychain; the real one is never read.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppCreds } from '../src/creds.js';
import { LEGACY, LegacyDaemonRunning, legacyGroupMarker, legacyIpcEndpoint, migrateLegacy, migrateProjectState, type MigrateDeps } from '../src/migrate.js';

const scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const plant = (dir: string, file: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), 'x\n');
};

/**
 * Four directory slots (old / new × home / config) under one scratch root,
 * planted as asked, and deps that point the migration at them: the run's
 * own state directory elsewhere (and absent), no daemon listening, no
 * keychain, an empty environment.
 */
function scene(have: { oldHome?: boolean; newHome?: boolean; oldConfig?: boolean; newConfig?: boolean } = {}) {
  // A short prefix: `<old home>/daemon.sock` has to fit a Unix socket path.
  const base = tmp('al-mig-');
  const home = join(base, 'home', '.lark-connector');
  const legacyHome = join(base, 'home', LEGACY.homeDirName);
  const config = join(base, 'cfg', 'lark-connector');
  const legacyConfig = join(base, 'cfg', LEGACY.configDirName);
  if (have.oldHome) plant(legacyHome, 'bindings.json');
  if (have.newHome) plant(home, 'bindings.json');
  if (have.oldConfig) plant(legacyConfig, 'credentials.json');
  if (have.newConfig) plant(config, 'credentials.json');
  const lines: string[] = [];
  const deps: MigrateDeps = {
    homeDir: () => join(base, 'run'),
    defaultHomeDir: () => home,
    legacyHomeDir: () => legacyHome,
    configDir: () => config,
    legacyConfigDir: () => legacyConfig,
    isLegacyDaemonListening: async () => false,
    keychain: null,
    service: 'lark-connector-test',
    env: {},
    stderr: (line) => lines.push(line),
  };
  return { base, home, legacyHome, config, legacyConfig, deps, lines };
}

const creds: AppCreds = { appId: 'cli_old', appSecret: 'old-secret', ownerOpenId: 'ou_1' };

/** An in-memory keychain keyed by service; `clear` can be made to keep the entry or to throw, `write` to throw. */
function fakeKeychain(initial: Record<string, AppCreds> = {}, opts: { clear?: 'ok' | 'keeps' | 'throws'; writeThrows?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  const calls: string[] = [];
  const keychain: NonNullable<MigrateDeps['keychain']> = {
    read: (service) => {
      calls.push(`read ${service}`);
      return store.get(service) ?? null;
    },
    write: (service, creds) => {
      calls.push(`write ${service}`);
      if (opts.writeThrows) throw new Error('keychain is locked');
      store.set(service, creds);
    },
    clear: (service) => {
      calls.push(`clear ${service}`);
      if (opts.clear === 'throws') throw new Error('keychain says no');
      if (opts.clear !== 'keeps') store.delete(service);
    },
  };
  return { keychain, store, calls };
}

// ---- directories ---------------------------------------------------------------

test('only the old directories: both are moved, the old ones are gone, one stderr line each', async () => {
  const s = scene({ oldHome: true, oldConfig: true });
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r.moved, [s.home, s.config]);
  assert.deepEqual(r.warnings, []);
  assert.equal(existsSync(s.legacyHome), false, 'old home still there');
  assert.equal(existsSync(s.legacyConfig), false, 'old config still there');
  assert.ok(existsSync(join(s.home, 'bindings.json')));
  assert.ok(existsSync(join(s.config, 'credentials.json')));
  assert.equal(s.lines.length, 2, s.lines.join('\n'));
  assert.ok(s.lines[0]!.includes(s.legacyHome) && s.lines[0]!.includes(s.home), s.lines[0]);
  assert.ok(s.lines[1]!.includes(s.legacyConfig) && s.lines[1]!.includes(s.config), s.lines[1]);
});

test('the old home goes to the default location, not to the state directory this run was given', async () => {
  const s = scene({ oldHome: true });
  const runHome = s.deps.homeDir();
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r.moved, [s.home]);
  assert.ok(existsSync(join(s.home, 'bindings.json')));
  assert.equal(existsSync(runHome), false, 'the state directory of this run got the old home');
});

test('only the new directories: nothing moves, nothing is said', async () => {
  const s = scene({ newHome: true, newConfig: true });
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r, { moved: [], warnings: [] });
  assert.deepEqual(s.lines, []);
  assert.ok(existsSync(join(s.home, 'bindings.json')));
});

test('nothing at all: nothing moves, nothing is said, no directory appears', async () => {
  const s = scene();
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r, { moved: [], warnings: [] });
  assert.deepEqual(s.lines, []);
  assert.equal(existsSync(s.home), false);
  assert.equal(existsSync(s.config), false);
});

test('old and new home both present: the old one stays as it is, one warning naming both paths', async () => {
  const s = scene({ oldHome: true, newHome: true });
  writeFileSync(join(s.home, 'bindings.json'), 'new\n');
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r.moved, []);
  assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
  assert.ok(r.warnings[0]!.includes(s.legacyHome) && r.warnings[0]!.includes(s.home), r.warnings[0]);
  assert.ok(existsSync(join(s.legacyHome, 'bindings.json')), 'the old home was touched');
  assert.deepEqual(s.lines, r.warnings);
});

test('running it again after a move is a no-op', async () => {
  const s = scene({ oldHome: true, oldConfig: true });
  await migrateLegacy(s.deps);
  s.lines.length = 0;
  const again = await migrateLegacy(s.deps);
  assert.deepEqual(again, { moved: [], warnings: [] });
  assert.deepEqual(s.lines, []);
});

test('the old directory is the state directory of this run itself: no probe, no move, no warning, no keychain; config and environment still handled', async () => {
  const s = scene({ oldHome: true, oldConfig: true });
  s.deps.homeDir = () => s.legacyHome;
  s.deps.isLegacyDaemonListening = async () => {
    throw new Error('probed the endpoint of the current daemon');
  };
  const kc = fakeKeychain({ [LEGACY.service]: creds });
  s.deps.keychain = kc.keychain;
  s.deps.env = { AGENT_LARK_HOME: 'x' };
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r.moved, [s.config]);
  assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
  assert.match(r.warnings[0]!, /AGENT_LARK_HOME → LARK_CONNECTOR_HOME/);
  assert.ok(existsSync(join(s.legacyHome, 'bindings.json')), 'the directory in use was moved');
  assert.equal(existsSync(s.home), false);
  assert.deepEqual(kc.calls, []);
});

// ---- the daemon of the earlier name -------------------------------------------

test('an old daemon reported listening: LegacyDaemonRunning, nothing moved, nothing said', async () => {
  const s = scene({ oldHome: true, oldConfig: true });
  s.deps.isLegacyDaemonListening = async () => true;
  await assert.rejects(migrateLegacy(s.deps), LegacyDaemonRunning);
  assert.ok(existsSync(join(s.legacyHome, 'bindings.json')));
  assert.ok(existsSync(join(s.legacyConfig, 'credentials.json')));
  assert.equal(existsSync(s.home), false);
  assert.deepEqual(s.lines, []);
});

test('no old home directory: the old endpoint is not even probed', async () => {
  const s = scene({ oldConfig: true });
  let probed = false;
  s.deps.isLegacyDaemonListening = async () => {
    probed = true;
    return true;
  };
  const r = await migrateLegacy(s.deps);
  assert.equal(probed, false);
  assert.deepEqual(r.moved, [s.config]);
});

const pong = JSON.stringify({
  frame: 'result',
  body: { ok: true, kind: 'pong', status: { pid: 1, connection: 'fake', connected: true, lastError: null, pendingAsks: 0, bindings: 0, startedAt: '', media: { ttlDays: 7, files: 0, bytes: 0, at: '' } } },
});
/** A stand-in for the old daemon: answers every request on `endpoint` with a pong. */
function listenAt(endpoint: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      sock.on('data', () => {
        sock.write(`${pong}\n`);
        sock.end();
      });
    });
    server.on('error', reject);
    server.listen(endpoint, () => resolve(server));
  });
}

test('a daemon answering on the old endpoint for real: LegacyDaemonRunning; once it is gone the move goes ahead, a leftover socket file included', async () => {
  const s = scene({ oldHome: true });
  // The default probe, aimed at the old home this scene names.
  const { isLegacyDaemonListening: _probe, ...deps } = s.deps;
  const endpoint = legacyIpcEndpoint(s.legacyHome);
  if (platform() !== 'win32') assert.equal(endpoint, join(s.legacyHome, 'daemon.sock'));
  else assert.match(endpoint, /^\\\\\.\\pipe\\agent-lark-[0-9a-f]{12}$/);
  const server = await listenAt(endpoint);
  try {
    await assert.rejects(migrateLegacy(deps), LegacyDaemonRunning);
    assert.ok(existsSync(join(s.legacyHome, 'bindings.json')));
    assert.equal(existsSync(s.home), false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  // close() removed the socket file; a crash leaves one behind. A file
  // nobody answers on is not a daemon: it travels with the directory.
  if (platform() !== 'win32') writeFileSync(endpoint, '');
  const r = await migrateLegacy(deps);
  assert.deepEqual(r.moved, [s.home]);
  assert.equal(existsSync(s.legacyHome), false);
  if (platform() !== 'win32') assert.ok(existsSync(join(s.home, 'daemon.sock')), 'the leftover socket file did not travel');
});

// ---- the keychain entry ----------------------------------------------------------

test('keychain: nothing under the new service, an entry under the old one: written under the new, the old cleared', async () => {
  const s = scene({ oldHome: true });
  const kc = fakeKeychain({ [LEGACY.service]: creds });
  s.deps.keychain = kc.keychain;
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r.moved, [s.home, s.deps.service]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(kc.store.get(s.deps.service), creds);
  assert.equal(kc.store.has(LEGACY.service), false, 'the old entry is still there');
  assert.deepEqual(kc.calls, [`read ${s.deps.service}`, `read ${LEGACY.service}`, `write ${s.deps.service}`, `clear ${LEGACY.service}`, `read ${LEGACY.service}`]);
  assert.equal(s.lines.length, 2, s.lines.join('\n'));
  assert.ok(s.lines[1]!.includes(LEGACY.service) && s.lines[1]!.includes(s.deps.service), s.lines[1]);
});

test('keychain: an entry already under the new service: nothing written, the old entry left alone', async () => {
  const s = scene({ oldHome: true });
  const fresh: AppCreds = { appId: 'cli_new', appSecret: 'new-secret' };
  const kc = fakeKeychain({ [LEGACY.service]: creds, [s.deps.service]: fresh });
  s.deps.keychain = kc.keychain;
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r, { moved: [s.home], warnings: [] });
  assert.deepEqual(kc.store.get(s.deps.service), fresh);
  assert.deepEqual(kc.store.get(LEGACY.service), creds);
  assert.deepEqual(kc.calls, [`read ${s.deps.service}`]);
});

test('keychain: nothing under either service, or no keychain at all: nothing happens', async () => {
  const s = scene({ oldHome: true });
  const kc = fakeKeychain();
  s.deps.keychain = kc.keychain;
  assert.deepEqual(await migrateLegacy(s.deps), { moved: [s.home], warnings: [] });
  assert.deepEqual(kc.calls, [`read ${s.deps.service}`, `read ${LEGACY.service}`]);
  const t = scene({ oldHome: true });
  t.deps.keychain = null;
  assert.deepEqual(await migrateLegacy(t.deps), { moved: [t.home], warnings: [] });
});

test('keychain: consulted only on the run that finds the old home directory', async () => {
  const s = scene({ oldConfig: true });
  const kc = fakeKeychain({ [LEGACY.service]: creds });
  s.deps.keychain = kc.keychain;
  assert.deepEqual(await migrateLegacy(s.deps), { moved: [s.config], warnings: [] });
  assert.deepEqual(kc.calls, [], 'the keychain was read although there was no old home directory');
  assert.deepEqual(kc.store.get(LEGACY.service), creds);
  // the run that moved the directory is the one that copied the entry; the next run leaves the keychain alone
  const t = scene({ oldHome: true });
  const kt = fakeKeychain({ [LEGACY.service]: creds });
  t.deps.keychain = kt.keychain;
  await migrateLegacy(t.deps);
  assert.equal(kt.calls.length, 5, kt.calls.join(', '));
  await migrateLegacy(t.deps);
  assert.equal(kt.calls.length, 5, 'the keychain was read again on a run with nothing to move');
});

test('keychain: the old entry is still there after clear (clear kept it, or threw): the new entry stays, one warning naming service and account, still counted as moved', async () => {
  for (const clear of ['keeps', 'throws'] as const) {
    const s = scene({ oldHome: true });
    const kc = fakeKeychain({ [LEGACY.service]: creds }, { clear });
    s.deps.keychain = kc.keychain;
    const r = await migrateLegacy(s.deps);
    assert.deepEqual(r.moved, [s.home, s.deps.service], clear);
    assert.equal(r.warnings.length, 1, `${clear}: ${r.warnings.join('\n')}`);
    assert.ok(r.warnings[0]!.includes(`service ${LEGACY.service}`) && r.warnings[0]!.includes(`account ${LEGACY.account}`), r.warnings[0]);
    assert.deepEqual(kc.store.get(s.deps.service), creds);
    assert.deepEqual(kc.store.get(LEGACY.service), creds);
    assert.equal(s.lines.length, 3, `${clear}: ${s.lines.join('\n')}`);
  }
});

test('keychain: writing the new entry fails (locked keychain): one warning with the manual fallback, the old entry untouched, nothing counted as moved for it', async () => {
  const s = scene({ oldHome: true });
  const kc = fakeKeychain({ [LEGACY.service]: creds }, { writeThrows: true });
  s.deps.keychain = kc.keychain;
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r.moved, [s.home]);
  assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
  const w = r.warnings[0]!;
  for (const piece of ['keychain is locked', `service ${LEGACY.service}`, `account ${LEGACY.account}`, s.deps.service]) assert.ok(w.includes(piece), `${piece} missing from: ${w}`);
  assert.equal(kc.store.has(s.deps.service), false);
  assert.deepEqual(kc.store.get(LEGACY.service), creds);
  assert.deepEqual(kc.calls, [`read ${s.deps.service}`, `read ${LEGACY.service}`, `write ${s.deps.service}`]);
});

// ---- environment variables ------------------------------------------------------

test('AGENT_LARK_* in the environment: one warning pairing each old name with its new one; the values are never read', async () => {
  const s = scene();
  const env: NodeJS.ProcessEnv = { LARK_CONNECTOR_STORE: 'file', PATH: '/usr/bin' };
  for (const name of ['AGENT_LARK_APP_ID', 'AGENT_LARK_HOME']) {
    Object.defineProperty(env, name, {
      enumerable: true,
      get: () => {
        throw new Error(`${name} was read`);
      },
    });
  }
  s.deps.env = env;
  const r = await migrateLegacy(s.deps);
  assert.deepEqual(r.moved, []);
  assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
  const w = r.warnings[0]!;
  for (const name of ['AGENT_LARK_APP_ID', 'LARK_CONNECTOR_APP_ID', 'AGENT_LARK_HOME', 'LARK_CONNECTOR_HOME']) assert.ok(w.includes(name), `${name} missing from: ${w}`);
  assert.doesNotMatch(w, /LARK_CONNECTOR_STORE|PATH/);
  assert.deepEqual(s.lines, r.warnings);
});

test('no AGENT_LARK_* variable: no warning', async () => {
  const s = scene();
  s.deps.env = { LARK_CONNECTOR_STORE: 'file', AGENT_LARKISH: 'x' };
  assert.deepEqual(await migrateLegacy(s.deps), { moved: [], warnings: [] });
});

// ---- the project state directory --------------------------------------------------

test('migrateProjectState: only the old directory: moved, one stderr line, true', () => {
  const root = tmp('al-migrate-proj-');
  plant(join(root, LEGACY.projectDirName), 'state.json');
  const lines: string[] = [];
  assert.equal(migrateProjectState(root, { stderr: (l) => lines.push(l) }), true);
  assert.ok(existsSync(join(root, '.lark-connector', 'state.json')));
  assert.equal(existsSync(join(root, LEGACY.projectDirName)), false);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0]!.includes(join(root, LEGACY.projectDirName)) && lines[0]!.includes(join(root, '.lark-connector')), lines[0]);
});

test('migrateProjectState: both directories: neither is touched, false; neither directory: false and silent', () => {
  const root = tmp('al-migrate-proj-');
  plant(join(root, LEGACY.projectDirName), 'state.json');
  plant(join(root, '.lark-connector'), 'state.json');
  writeFileSync(join(root, '.lark-connector', 'state.json'), 'new\n');
  const lines: string[] = [];
  assert.equal(migrateProjectState(root, { stderr: (l) => lines.push(l) }), false);
  assert.ok(existsSync(join(root, LEGACY.projectDirName, 'state.json')));
  assert.equal(lines.length, 1, 'both directories present deserves a warning');
  const empty = tmp('al-migrate-proj-');
  lines.length = 0;
  assert.equal(migrateProjectState(empty, { stderr: (l) => lines.push(l) }), false);
  assert.deepEqual(lines, []);
  assert.equal(existsSync(join(empty, '.lark-connector')), false);
});

// ---- the group marker -------------------------------------------------------------------

test('legacyGroupMarker is the description the earlier daemon wrote', () => {
  assert.equal(legacyGroupMarker('/p'), 'agent-lark · /p');
  assert.deepEqual(LEGACY, {
    name: 'agent-lark',
    homeDirName: '.agent-lark',
    configDirName: 'agent-lark',
    service: 'agent-lark',
    account: 'app',
    projectDirName: '.agent-lark',
    pipePrefix: 'agent-lark-',
    envPrefix: 'AGENT_LARK_',
  });
});
