// A state directory whose `daemon.sock` path is exactly as long as a test
// needs: the platform's Unix socket path limit is a number of bytes, so the
// directory is padded to hit it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates and returns a directory under tmpdir() whose `daemon.sock` path is `bytes` long. */
export function homeOfSockBytes(bytes: number, prefix = 'al-sock-'): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const withOneChar = Buffer.byteLength(join(base, 'x', 'daemon.sock'), 'utf8');
  const pad = bytes - withOneChar + 1;
  assert.ok(pad >= 1, `tmpdir ${base} is too long to build a ${bytes}-byte socket path`);
  const home = join(base, 'p'.repeat(pad));
  mkdirSync(home);
  assert.equal(Buffer.byteLength(join(home, 'daemon.sock'), 'utf8'), bytes);
  return home;
}

/** Run `fn` with LARK_CONNECTOR_HOME pointed at `home`, then put the variable back. */
export function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.LARK_CONNECTOR_HOME;
  process.env.LARK_CONNECTOR_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LARK_CONNECTOR_HOME;
    else process.env.LARK_CONNECTOR_HOME = prev;
  }
}
