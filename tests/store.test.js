/**
 * tests/store.test.js
 *
 * Automated tests for shared/chronicle-store.js.
 * Plain Node.js — no test framework required. Run with: node tests/store.test.js
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ChronicleStore is now the only code that reads or writes the campaign
 * (issue #96). These tests pin down what each call touches — which path is
 * fetched and which local files are written —
 * so that the local-file publish (#97) and the later move to Postgres
 * (phase 7) can be checked against the same expectations, and so Safe Test
 * Mode can never silently stop redirecting to the test files.
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

// A config.js written before #98 still carries the Drive keys. The store
// must ignore them: Test 9 checks that no call goes near the proxy.
const PROD_CONFIG = {
  proxyUrl:           'https://proxy.example/exec',
  campaignFileId:     'LIVE_ID',
  testCampaignFileId: 'TEST_ID',
  safeTestMode:       false,
};
const TEST_CONFIG = Object.assign({}, PROD_CONFIG, { safeTestMode: true });

// ── Fake local disk for publishing (issue #97) ──────────────────────────────
// Publish writes the campaign file through the browser's File System Access
// API. Node has none, so these fakes stand in for the repository folder the
// DM picks, the picker itself and the IndexedDB store that remembers the
// folder. Every write is recorded, so a test can check exactly which files
// were written and that nothing was written on failure.

/**
 * fakeRepo(files, options) → a fake directory handle for the repo root.
 *   files   — { 'data/magers-campaign.json': '…text…', … }; repo.files is
 *             the live map, so a test can change a file "on disk"
 *   options — { permission: 'granted' | 'prompt' | 'denied', grant: what
 *             requestPermission() answers (default 'granted'), name }
 * repo.writes lists every path written, in order; repo.requests counts
 * permission prompts.
 */
function fakeRepo(files, options) {
  const opts = options || {};
  const repo = { files: Object.assign({}, files), writes: [], requests: 0 };
  let permission = opts.permission || 'granted';
  const notFound = path => Object.assign(new Error('A requested file or directory could not be found: ' + path), { name: 'NotFoundError' });
  // A folder exists if a file exists under it, or one was created there.
  const dirs = new Set();
  const isDir = p => dirs.has(p) || Object.keys(repo.files).some(f => f.startsWith(p + '/'));

  function dirHandle(prefix, name) {
    return {
      kind: 'directory',
      name: name,
      async getDirectoryHandle(child, o) {
        const p = prefix ? prefix + '/' + child : child;
        if (!isDir(p)) {
          if (!(o && o.create)) throw notFound(p);
          dirs.add(p);
        }
        return dirHandle(p, child);
      },
      async getFileHandle(child, o) {
        const p = prefix ? prefix + '/' + child : child;
        if (!(p in repo.files) && !(o && o.create)) throw notFound(p);
        return {
          kind: 'file',
          name: child,
          async getFile() {
            if (!(p in repo.files)) throw notFound(p);
            const text = repo.files[p];
            return { text: async () => text };
          },
          async createWritable() {
            // Like the browser, nothing reaches the file until close().
            let pending = '';
            return {
              async write(data) { pending += data; },
              async close() { repo.files[p] = pending; repo.writes.push(p); },
            };
          },
        };
      },
      async queryPermission() { return permission; },
      async requestPermission() {
        repo.requests++;
        permission = opts.grant || 'granted';
        return permission;
      },
    };
  }
  repo.root = dirHandle('', opts.name || 'Chronicle-MagersCampaign');
  // Simulates a new browser session: a remembered handle needs permission again.
  repo.forgetPermission = () => { permission = 'prompt'; };
  return repo;
}

/**
 * fakeIndexedDB() → just enough of window.indexedDB for the store to
 * remember the folder handle: open(), one object store, get() and put().
 * db.saved is the live key → value map.
 */
