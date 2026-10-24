/**
 * tests/absence-notes.test.js — player absence as a session note (issue #112)
 *
 * Tests the move of player absences from the old PC-fact shape to
 * session_logs[].narrative.absence_notes (schema 5.0.1):
 *   A-1  the migrated campaign: sessions 2, 4 and 6 each have their sentence;
 *        no mechanics.player_absences anywhere; no player_absence entry in
 *        mechanical_notes (the arrays stay); 5.0.1 in campaign and fixture
 *   A-2  scripts/migrate-absence-notes.js on the pre-migration shape, and
 *        run twice (idempotent)
 *   A-3  publish: a new session gets no player_absences and no absence_notes;
 *        session_006's sentence is published exactly once; no PC id is written
 *   A-4  extraction: the facts prompt asks for absence notes as session notes
 *        and reuses a recorded sentence; parse and merge keep each once
 *   A-5  both viewers map absence_notes, identically
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The DM decided on 23 October 2026 that an absence is a note about the
 * session, never a fact about a PC. These tests pin that rule wherever an
 * absence passes: the data, the migration, publish, extraction and the viewers.
 *
 * RUN
 * ---
 * node tests/absence-notes.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds     = require('../shared/chronicle-ids.js');
const ChroniclePublish = require('../shared/chronicle-publish.js');
const F                = require('../shared/chronicle-facts.js');
const { migrateCampaign, NEW_SCHEMA_VERSION } = require('../scripts/migrate-absence-notes.js');

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

const ROOT = path.join(__dirname, '..');
const read = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const campaign = read('data/magers-campaign.json');
const fixture = read('tests/fixtures/test-campaign.json');
const session = id => campaign.session_logs.find(s => s.legacy_id === id);
const EXPECTED = {
  session_002: 'Ashton piloted by David due to Frazer being sick.',
  session_004: "Malachite piloted by David due to Lance's work schedule.",
  session_006: "Malachite piloted by David due to Lance's work schedule.",
};

// ── A-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest A-1 — the migrated campaign');
{
  for (const [id, text] of Object.entries(EXPECTED)) {
    assert(`A-1: ${id} has its one sentence in narrative.absence_notes`, JSON.stringify(session(id).narrative.absence_notes) === JSON.stringify([text]));
  }
  const others = campaign.session_logs.filter(s => !EXPECTED[s.legacy_id]);
  assert('A-1: a session with no absence has no absence_notes field', others.every(s => !('absence_notes' in (s.narrative || {}))));
  assert('A-1: no session has mechanics.player_absences', campaign.session_logs.every(s => !('player_absences' in (s.mechanics || {}))));
  assert('A-1: no mechanical_notes entry has type player_absence', campaign.session_logs.every(s => (s.mechanical_notes || []).every(n => n.type !== 'player_absence')));
  assert('A-1: every session keeps its mechanical_notes array', campaign.session_logs.every(s => Array.isArray(s.mechanical_notes)));
  assert('A-1: _schema_version is 5.0.1 in the campaign and the fixture', campaign._schema_version === '5.0.1' && fixture._schema_version === '5.0.1' && NEW_SCHEMA_VERSION === '5.0.1');
  const ref = campaign._field_type_reference;
  assert('A-1: absence_notes is documented, and player_absence is gone from the mechanical_note_type enum',
    /session note kept for the record, never a fact about a PC/.test(ref.common_optional_fields.absence_notes) && !ref.shared_enums.mechanical_note_type.includes('player_absence'));
  assert('A-1: no absence note carries a PC id (they are plain sentences)', campaign.session_logs.every(s => (s.narrative?.absence_notes || []).every(t => typeof t === 'string')));
}

// ── A-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest A-2 — the migration script');
{
  // The pre-migration shape, rebuilt from the migrated file: the old PC-fact
  // entry in both places on sessions 2, 4 and 6, and an empty
  // mechanics.player_absences on every session.
  const old = JSON.parse(JSON.stringify(campaign));
  old._schema_version = '5.0.0';
  old._field_type_reference.shared_enums.mechanical_note_type.unshift('player_absence');
  delete old._field_type_reference.common_optional_fields.absence_notes;
  const pcOf = { session_002: 'pc_003', session_004: 'pc_002', session_006: 'pc_002' };
  const P = ChronicleIds.buildLegacyIndex(old);
  for (const s of old.session_logs) {
    s.mechanics.player_absences = [];
    const text = EXPECTED[s.legacy_id];
    if (text) {
      const entry = { type: 'player_absence', pc_id: P.get(pcOf[s.legacy_id]), note: text };
      s.mechanics.player_absences.push(entry);
      s.mechanical_notes = [entry].concat(s.mechanical_notes || [], [{ type: 'rules_clarification', note: 'kept' }]);
      delete s.narrative.absence_notes;
    }
  }
  const { json, report } = migrateCampaign(old, '2026-10-23');
  for (const [id, text] of Object.entries(EXPECTED)) {
    const s = json.session_logs.find(x => x.legacy_id === id);
    assert(`A-2: ${id}'s sentence is moved once (it was stored twice), text unchanged`, JSON.stringify(s.narrative.absence_notes) === JSON.stringify([text]));
    assert(`A-2: ${id}'s other mechanical note is left alone`, s.mechanical_notes.length === 1 && s.mechanical_notes[0].type === 'rules_clarification');
  }
  assert('A-2: player_absences is removed from every session, empty ones included', json.session_logs.every(s => !('player_absences' in s.mechanics)));
  assert('A-2: the version, enum and field doc are updated, and meta.last_updated set', json._schema_version === '5.0.1' && json.meta.last_updated === '2026-10-23' &&
    !json._field_type_reference.shared_enums.mechanical_note_type.includes('player_absence'));
  assert('A-2: every change is reported', report.filter(l => /removed mechanics.player_absences/.test(l)).length === old.session_logs.length && report.some(l => /session_006: narrative.absence_notes ←/.test(l)));
  assert('A-2: the input is not changed', old._schema_version === '5.0.0');
  const again = migrateCampaign(json, '2026-10-24');
  assert('A-2: running it again changes nothing', again.report.length === 0 && JSON.stringify(again.json) === JSON.stringify(json));
}

// ── A-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest A-3 — publish');
{
  const s8 = ChroniclePublish.applySession(campaign, [ChroniclePublish.sessionHeader('session_008', '2026-04-16')]).campaign.session_logs.find(s => s.legacy_id === 'session_008');
  assert('A-3: a new session gets no mechanics.player_absences', !('player_absences' in s8.mechanics));
  assert('A-3: a new session with no absence writes no absence_notes', !('absence_notes' in s8.narrative));
  // Session 6, as the session page sends it: the header carries the absence
  // the facts call read, which reused the recorded sentence (rule 14).
  const header = ChroniclePublish.sessionHeader('session_006', '2026-04-02');
  header.rawData.narrative = { absence_notes: [EXPECTED.session_006] };
  const out = ChroniclePublish.applySession(campaign, [header]).campaign;
  const s6 = out.session_logs.find(s => s.legacy_id === 'session_006');
  assert('A-3: session_006\'s sentence is published exactly once', JSON.stringify(s6.narrative.absence_notes) === JSON.stringify([EXPECTED.session_006]));
  const twice = ChroniclePublish.applySession(out, [header]).campaign.session_logs.find(s => s.legacy_id === 'session_006');
  assert('A-3: …and a repeat publish still leaves one', twice.narrative.absence_notes.length === 1);
  const h8 = ChroniclePublish.sessionHeader('session_008', '2026-04-16');
  h8.rawData.narrative = { absence_notes: ['Ashton played by David while Frazer was away.'] };
  const n8 = ChroniclePublish.applySession(campaign, [h8]).campaign;
  const ns = n8.session_logs.find(s => s.legacy_id === 'session_008');
  assert('A-3: a new session with an absence writes it in narrative.absence_notes', JSON.stringify(ns.narrative.absence_notes) === JSON.stringify(['Ashton played by David while Frazer was away.']));
  const pcFields = JSON.stringify(n8.party) === JSON.stringify(campaign.party);
  assert('A-3: no PC id or PC-level field is written for an absence', pcFields && !JSON.stringify(ns).includes('pc_id') && !('player_absences' in ns.mechanics));
}

// ── A-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest A-4 — extraction');
{
  const p = F.factsPrompt({ pageLabel: 'page 2 of 2', references: [], combats: [], carry: null, reread: null, recordedAbsences: [EXPECTED.session_006] });
  assert('A-4: the prompt asks for absences as session notes, not character facts', /"absence_notes": a line saying a player was absent/.test(p) && /not a fact about a character/.test(p));
  assert('A-4: the prompt shows the recorded sentence and asks to copy it exactly', p.includes(`"${EXPECTED.session_006}"`) && /copy that sentence exactly/.test(p));
  // The real session 6 run also wrote the absence as a session passage; the
  // passage rule now says it never goes there.
  assert('A-4: the passage rule keeps absence lines out of passages', /never also in passages/.test(p));
  assert('A-4: with nothing recorded, no such line', !/This session already records/.test(F.factsPrompt({ pageLabel: 'x', references: [], combats: [], carry: null, reread: null })));
  const parsed = F.parseFacts(JSON.stringify({ combats: [], absence_notes: [EXPECTED.session_006, '', 42, { pc_id: 'x' }] }));
  assert('A-4: parse keeps plain sentences only', JSON.stringify(parsed.absence_notes) === JSON.stringify([EXPECTED.session_006]));
  assert('A-4: a reply without the list gets an empty one', F.parseFacts('{"combats":[]}').absence_notes.length === 0);
  const merged = F.mergePages([{ page: 1, facts: parsed }, { page: 2, facts: F.parseFacts(JSON.stringify({ combats: [], absence_notes: [EXPECTED.session_006] })) }], []);
  assert('A-4: the same absence on two pages is kept once', merged.absence_notes.length === 1);
}

// ── A-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest A-5 — the viewers');
{
  const load = file => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('function normaliseCampaignJson');
    const end = src.indexOf('\n}\n', start);
    return new Function(src.slice(start, end + 2) + '\nreturn normaliseCampaignJson;')();
  };
  const admin = load('admin/log-viewer.html')(campaign);
  const player = load('player/index.html')(campaign);
  const byLegacy = (v, id) => v.sessions.find(s => s.legacy_id === id);
  assert('A-5: the admin viewer maps the notes for sessions 2, 4 and 6', Object.entries(EXPECTED).every(([id, t]) => JSON.stringify(byLegacy(admin, id).absence_notes) === JSON.stringify([t])));
  assert('A-5: a session with no absence maps to an empty list', byLegacy(admin, 'session_001').absence_notes.length === 0);
  assert('A-5: both normalisers produce the same absence notes', JSON.stringify(admin.sessions.map(s => s.absence_notes)) === JSON.stringify(player.sessions.map(s => s.absence_notes)));
  const page = fs.readFileSync(path.join(ROOT, 'admin/log-viewer.html'), 'utf8');
  assert('A-5: the admin session card has an Attendance section', /section-label">Attendance</.test(page) && /sess\.absence_notes\?\.length/.test(page));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
