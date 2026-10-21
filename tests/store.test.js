/**
 * tests/store.test.js
 *
 * Automated tests for shared/chronicle-store.js.
 * Plain Node.js — no test framework required. Run with: node tests/store.test.js
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ChronicleStore is now the only code that reads or writes the campaign
 * (issue #96). These tests pin down what each call sends — which path, which
 * Drive file ID, which proxy action — so that moving publish to the repo (#97)
 * or to Postgres (phase 7) can be checked against the same expectations, and
 * so Safe Test Mode can never silently stop redirecting to the fixture.
 *
 * LOAD NOTE
 * ---------
 * The module attaches to window and calls the global fetch(). Node has no
 * window, so we stub it, and we replace fetch with a recorder that returns
 * canned responses. The module reads CHRONICLE_CONFIG at call time, so each
 * test sets the config it needs before calling.
 */

'use strict';

global.window = {};
require('../shared/chronicle-store.js');
const Store = window.ChronicleStore;

// ── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * assert(label, condition)
 * Prints PASS or FAIL and counts it. Every test runs; no bail on first failure.
 */
function assert(label, condition) {
  if (condition) { console.log('  PASS  ' + label); passed++; }
  else           { console.log('  FAIL  ' + label); failed++; }
}

const PROD_CONFIG = {
  proxyUrl:           'https://proxy.example/exec',
  campaignFileId:     'LIVE_ID',
  testCampaignFileId: 'TEST_ID',
  safeTestMode:       false,
};
const TEST_CONFIG = Object.assign({}, PROD_CONFIG, { safeTestMode: true });

let calls = [];

/**
 * mockFetch(reply) — replaces global fetch with a recorder.
 * reply(url, init) returns { status, body }; every call is pushed onto calls[]
 * so a test can check exactly what the module asked for.
 */
function mockFetch(reply) {
  calls = [];
  global.fetch = async function(url, init) {
    calls.push({ url: url, init: init || {} });
    const r = reply(url, init || {});
    return {
      ok:     r.status >= 200 && r.status < 300,
      status: r.status,
      json:   async () => r.body,
    };
  };
}

/** queryOf(url) — the query parameters of a recorded proxy GET, as an object. */
function queryOf(url) {
  return Object.fromEntries(new URL(url).searchParams);
}

// Stubs for the Safe Test Mode download, which builds an <a download> link.
// clicked records the filename so the test can confirm a download was started.
let clicked = [];
global.document = {
  createElement: () => ({ click() { clicked.push(this.download); } }),
};
URL.createObjectURL = () => 'blob:stub';
URL.revokeObjectURL = () => {};

/**
 * expectReject(fn) → the error message, or null when fn() resolved.
 * Lets a test assert that a call fails and on what.
 */
async function expectReject(fn) {
  try { await fn(); return null; }
  catch (e) { return e.message; }
}

