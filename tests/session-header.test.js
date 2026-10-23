/**
 * tests/session-header.test.js — the session page's upload step (issue #99)
 *
 * The new session page (admin/session.html) picks the session ID and date at
 * upload. These tests check that the choice reaches publish: the helpers the
 * page calls (ChroniclePublish.sessionChoices and .sessionHeader) are run
 * here, and the header they build is passed through the real applySession.
 *   H-1   sessionChoices offers the placeholders first, then the next new ID
 *   H-2   a header for session_006 fills the placeholder, keeping its date
 *   H-3   a header for the next new ID adds a session with the chosen date
 *   H-4   sessionHeader refuses a missing ID or date
 *   H-5   the page: nav bar on every admin page, scripts, leave warning
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before #99 intake read a session ID field that was not on the page, so
 * every session was filed as session_006 and dated the day of intake. This
 * file pins down that the ID and date picked at upload are the ones publish
 * writes, and that a placeholder is filled rather than added a second time.
 *
 * No test loads the page in a browser; H-5 reads its source only.
 *
 * RUN
 * ---
 * node tests/session-header.test.js
 *
 * Plain Node.js — no external test framework required.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds     = require('../shared/chronicle-ids.js');
const ChroniclePublish = require('../shared/chronicle-publish.js');

let passed = 0;
let failed = 0;

/**
 * assert(label, condition)
 * Prints PASS or FAIL with the test label and increments counters.
 * All tests run regardless of earlier failures.
 */
function assert(label, condition) {
  if (condition) { console.log('  PASS  ' + label); passed++; }
  else           { console.log('  FAIL  ' + label); failed++; }
}

const ROOT     = path.join(__dirname, '..');
const read     = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// The real campaign, because it has the session_006 and session_007
// placeholders and the fixture does not. Nothing is written back.
const campaign = JSON.parse(read('data/magers-campaign.json'));
const fixture  = JSON.parse(read('tests/fixtures/test-campaign.json'));

// ── H-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest H-1 — the session choices: placeholders first, then the next ID');
{
  const choices = ChroniclePublish.sessionChoices(campaign);
  const ids = choices.map(c => c.legacyId);
  assert('H-1: session_006 and session_007 are offered first, as placeholders',
    ids[0] === 'session_006' && ids[1] === 'session_007' && choices[0].placeholder && choices[1].placeholder);
  assert('H-1: a placeholder carries its recorded date', choices[0].date === '2026-04-02');
  assert('H-1: the last choice is the next new ID, session_008', ids[ids.length - 1] === 'session_008' && !choices[choices.length - 1].placeholder);
  assert('H-1: complete sessions (session_001–005) are not offered', !ids.some(id => /^session_00[1-5]$/.test(id)));
  const fx = ChroniclePublish.sessionChoices(fixture).map(c => c.legacyId);
  assert('H-1: the fixture (no placeholders) offers only session_003', fx.length === 1 && fx[0] === 'session_003');
}

// ── H-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest H-2 — a session_006 header fills the placeholder');
{
  const before = campaign.session_logs.find(s => s.legacy_id === 'session_006');
  const header = ChroniclePublish.sessionHeader('session_006', before.date);
  const { campaign: out, notes } = ChroniclePublish.applySession(campaign, [header]);
  const after = out.session_logs.filter(s => s.legacy_id === 'session_006');
  assert('H-2: still exactly one session_006, nothing appended',
    after.length === 1 && out.session_logs.length === campaign.session_logs.length);
  assert('H-2: same UUID, same date', after[0].id === before.id && after[0].date === before.date);
  assert('H-2: no note about the date (it matched)', !notes.some(n => /kept the recorded date/.test(n)));
  assert('H-2: no stub field names written', !('session_id' in after[0]) && !('session_date' in after[0]));

  // A different date for a placeholder is reported, not written: the DM's
  // recorded date wins, as fillSession has done since #92.
  const other = ChroniclePublish.applySession(campaign, [ChroniclePublish.sessionHeader('session_006', '2026-04-03')]);
  assert('H-2: a different date keeps the recorded one and says so',
    other.campaign.session_logs.find(s => s.legacy_id === 'session_006').date === before.date &&
    other.notes.some(n => /session_006: kept the recorded date/.test(n)));
}