function fakeIndexedDB() {
  const saved = {};
  const later = fn => setImmediate(fn);
  const db = {
    transaction() {
      const tx = {
        objectStore() {
          return {
            get(key) {
              const req = {};
              later(() => { req.result = saved[key]; req.onsuccess && req.onsuccess(); });
              return req;
            },
            put(value, key) {
              saved[key] = value;
              later(() => tx.oncomplete && tx.oncomplete());
            },
          };
        },
      };
      return tx;
    },
    createObjectStore() {},
    // Counted so a test can check every connection the store opens is closed.
    close() { fake.closes++; },
  };
  // mode 'blocked' fires onblocked (another tab in the way); 'hang' never
  // answers at all. Both must fall back to the picker, never hang publish.
  const fake = {
    saved,
    opens: 0,
    closes: 0,
    mode: null,
    open() {
      fake.opens++;
      const req = { result: db };
      if (fake.mode === 'hang') return req;
      if (fake.mode === 'blocked') { later(() => req.onblocked && req.onblocked()); return req; }
      later(() => { req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); });
      return req;
    },
  };
  return fake;
}

/**
 * useDisk(repo, pickerResult) — installs a fresh fake IndexedDB and a fake
 * showDirectoryPicker on window. pickerResult is what the picker answers:
 * a fake repo's root (default: repo.root), or 'cancel' for the DM closing
 * the picker. picks[] records each time the picker was opened.
 */
let picks = [];
function useDisk(repo, pickerResult) {
  picks = [];
  window.indexedDB = fakeIndexedDB();
  window.showDirectoryPicker = async function(o) {
    picks.push(o);
    const r = pickerResult || repo.root;
    if (r === 'cancel') throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
    return r;
  };
}

