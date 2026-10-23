/**
 * tests/opaque-ids.test.js
 *
 * Tests for issue #95: opaque UUID ids with legacy IDs kept.
 *   - shared/chronicle-ids.js helpers
 *   - scripts/migrate-opaque-ids.js checkReferences() — the phase 1 gate:
 *     every reference in the migrated JSON resolves to an existing opaque ID
 *   - the migrated data/magers-campaign.json and test fixture
 *   - both viewers' normaliseCampaignJson on the migrated data
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The migration rewrote every id and about 730 references. A later hand edit
 * or publish that writes a legacy ID, or a UUID that names nothing, would
 * break links silently: the viewers just show the raw string. These checks
 * fail loudly instead, and pin down the helper rules publish relies on
 * (exact matches only, prose and legacy_id untouched).
 *
 * RUN
 * ---
 * node tests/opaque-ids.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Ids  = require('../shared/chronicle-ids.js');
const { migrateCampaign, checkReferences, checkPassed } = require('../scripts/migrate-opaque-ids.js');

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

const ROOT = path.join(__dirname, '..');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const load = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/**
 * loadNormaliser(file) → normaliseCampaignJson from that page. Same cut as
 * tests/turn-schema.test.js: from the function keyword to the first lone
 * closing brace at column 0.
 */
function loadNormaliser(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function normaliseCampaignJson');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('normaliseCampaignJson not found in ' + file);
  return new Function(src.slice(start, end + 2) + '\nreturn normaliseCampaignJson;')();
}

// ── O-1 — chronicle-ids.js helpers ──────────────────────────────────────────
console.log('\nTest O-1 — shared/chronicle-ids.js');
{
  const a = Ids.newId(), b = Ids.newId();
  assert('newId() is a lowercase UUID v4', UUID_V4.test(a));
  assert('two newId() calls differ', a !== b);
  assert('isOpaqueId accepts a UUID, rejects a typed ID', Ids.isOpaqueId(a) && !Ids.isOpaqueId('npc_014'));
  assert('isLegacyId accepts npc_014, session_005, obj_003', ['npc_014', 'session_005', 'obj_003'].every(Ids.isLegacyId));
  assert('isLegacyId rejects prose and unknown prefixes', !Ids.isLegacyId('Killed by pc_006') && !Ids.isLegacyId('gap_001'));

  const index = new Map([['pc_001', 'U1'], ['cbt_002', 'U2']]);
  const out = Ids.translateRefs({ a: 'pc_001', legacy_id: 'pc_001', list: ['cbt_002', 'x'], note: 'pc_001 hit', n: 3, z: null }, index);
  assert('translateRefs replaces exact matches, deep', out.a === 'U1' && out.list[0] === 'U2' && out.list[1] === 'x');
  assert('translateRefs leaves prose and legacy_id alone', out.note === 'pc_001 hit' && out.legacy_id === 'pc_001');
  assert('translateRefs keeps numbers and null', out.n === 3 && out.z === null);

  const c = { party: [{ id: 'U1', legacy_id: 'pc_001' }], quest_ledger: [{ id: 'Q', mechanics: { objectives: [{ id: 'O', legacy_id: 'obj_001' }] } }] };
  assert('findEntity by legacy ID', Ids.findEntity(c, 'pc_001')?.entity.id === 'U1');
  assert('findEntity by UUID, nested objective', Ids.findEntity(c, 'O')?.array === 'quest_ledger.objectives');
  assert('buildLegacyIndex includes objectives', Ids.buildLegacyIndex(c).get('obj_001') === 'O');
}

// ── O-2 — the gate on the real data and the fixture ─────────────────────────
console.log('\nTest O-2 — every reference resolves (phase 1 gate)');
const campaign = load('data/magers-campaign.json');
for (const [label, data] of [['campaign', campaign], ['fixture', load('tests/fixtures/test-campaign.json')]]) {
  const r = checkReferences(data);
  assert(label + ': check passes (no broken, legacy, duplicate or unresolved target)', checkPassed(r));
  let all = true;
  Ids.forEachEntity(data, e => { if (e.id !== undefined && !(UUID_V4.test(e.id) && Ids.isLegacyId(e.legacy_id))) all = false; });
  assert(label + ': every entity has a UUID v4 id and a typed legacy_id', all);
}
{
  let n = 0; Ids.forEachEntity(campaign, () => n++);
  assert('campaign: 77 entities (72 in the entity arrays + 5 quest objectives)', n === 77);
  const r = checkReferences(campaign);
  assert('campaign: over 700 UUID references checked', r.references > 700);
  assert('campaign: _schema_version unchanged (5.0.0)', campaign._schema_version === '5.0.0');
  assert('campaign: _id_registry says uuid-v4 and keeps the voided list',
    campaign._id_registry?.format === 'uuid-v4' && ['npc_002', 'npc_005', 'npc_006', 'mon_006'].every(v => campaign._id_registry.legacy_voided.includes(v)));
  const again = JSON.parse(JSON.stringify(campaign));
  const { assigned } = migrateCampaign(again, campaign.meta.last_updated);
  assert('re-running the migration assigns nothing and changes nothing',
    assigned.size === 0 && JSON.stringify(again) === JSON.stringify(campaign));
}

// ── O-3 — the check catches what it should ──────────────────────────────────
console.log('\nTest O-3 — checkReferences catches bad references');
{
  const bad = JSON.parse(JSON.stringify(campaign));
  const cbt = bad.combat_encounters[0];
  cbt.mechanics.location = '00000000-0000-4000-8000-000000000000';       // names nothing
  cbt.rounds[0].slots[0].a = 'pc_001';                                     // legacy left behind
  cbt.rounds.find(r => r.enemy_turns.length).enemy_turns[0].actor_id = 'Nobody'; // not on the roster
  bad.party[1].id = bad.party[0].id;                                       // duplicate id
  const r = checkReferences(bad);
  assert('broken UUID reference reported', r.broken.some(x => x.includes('mechanics.location')));
  assert('leftover legacy ID reported', r.legacy.some(x => x.endsWith('= pc_001')));
  assert('unknown enemy actor reported', r.badTargets.some(x => x.includes('Nobody')));
  assert('duplicate id reported', r.duplicates.length > 0);
  assert('check fails', !checkPassed(r));
}

// ── O-4 — both viewers on the migrated data ─────────────────────────────────
console.log('\nTest O-4 — viewers show names, not UUIDs');
{
  const L = Ids.buildLegacyIndex(campaign);
  const views = ['admin/log-viewer.html', 'player/index.html'].map(f => [f, loadNormaliser(f)(campaign)]);
  const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  for (const [file, view] of views) {
    assert(file + ': legacy_ids maps pc_004 to its UUID', view.legacy_ids.pc_004 === L.get('pc_004'));
    assert(file + ': legacy_ids covers every top-level entity', Object.keys(view.legacy_ids).length >= 66);
    const text = JSON.stringify(view.combats.map(c => c.rounds.map(r => [r.slots.map(s => [s.act, s.notes]), r.enemy.map(e => [e.desc, e.impact])])));
    assert(file + ': no UUID in any combat line (act, notes, desc, impact)', !UUID_ANY.test(text));
    assert(file + ': sessions and party carry legacy_id', view.sessions.every(s => Ids.isLegacyId(s.legacy_id)) && view.party.every(p => Ids.isLegacyId(p.legacy_id)));
  }
  assert('admin and player legacy_ids are identical', JSON.stringify(views[0][1].legacy_ids) === JSON.stringify(views[1][1].legacy_ids));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