// ── H-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest H-3 — a header for the next ID adds the session with the chosen date');
{
  const next = ChroniclePublish.sessionChoices(campaign).pop();
  const out = ChroniclePublish.applySession(campaign, [ChroniclePublish.sessionHeader(next.legacyId, '2026-04-16')]).campaign;
  const s8 = out.session_logs.find(s => s.legacy_id === 'session_008');
  assert('H-3: one session added', out.session_logs.length === campaign.session_logs.length + 1);
  assert('H-3: it has a UUID id and legacy_id session_008', ChronicleIds.isOpaqueId(s8?.id));
  assert('H-3: its date is the chosen date, not today', s8?.date === '2026-04-16');
}

// ── H-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest H-4 — sessionHeader refuses a missing ID or date');
{
  const throws = fn => { try { fn(); return false; } catch (e) { return true; } };
  assert('H-4: no ID throws', throws(() => ChroniclePublish.sessionHeader('', '2026-04-16')));
  assert('H-4: an ID that is not session_NNN throws', throws(() => ChroniclePublish.sessionHeader('cbt_001', '2026-04-16')));
  assert('H-4: no date throws', throws(() => ChroniclePublish.sessionHeader('session_008', '')));
  assert('H-4: a date that is not YYYY-MM-DD throws', throws(() => ChroniclePublish.sessionHeader('session_008', '16/04/2026')));
}

// ── H-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest H-5 — the session page and the nav bar');
{
  const page = read('admin/session.html');
  const NAV = ['session.html', 'intake.html', 'glossary.html', 'delta-review.html', 'integrity.html', 'log-viewer.html', 'log-editor.html'];
  for (const file of NAV) {
    // Only the nav block: some pages also have buttons that link to a page.
    const src = (/<nav class="nav-links">([\s\S]*?)<\/nav>/.exec(read('admin/' + file)) || [, ''])[1];
    const order = [...src.matchAll(/window\.location='([a-z-]+\.html)'">/g)].map(m => m[1]);
    const active = [...src.matchAll(/class="nav-link active" onclick="window\.location='([a-z-]+\.html)'/g)].map(m => m[1]);
    assert(`H-5: ${file} has the 7-item nav in order, itself active`,
      JSON.stringify(order) === JSON.stringify(NAV) && active.length === 1 && active[0] === file);
  }
  // Scripts in the CLAUDE.md order; the page reads the campaign only
  // through the store and does not fetch the campaign JSON itself.
  const scripts = [...page.matchAll(/<script src="\.\.\/shared\/([a-z-]+\.js)"/g)].map(m => m[1]);
  // chronicle-entities.js and chronicle-ai.js joined with step 2 and 3 (#100), chronicle-facts.js with step 4 (#101), chronicle-grid.js and chronicle-integrity.js with the round grid (#103).
  assert('H-5: loads config, store, ids, publish, entities, facts, grid, integrity, ai in that order',
    JSON.stringify(scripts) === JSON.stringify(['config.js', 'chronicle-store.js', 'chronicle-ids.js', 'chronicle-publish.js', 'chronicle-entities.js', 'chronicle-facts.js', 'chronicle-grid.js', 'chronicle-integrity.js', 'chronicle-ai.js']));
  assert('H-5: no direct fetch of the campaign file', !/fetch\([^)]*magers-campaign/.test(page));
  assert('H-5: warns before leaving with unpublished work', /addEventListener\('beforeunload'/.test(page));
  assert('H-5: no sessionStorage or localStorage', !/sessionStorage|localStorage/.test(page.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
