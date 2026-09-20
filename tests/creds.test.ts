// Credential resolution after the env file and the unprefixed LARK_* names were dropped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

// The keychain service name is read once at import time: point it at a
// service that never holds anything before the module loads.
process.env.LARK_CONNECTOR_KEYCHAIN = 'agent-lark-test-never-stored';
const { credsReport, resolveCreds, writeCreds } = await import('../src/creds.js');

const scratch: string[] = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function isolated(): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-creds-'));
  scratch.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  process.env.LARK_CONNECTOR_STORE = 'file';
  process.env.LARK_CONNECTOR_KEYCHAIN = 'agent-lark-test-never-stored';
  for (const k of ['LARK_CONNECTOR_APP_ID', 'LARK_CONNECTOR_APP_SECRET', 'LARK_CONNECTOR_OWNER_OPEN_ID', 'LARK_CONNECTOR_ENV_FILE', 'LARK_APP_ID', 'LARK_APP_SECRET']) delete process.env[k];
  return dir;
}

test('an env file is no longer read, even when LARK_CONNECTOR_ENV_FILE points at one; nor are LARK_APP_ID / LARK_APP_SECRET', () => {
  const dir = isolated();
  mkdirSync(join(dir, 'agent-lark'), { recursive: true });
  writeFileSync(join(dir, 'agent-lark', '.env'), 'LARK_CONNECTOR_APP_ID=cli_fromfile\nLARK_CONNECTOR_APP_SECRET=s\n');
  const other = join(dir, 'other.env');
  writeFileSync(other, 'LARK_CONNECTOR_APP_ID=cli_other\nLARK_CONNECTOR_APP_SECRET=s\n');
  process.env.LARK_CONNECTOR_ENV_FILE = other;
  process.env.LARK_APP_ID = 'cli_generic';
  process.env.LARK_APP_SECRET = 's';
  assert.equal(resolveCreds(), null);
  const report = credsReport();
  assert.equal(report.length, 3, report.join('\n'));
  assert.ok(report.every((l) => !/env file|(^|[^_])LARK_APP_ID/.test(l)), report.join('\n'));
});

test('the environment pair wins over the file store; the file store is 0600 and is what setup --reuse writes on a keychain-less box', () => {
  const dir = isolated();
  const where = writeCreds({ appId: 'cli_stored', appSecret: 'stored-secret', ownerOpenId: 'ou_1' }, 'file');
  assert.equal(where, join(dir, 'agent-lark', 'credentials.json'));
  // POSIX mode bits mean nothing on Windows (the file reads 0666 there); the same split as the warning in creds.ts.
  if (platform() !== 'win32') assert.equal(statSync(where).mode & 0o777, 0o600);
  assert.equal(resolveCreds()?.appId, 'cli_stored');
  assert.equal(resolveCreds()?.source, 'file');
  process.env.LARK_CONNECTOR_APP_ID = 'cli_env';
  process.env.LARK_CONNECTOR_APP_SECRET = 'env-secret';
  assert.equal(resolveCreds()?.appId, 'cli_env');
  assert.equal(resolveCreds()?.source, 'env');
});