(async function run() {

  // ── Test 1 — loadCampaign without config.js reads the repo copy ────────────
  // GitHub Pages has no config.js; the player view must still load.
  console.log('\nTest 1 — loadCampaign() without config reads the repo file');
  delete window.CHRONICLE_CONFIG;
  mockFetch(() => ({ status: 200, body: { _schema_version: '4.0.0' } }));
  {
    const json = await Store.loadCampaign();
    assert('fetches ../data/magers-campaign.json', calls[0].url === '../data/magers-campaign.json');
    assert('returns the raw JSON', json._schema_version === '4.0.0');
    assert('Safe Test Mode reports off', Store.isSafeTestMode() === false);
  }

  // ── Test 2 — Safe Test Mode redirects reads to the fixture ─────────────────
  console.log('\nTest 2 — loadCampaign() in Safe Test Mode reads the fixture');
  window.CHRONICLE_CONFIG = TEST_CONFIG;
  mockFetch(() => ({ status: 200, body: {} }));
  {
    await Store.loadCampaign();
    assert('fetches ../tests/fixtures/test-campaign.json', calls[0].url === '../tests/fixtures/test-campaign.json');
    assert('Safe Test Mode reports on', Store.isSafeTestMode() === true);
  }

  // ── Test 3 — a failed read throws instead of returning stale data ──────────
  console.log('\nTest 3 — loadCampaign() throws on HTTP error');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 404, body: null }));
  {
    const msg = await expectReject(() => Store.loadCampaign());
    assert('rejects with the HTTP status', msg && msg.includes('404'));
  }

  // ── Test 4 — publish base comes from Drive in production ───────────────────
  console.log('\nTest 4 — loadPublishBase() reads the live Drive file');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 200, body: { ok: true, raw: '{"from":"drive"}' } }));
  {
    const json = await Store.loadPublishBase();
    const q = queryOf(calls[0].url);
    assert('calls action=read', q.action === 'read');
    assert('targets campaignFileId', q.id === 'LIVE_ID');
    assert('parses the raw string', json.from === 'drive');
  }

  // ── Test 5 — publish base comes from the fixture in Safe Test Mode ─────────
  console.log('\nTest 5 — loadPublishBase() in Safe Test Mode reads the fixture');
  window.CHRONICLE_CONFIG = TEST_CONFIG;
  mockFetch(() => ({ status: 200, body: { from: 'fixture' } }));
  {
    const json = await Store.loadPublishBase();
    assert('fetches the fixture, not Drive', calls[0].url === '../tests/fixtures/test-campaign.json');
    assert('returns the fixture JSON', json.from === 'fixture');
  }

  // ── Test 6 — publish backs up, then writes, to the live file ───────────────
  console.log('\nTest 6 — publishSession() backs up then writes to Drive');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch((url, init) => init.method === 'POST'
    ? { status: 200, body: { ok: true } }
    : { status: 200, body: { ok: true, backupId: 'B1', name: 'backup.json' } });
  {
    const progress = [];
    const result = await Store.publishSession(
      { session_logs: [] },
      { sessionId: 'session_006', label: 'intake_session' },
      { onProgress: m => progress.push(m) }
    );
    const backupQ = queryOf(calls[0].url);
    const writeBody = JSON.parse(calls[1].init.body);
    assert('makes exactly two requests', calls.length === 2);
    assert('first request is a backup', backupQ.action === 'backup');
    assert('backup carries the label', backupQ.label === 'intake_session');
    assert('backup targets campaignFileId', backupQ.id === 'LIVE_ID');
    assert('second request is a POST', calls[1].init.method === 'POST');
    assert('POST uses text/plain (no CORS preflight)', calls[1].init.headers['Content-Type'] === 'text/plain');
    assert('POST writes to campaignFileId', writeBody.action === 'write' && writeBody.fileId === 'LIVE_ID');
    assert('POST carries the campaign', Array.isArray(writeBody.data.session_logs));
    assert('returns mode drive', result.mode === 'drive');
    assert('returns the backup reply', result.backup.backupId === 'B1');
    assert('reports progress for both steps', progress.length === 2);
  }

  // ── Test 7 — publish in Safe Test Mode downloads and touches nothing ───────
  console.log('\nTest 7 — publishSession() in Safe Test Mode downloads instead of writing');
  window.CHRONICLE_CONFIG = TEST_CONFIG;
  mockFetch(() => ({ status: 500, body: null }));
  clicked = [];
  {
    const result = await Store.publishSession({}, { sessionId: 'session_006' });
    assert('makes no network requests', calls.length === 0);
    assert('starts a download of test-campaign.json', clicked[0] === 'test-campaign.json');
    assert('returns mode test-download', result.mode === 'test-download');
  }

  // ── Test 8 — a Drive write that the proxy refuses throws ───────────────────
  console.log('\nTest 8 — publishSession() throws when the proxy refuses the write');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch((url, init) => init.method === 'POST'
    ? { status: 200, body: { ok: false, error: 'quota' } }
    : { status: 200, body: { ok: true } });
  {
    const msg = await expectReject(() => Store.publishSession({}, {}));
    assert('rejects with the proxy error', msg === 'quota');
  }

  // ── Test 9 — Drive calls without config.js fail clearly ────────────────────
  console.log('\nTest 9 — Drive calls without config.js fail with a clear message');
  delete window.CHRONICLE_CONFIG;
  mockFetch(() => ({ status: 200, body: { ok: true } }));
  {
    const msg = await expectReject(() => Store.listBackups());
    assert('rejects as not configured', msg && msg.includes('not configured'));
    assert('makes no request', calls.length === 0);
  }

  // ── Test 10 — backups follow Safe Test Mode's file ID ──────────────────────
  console.log('\nTest 10 — createBackup() / listBackups() in Safe Test Mode use testCampaignFileId');
  window.CHRONICLE_CONFIG = TEST_CONFIG;
  mockFetch(() => ({ status: 200, body: { ok: true, backups: [] } }));
  {
    await Store.createBackup('pre-session_008');
    await Store.listBackups();
    assert('backup targets TEST_ID', queryOf(calls[0].url).id === 'TEST_ID');
    assert('list targets TEST_ID', queryOf(calls[1].url).id === 'TEST_ID');
    assert('list uses action=listBackups', queryOf(calls[1].url).action === 'listBackups');
  }

  // ── Test 11 — loadBackup reads one backup by bare ID ───────────────────────
  console.log('\nTest 11 — loadBackup() reads a backup by ID');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 200, body: { ok: true, data: { backup: true } } }));
  {
    const json = await Store.loadBackup('B42');
    const q = queryOf(calls[0].url);
    assert('sends only the id parameter', q.id === 'B42' && q.action === undefined);
    assert('returns the backup data', json.backup === true);
  }

  // ── Test 12 — draft stubs report they are unavailable ──────────────────────
  console.log('\nTest 12 — saveDraft() / loadDraft() are not available yet');
  {
    const s = await expectReject(() => Store.saveDraft());
    const l = await expectReject(() => Store.loadDraft());
    assert('saveDraft rejects mentioning Postgres', s && s.includes('Postgres'));
    assert('loadDraft rejects mentioning Postgres', l && l.includes('Postgres'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