const CAMPAIGN_FILE = 'data/magers-campaign.json';
const PREV_FILE     = 'data/magers-campaign.prev.json';
const FIXTURE_FILE  = 'tests/fixtures/test-campaign.json';
const OUTPUT_FILE   = 'tests/output/test-campaign.published.json';
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
      text:   async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
}

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
  // Before any test publish there is no test output file (404), so reads
  // fall back to the fixture. Test 7b covers the output file existing.
  console.log('\nTest 2 — loadCampaign() in Safe Test Mode reads the fixture when no test publish exists');
  window.CHRONICLE_CONFIG = TEST_CONFIG;
  mockFetch(url => url.includes('/tests/output/') ? { status: 404, body: null } : { status: 200, body: { from: 'fixture' } });
  {
    const json = await Store.loadCampaign();
    assert('tries the test output file first', calls[0].url === '../tests/output/test-campaign.published.json');
    assert('then fetches ../tests/fixtures/test-campaign.json', calls[1].url === '../tests/fixtures/test-campaign.json');
    assert('returns the fixture', json.from === 'fixture');
    assert('never reads the real campaign file', !calls.some(c => c.url.includes('magers-campaign')));
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

  // ── Publishing to the local campaign file (issue #97) ──────────────────────
  // Tests 4–8 replaced the Drive publish tests. A fake repository folder
  // answers the File System Access calls, so each test can check exactly
  // which files were written and that nothing was written on failure.
  // mockFetch records every request; publishing must make none.

  // ── Test 4 — the first publish asks for the folder, then remembers it ──────
  console.log('\nTest 4 — loadPublishBase() reads the campaign file from the picked folder');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 500, body: null }));
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{"from":"disk","note":"Atticus — druid"}\n' }, { permission: 'prompt' });
    useDisk(repo);
    const json = await Store.loadPublishBase();
    assert('opens the folder picker once, for read and write', picks.length === 1 && picks[0].mode === 'readwrite');
    assert('asks for permission to edit the folder', repo.requests === 1);
    assert('returns the file as JSON (non-ASCII intact)', json.from === 'disk' && json.note === 'Atticus — druid');
    assert('remembers the folder in IndexedDB', Object.values(window.indexedDB.saved)[0] === repo.root);
    assert('writes nothing', repo.writes.length === 0);
    assert('makes no network request', calls.length === 0);
    await Store.loadPublishBase();
    assert('a second load reuses the folder without the picker', picks.length === 1);
    repo.forgetPermission();                       // a new browser session
    await Store.loadPublishBase();
    assert('a new browser session asks for permission again, without the picker', picks.length === 1 && repo.requests === 2);
  }

  // ── Test 5 — a normal publish writes the campaign file and the .prev copy ──
  console.log('\nTest 5 — publishSession() writes data/magers-campaign.json and keeps the previous file');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 500, body: null }));
  {
    const original = '{\n  "session_logs": []\n}\n';
    const repo = fakeRepo({ [CAMPAIGN_FILE]: original });
    useDisk(repo);
    const base = await Store.loadPublishBase();
    base.session_logs.push({ title: 'The Larkspur Dragons — part 2' });
    const progress = [];
    const result = await Store.publishSession(base,
      { sessionId: 'b12d5cc2-47ed-4ffa-9bc2-9c672dfe86c9', sessionRef: 'session_006', title: 'The Larkspur Dragons', label: 'intake_session' },
      { onProgress: m => progress.push(m) });
    assert('writes the .prev copy first, then the campaign file, and nothing else',
      repo.writes.length === 2 && repo.writes[0] === PREV_FILE && repo.writes[1] === CAMPAIGN_FILE);
    assert('.prev holds the file exactly as it was', repo.files[PREV_FILE] === original);
    assert('the campaign is 2-space JSON with a final newline', repo.files[CAMPAIGN_FILE] === JSON.stringify(base, null, 2) + '\n');
    assert('UTF-8 text survives', repo.files[CAMPAIGN_FILE].includes('Dragons — part 2'));
    assert('returns the file written and the .prev path', result.mode === 'local-file' && result.path === CAMPAIGN_FILE && result.previousPath === PREV_FILE && result.testMode === false);
    assert('suggests the commit message "Publish session_NNN: <title>"', result.commitMessage === 'Publish session_006: The Larkspur Dragons');
    assert('reports progress for each step', progress.length === 3);
    assert('makes no network request', calls.length === 0);
    const again = await expectReject(() => Store.publishSession(base, {}));
    assert('a second publish without a fresh load is refused', again && again.includes('not loaded') && again.includes('Nothing was written'));
    assert('and writes nothing', repo.writes.length === 2);
  }

  // ── Test 6 — a file changed on disk stops the publish ──────────────────────
  console.log('\nTest 6 — publishSession() stops, writing nothing, if the file changed after load');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{"v":1}\n' });
    useDisk(repo);
    const base = await Store.loadPublishBase();
    repo.files[CAMPAIGN_FILE] = '{"v":1,"pulled":true}\n';   // a git pull lands in between
    const msg = await expectReject(() => Store.publishSession(base, { sessionRef: 'session_006' }));
    assert('rejects saying the file changed on disk', msg && msg.includes('changed on disk'));
    assert('says nothing was written', msg && msg.includes('Nothing was written'));
    assert('writes nothing, not even the .prev copy', repo.writes.length === 0 && !(PREV_FILE in repo.files));
    assert('the newer file is left as it was', repo.files[CAMPAIGN_FILE] === '{"v":1,"pulled":true}\n');
  }
  {
    // Even a whitespace-only change counts: the check compares exact text.
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{"v":1}\n' });
    useDisk(repo);
    const base = await Store.loadPublishBase();
    repo.files[CAMPAIGN_FILE] = '{"v":1}\r\n';
    const msg = await expectReject(() => Store.publishSession(base, {}));
    assert('a line-ending change also stops the publish', msg && msg.includes('changed on disk') && repo.writes.length === 0);
  }

  // ── Test 7 — Safe Test Mode writes only the test output file ───────────────
  // The phase 2 gate, against the fake disk: the output file is written, and
  // the campaign file and the fixture are untouched.
  console.log('\nTest 7 — publishSession() in Safe Test Mode writes only tests/output/test-campaign.published.json');
  window.CHRONICLE_CONFIG = TEST_CONFIG;
  mockFetch(() => ({ status: 500, body: null }));
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{"real":true}\n', [FIXTURE_FILE]: '{"fixture":true}\n' });
    useDisk(repo);
    const base = await Store.loadPublishBase();
    assert('builds on the fixture', base.fixture === true && base.real === undefined);
    base.published = 'test';
    const result = await Store.publishSession(base, { sessionRef: 'session_006', title: 'Test' });
    assert('exactly one write, to the test output file', repo.writes.length === 1 && repo.writes[0] === OUTPUT_FILE);
    assert('the output is the campaign as 2-space JSON with a final newline', repo.files[OUTPUT_FILE] === JSON.stringify(base, null, 2) + '\n');
    assert('the real campaign file is untouched', repo.files[CAMPAIGN_FILE] === '{"real":true}\n');
    assert('the fixture is untouched', repo.files[FIXTURE_FILE] === '{"fixture":true}\n');
    assert('no .prev copy is made', !(PREV_FILE in repo.files));
    assert('returns testMode and the output path', result.testMode === true && result.path === OUTPUT_FILE && result.previousPath === null);
    assert('still suggests the commit message', result.commitMessage === 'Publish session_006: Test');
    assert('makes no network request', calls.length === 0);
  }
  {
    // A base loaded in one mode cannot be published in the other.
    window.CHRONICLE_CONFIG = PROD_CONFIG;
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{}\n', [FIXTURE_FILE]: '{}\n' });
    useDisk(repo);
    const base = await Store.loadPublishBase();
    window.CHRONICLE_CONFIG = TEST_CONFIG;
    const msg = await expectReject(() => Store.publishSession(base, {}));
    assert('switching Safe Test Mode between load and publish is refused with no write', msg && msg.includes('not loaded') && repo.writes.length === 0);
  }

  // ── Test 7b — Safe Test Mode reads prefer the test output file ─────────────
  // The admin log viewer must show what a test publish wrote (#17, E-08).
  console.log('\nTest 7b — loadCampaign() in Safe Test Mode prefers the test output file');
  window.CHRONICLE_CONFIG = TEST_CONFIG;
  mockFetch(url => url.includes('/tests/output/')
    ? { status: 200, body: { from: 'output' } }
    : { status: 200, body: { from: 'fixture' } });
  {
    const json = await Store.loadCampaign();
    assert('fetches ../tests/output/test-campaign.published.json first', calls[0].url === '../tests/output/test-campaign.published.json');
    assert('without the browser cache', calls[0].init.cache === 'no-store');
    assert('returns the test output', json.from === 'output' && calls.length === 1);
  }
  mockFetch(url => ({ status: 500, body: null }));
  {
    const msg = await expectReject(() => Store.loadCampaign());
    assert('a server error on the output file is an error, not a silent fall back', msg && msg.includes('500') && calls.length === 1);
  }
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 200, body: {} }));
  {
    await Store.loadCampaign();
    assert('outside Safe Test Mode the output file is never read', calls.length === 1 && calls[0].url === '../data/magers-campaign.json');
  }

  // ── Test 8 — permission refused or no folder: an error and no write ────────
  console.log('\nTest 8 — loadPublishBase() fails clearly, writing nothing, without a usable folder');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 500, body: null }));
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{}\n' });
    useDisk(repo, 'cancel');
    const msg = await expectReject(() => Store.loadPublishBase());
    assert('closing the picker rejects as "No folder chosen"', msg && msg.includes('No folder chosen') && msg.includes('Nothing was written'));
    assert('nothing is remembered', Object.keys(window.indexedDB.saved).length === 0);
    const after = await expectReject(() => Store.publishSession({}, {}));
    assert('and a publish after it is refused', after && after.includes('not loaded'));
    assert('nothing is written', repo.writes.length === 0);
  }
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{}\n' }, { permission: 'prompt', grant: 'denied', name: 'Chronicle-MagersCampaign' });
    useDisk(repo);
    const msg = await expectReject(() => Store.loadPublishBase());
    assert('refusing permission rejects naming the folder', msg && msg.includes('refused') && msg.includes('Chronicle-MagersCampaign') && msg.includes('Nothing was written'));
    assert('nothing is written', repo.writes.length === 0);
  }
  {
    const wrong = fakeRepo({ 'notes.txt': 'not the repo' }, { name: 'Downloads' });
    useDisk(wrong);
    const msg = await expectReject(() => Store.loadPublishBase());
    assert('a folder without data/magers-campaign.json is rejected as not the repository', msg && msg.includes('not the Chronicle repository') && msg.includes('Downloads'));
    assert('is not remembered', Object.keys(window.indexedDB.saved).length === 0);
    assert('and nothing is written into it', wrong.writes.length === 0 && Object.keys(wrong.files).length === 1);
  }
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{}\n' });
    useDisk(repo);
    await Store.loadPublishBase();                 // folder remembered
    delete repo.files[CAMPAIGN_FILE];              // then the file disappears
    const msg = await expectReject(() => Store.loadPublishBase());
    assert('a missing campaign file rejects naming it', msg && msg.includes('data/magers-campaign.json could not be read') && msg.includes('Nothing was written'));
  }
  {
    const saved = window.showDirectoryPicker;
    delete window.showDirectoryPicker;             // Firefox or Safari
    const msg = await expectReject(() => Store.loadPublishBase());
    assert('a browser without the File System Access API rejects asking for Chrome or Edge', msg && msg.includes('Chrome or Edge'));
    window.showDirectoryPicker = saved;
  }
  assert('no request was made in any failure case', calls.length === 0);

  // ── Test 8c — fixes from the phase 2 gate run ──────────────────────────────
  // At the gate the DM picked the data folder twice: the picker reopens in
  // the last folder picked. These check the clearer message, and that the
  // remembered-folder database can never leave publish waiting.
  console.log('\nTest 8c — picking the data folder, and an IndexedDB that is blocked or silent');
  window.CHRONICLE_CONFIG = PROD_CONFIG;
  mockFetch(() => ({ status: 500, body: null }));
  {
    // The data folder itself: magers-campaign.json sits directly inside it.
    const dataFolder = fakeRepo({ 'magers-campaign.json': '{}\n' }, { name: 'data' });
    useDisk(dataFolder);
    const msg = await expectReject(() => Store.loadPublishBase());
    assert('picking the data folder says so and asks for the folder that contains it',
      msg && msg.includes('You picked the "data" folder itself') && msg.includes('contains it') && msg.includes('Nothing was written'));
    assert('is not remembered and nothing is written', Object.keys(window.indexedDB.saved).length === 0 && dataFolder.writes.length === 0);
  }
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{"ok":1}\n' });
    useDisk(repo);
    await Store.loadPublishBase();                 // read, then save
    await Store.loadPublishBase();                 // read the remembered folder
    const idb = window.indexedDB;
    assert('every IndexedDB connection the store opens is closed', idb.opens === 3 && idb.closes === 3);
  }
  {
    const repo = fakeRepo({ [CAMPAIGN_FILE]: '{"ok":1}\n' });
    useDisk(repo);
    window.indexedDB.mode = 'blocked';
    const json = await Store.loadPublishBase();
    assert('a blocked IndexedDB falls back to the picker and the publish read still works', json.ok === 1 && picks.length === 1);
  }
  {
    // A database that never answers: the store's 5 s limit, made instant.
    const realTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => realTimeout(fn, ms >= 1000 ? 0 : ms);
    try {
      const repo = fakeRepo({ [CAMPAIGN_FILE]: '{"ok":1}\n' });
      useDisk(repo);
      window.indexedDB.mode = 'hang';
      const json = await Store.loadPublishBase();
      assert('an IndexedDB that never answers times out to the picker instead of hanging', json.ok === 1 && picks.length === 1);
    } finally {
      global.setTimeout = realTimeout;
    }
  }

  // ── Test 8b — nothing in the store talks to GitHub ─────────────────────────
  // The acceptance list says no GitHub token or API call anywhere. The
  // tests above record every request; this also checks the source, so a
  // GitHub call added on a path no test reaches is still caught.
  console.log('\nTest 8b — the store has no GitHub API call or token');
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'shared', 'chronicle-store.js'), 'utf8');
    assert('no api.github.com or github.com URL in shared/chronicle-store.js', !/https?:\/\/(api\.)?github\.com/i.test(src));
    assert('no githubToken setting', !/githubToken/.test(src));
  }

  // ── Test 9 — Google Drive is gone (issue #98) ────────────────────────────
  // The Drive backups were the last Drive calls. The exports and the source
  // are both checked, so a Drive call added on a path no test reaches is
  // still caught, as Test 8b does for GitHub.
  console.log('\nTest 9 — the store has no Drive backup calls or proxy settings');
  {
    assert('createBackup, listBackups and loadBackup are no longer exported',
      !('createBackup' in Store) && !('listBackups' in Store) && !('loadBackup' in Store));
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'shared', 'chronicle-store.js'), 'utf8');
    assert('no proxyUrl, campaignFileId or testCampaignFileId setting is read', !/proxyUrl|campaignFileId|testCampaignFileId/.test(src));
    assert('no Apps Script URL', !/script\.google(usercontent)?\.com/i.test(src));
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
