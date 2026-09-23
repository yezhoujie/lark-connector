import { test } from 'node:test';
import assert from 'node:assert/strict';
import { both, en, fill, msg, resolveLang, selfCommand, zh } from '../src/texts.js';

const placeholders = (s: string): string[] => [...new Set(s.match(/\{[a-zA-Z_]+\}/g) ?? [])].sort();

test('zh and en share the same key set', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test('every zh/en pair carries the same placeholders', () => {
  for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `key "${key}"`);
  }
});

test('no wording is empty and nothing English-only contains Han characters', () => {
  for (const [key, value] of Object.entries(zh)) assert.ok(value.trim(), `zh.${key} is empty`);
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim(), `en.${key} is empty`);
    assert.doesNotMatch(value, /\p{Script=Han}/u, `en.${key}`);
  }
  for (const [key, value] of Object.entries(msg)) {
    assert.ok(value.trim(), `msg.${key} is empty`);
    assert.doesNotMatch(value, /\p{Script=Han}/u, `msg.${key}`);
  }
});

test('agent-facing wording uses ASCII whitespace only', () => {
  for (const [key, value] of Object.entries(msg)) {
    assert.doesNotMatch(value, /[\u00a0\u3000\u2000-\u200b]/, `msg.${key} contains a non-ASCII space`);
  }
});

test('fill substitutes every placeholder and leaves unknown braces alone', () => {
  assert.equal(fill('"{label}" is final ({label}); {n} left', { label: 'Drop', n: 2 }), '"Drop" is final (Drop); 2 left');
  assert.equal(fill('{a} {b}', { a: 'x' }), 'x {b}');
});

test('the five herdr prompt failure codes have card wording in both languages', () => {
  for (const key of ['promptAgentBlocked', 'promptPaneGone', 'promptNoHerdr', 'promptRefused', 'promptHerdrMissing'] as const) {
    assert.ok(zh[key].trim());
    assert.ok(en[key].trim());
  }
  assert.deepEqual(placeholders(zh.promptRefused), ['{code}', '{message}']);
  // Baked with ${CLI} at module load, like its sibling promptPaneGone — no
  // {cli} placeholder left for fill() to substitute at the call site.
  assert.deepEqual(placeholders(zh.promptHerdrMissing), []);
  assert.deepEqual(placeholders(en.promptHerdrMissing), []);
});

test('selfCommand: a given entry becomes node "<absolute path>"', () => {
  // Explicit 'darwin' so the POSIX resolver/escaping run on every host, not
  // whatever process.platform the test happens to execute on (win32 turns
  // this same input into a drive-letter path, which is covered separately).
  assert.equal(selfCommand('/a b/c.mjs', 'darwin'), 'node "/a b/c.mjs"');
});

test('selfCommand: a double quote in the path is escaped', () => {
  assert.equal(selfCommand('/a"b/c.mjs', 'darwin'), 'node "/a\\"b/c.mjs"');
});

test('selfCommand: win32 escapes only the double quote — backslashes in the path are left alone', () => {
  assert.equal(selfCommand('C:\\Users\\x\\cli.mjs', 'win32'), 'node "C:\\Users\\x\\cli.mjs"');
  assert.equal(selfCommand('C:\\a "b"\\c.mjs', 'win32'), 'node "C:\\a \\"b\\"\\c.mjs"');
});

test('selfCommand: an empty entry returns a placeholder instead of throwing', () => {
  assert.equal(selfCommand(''), 'node "<path to agent-lark>/dist/cli.mjs"');
});

test('msg.awayNoCreds hands over a runnable node "<path>" command, not the bare CLI name', () => {
  assert.match(msg.awayNoCreds, /^No Feishu app credentials yet\. Run once: node "[^"]+" setup$/);
});

test('awayOnDaemonNoHerdr: the zh wording is exact — it is user-dictated, not a translation', () => {
  assert.equal(zh.awayOnDaemonNoHerdr, 'daemon 找不到 herdr，重启前你主动发的消息送不到，推荐让 agent 帮你重启 daemon 来使用完整功能。');
});

// ---- resolveLang: --lang > LARK_CONNECTOR_LANG > system locale > 'en' ----

test('resolveLang: an explicit value wins over everything else', () => {
  assert.equal(resolveLang('zh', { LARK_CONNECTOR_LANG: 'en', LANG: 'en_US.UTF-8' }), 'zh');
  assert.equal(resolveLang('en', { LARK_CONNECTOR_LANG: 'zh' }), 'en');
});

test('resolveLang: with no explicit value, LARK_CONNECTOR_LANG wins over the locale', () => {
  assert.equal(resolveLang(undefined, { LARK_CONNECTOR_LANG: 'zh', LANG: 'en_US.UTF-8' }), 'zh');
  assert.equal(resolveLang(undefined, { LARK_CONNECTOR_LANG: 'en', LC_ALL: 'zh_CN.UTF-8' }), 'en');
});

test('resolveLang: with neither explicit nor env, a zh-prefixed system locale picks zh', () => {
  assert.equal(resolveLang(undefined, { LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(resolveLang(undefined, { LC_ALL: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(resolveLang(undefined, { LC_MESSAGES: 'zh_CN.UTF-8' }), 'zh');
});

test('resolveLang: nothing given at all falls back to en', () => {
  assert.equal(resolveLang(undefined, {}), 'en');
  assert.equal(resolveLang(undefined, { LANG: 'fr_FR.UTF-8' }), 'en');
});

test('resolveLang: an invalid LARK_CONNECTOR_LANG fails loud rather than silently falling through to the locale', () => {
  assert.throws(() => resolveLang(undefined, { LARK_CONNECTOR_LANG: 'fr', LANG: 'zh_CN.UTF-8' }));
});

test('resolveLang: an invalid explicit value fails loud too, the same way, instead of falling through to env/locale', () => {
  assert.throws(() => resolveLang('fr', { LARK_CONNECTOR_LANG: 'zh', LANG: 'zh_CN.UTF-8' }));
});

test('both(): a single-line value is zh and en side by side; a multi-line value is the zh block, then the en block, never joined on one line', () => {
  assert.equal(both('setupMenuPrompt'), `${zh.setupMenuPrompt}　/　${en.setupMenuPrompt}`);
  const menu = both('setupMenu');
  assert.equal(menu, `${zh.setupMenu}\n${en.setupMenu}`);
  assert.doesNotMatch(menu, /　\/　/);
  const lines = menu.split('\n');
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.slice(0, 3), zh.setupMenu.split('\n'));
  assert.deepEqual(lines.slice(3), en.setupMenu.split('\n'));
});
