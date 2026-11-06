/**
 * tests/live-campaign.test.js
 *
 * Checks the real data/magers-campaign.json against rules that hold however
 * much the campaign grows: valid ids and references, the turn schema, no
 * review leftovers, and both viewers agreeing on it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other test reads a frozen copy of the campaign, so that running an
 * intake cannot change its result. That leaves the real file unguarded, and it
 * is what a publish or a hand edit can damage. This file is that guard, so run
 * it after every intake: a failure here means the campaign data has a problem,
 * while a failure anywhere else means the code does.
 *
 * Nothing here may name a count or a particular combat, because the file is
 * meant to change. A check like "42 rounds" belongs in a frozen-copy test. If
 * this file were removed, a bad publish would only be noticed by eye.
 *
 * Read only: it never writes the campaign file.
 *
 * RUN
 * ---
 * node tests/live-campaign.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const ChronicleIds = require('../shared/chronicle-ids.js');
// chronicle-publish.js finds the id helpers as a global, as it does in the browser.
global.ChronicleIds = ChronicleIds;
const ChroniclePublish = require('../shared/chronicle-publish.js');
const { checkReferences, checkPassed } = require('../scripts/migrate-opaque-ids.js');

let passed = 0;
let failed = 0;

/**
 * assert(label, problems)
 * Passes when the list of problems is empty, and otherwise prints the first
 * few. It takes a list, not a true/false, because a failure here sends the DM
 * to fix the data, so it has to say where the problem is. Every test runs; no
 * bail on first failure.
 */
function assert(label, problems) {
  if (!problems.length) { console.log('  PASS  ' + label); passed++; return; }
  console.log('  FAIL  ' + label);
  problems.slice(0, 8).forEach(p => console.log('          ' + p));
  if (problems.length > 8) console.log('          …and ' + (problems.length - 8) + ' more');
  failed++;
}

const ROOT = path.join(__dirname, '..');
const read = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const campaign = read('data/magers-campaign.json');
const frozen = read('tests/fixtures/campaign-pre-session-6.json');

// The arrays that hold campaign records. Workflow logs and the file's own
// documentation (keys starting "_") may quote review words, so they are left out.
const RECORD_ARRAYS = ['party', 'session_logs', 'npc_directory', 'locations', 'quest_ledger', 'inventory_and_loot',
  'world_lore', 'combat_encounters', 'bestiary', 'character_moments', 'factions', 'cohorts'];
const records = () => RECORD_ARRAYS.flatMap(a => (campaign[a] || []).map((e, i) => ({ array: a, i, e, label: `${a}[${i}] ${e.title || e.name || e.id}` })));

/**
 * eachString(value, visit) calls visit(text, pathSoFar) for every string inside
 * value. The leftover and bestiary checks read free text anywhere in a record,
 * and a fixed list of fields would miss a stray field, which is the likely defect.
 */
function eachString(value, visit, at = '') {
  if (typeof value === 'string') visit(value, at);
  else if (Array.isArray(value)) value.forEach((v, i) => eachString(v, visit, `${at}[${i}]`));
  else if (value && typeof value === 'object') Object.keys(value).forEach(k => eachString(value[k], visit, at ? `${at}.${k}` : k));
}

// ── L-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest L-1 — ids and references');
{
  const r = checkReferences(campaign);
  assert('L-1: every reference resolves (same check as migrate-opaque-ids --check)',
    checkPassed(r) ? [] : [...r.broken, ...r.legacy, ...r.duplicates, ...r.badTargets]);
  const badIds = [];
  ChronicleIds.forEachEntity(campaign, e => {
    if (e.id !== undefined && !ChronicleIds.isOpaqueId(e.id)) badIds.push(`${e.name || e.title}: id ${e.id}`);
    // A legacy_id is optional: entities created after #95 have none.
    if (e.legacy_id !== undefined && !ChronicleIds.isLegacyId(e.legacy_id)) badIds.push(`${e.name || e.title}: legacy_id ${e.legacy_id}`);
  });
  assert('L-1: every id is a UUID, and any legacy_id is well formed', badIds);
  // Voided IDs were retired for good (issue #94 for mon_006); the registry's own list records that.
  const voided = campaign._id_registry?.legacy_voided || [];
  const text = JSON.stringify(Object.assign({}, campaign, { _id_registry: null }));
  assert('L-1: no voided legacy ID has come back', voided.filter(v => text.includes(`"${v}"`)));
  assert('L-1: _schema_version matches the frozen copy (a change must convert the copy too)',
    campaign._schema_version === frozen._schema_version ? [] : [`${campaign._schema_version} vs ${frozen._schema_version}`]);
  assert('L-1: no session has the retired mechanics.player_absences (#112)',
    campaign.session_logs.filter(s => 'player_absences' in (s.mechanics || {})).map(s => s.legacy_id || s.id));
}

// ── L-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest L-2 — every round is on the turn schema');
{
  const ECONOMY = ['action', 'bonus_action', 'reaction', 'movement', 'free', 'legendary_action', 'legendary_resistance'];
  const OLD_FIELDS = ['action', 'bonus_action', 'reaction', 'movement', 'object_interaction', 'attacks'];
  const EFFECTS = ['killed', 'downed'];
  const shape = [], slotNumbers = [], repeats = [], targets = [];
  for (const c of campaign.combat_encounters) {
    for (const r of c.rounds || []) {
      const at = `${c.name} round ${r.n}`;
      // A slot number that is not a number is how an enemy heading once became a slot.
      for (const s of r.slots || []) if (typeof s.s !== 'number') slotNumbers.push(`${at}: slot "${s.s}"`);
      const actors = (r.enemy_turns || []).map(t => t.actor_id);
      const dup = actors.filter((a, i) => actors.indexOf(a) !== i);
      if (dup.length) repeats.push(`${at}: ${dup.join(', ')}`);
      for (const t of [...(r.slots || []), ...(r.enemy_turns || [])]) {
        const who = `${at}, ${t.actor_id || 'slot ' + t.s}`;
        if (!Array.isArray(t.activities)) { shape.push(`${who}: no activities list`); continue; }
        for (const f of OLD_FIELDS) if (f in t) shape.push(`${who}: old field ${f}`);
        for (const a of t.activities) {
          if (!ECONOMY.includes(a.economy)) shape.push(`${who}: economy ${a.economy}`);
          if (!Array.isArray(a.outcomes)) { shape.push(`${who}: "${a.name}" has no outcomes list`); continue; }
          for (const o of a.outcomes) {
            if (o.effect && !EFFECTS.includes(o.effect)) shape.push(`${who}: effect ${o.effect}`);
            if ('target_text' in o && o.target_id !== null) targets.push(`${who}: target_text alongside target_id`);
            if (typeof o.target_id === 'string' && o.target_id.includes('/')) targets.push(`${who}: slash-joined target ${o.target_id}`);
          }
        }
      }
    }
  }
  assert('L-2: turns have activities[] and outcomes[], no 4.x fields, known economies and effects', shape);
  assert('L-2: every slot number is a number', slotNumbers);
  assert('L-2: one enemy turn per roster group per round', repeats);
  assert('L-2: one target per outcome, target_text only with a null target_id', targets);
}

// ── L-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest L-3 — no review leftovers');
{
  // Session 6 published review instructions as data ("CANCEL — merge into…").
  const review = [];
  for (const { e, label } of records()) {
    eachString(e, (text, at) => { if (/\bCANCEL\b/.test(text)) review.push(`${label} ${at}: ${text.slice(0, 70)}`); });
  }
  assert('L-3: no review instruction was published as campaign text', review);
  // A correction's own fields ("op": "delete", "narrative.description") must be
  // applied, never stored: the same publish left both on a bestiary entry.
  const stray = [];
  for (const { e, label } of records()) {
    if ('op' in e) stray.push(`${label}: op`);
    if (e.action === 'CANCEL') stray.push(`${label}: action`);
    Object.keys(e).filter(k => k.includes('.')).forEach(k => stray.push(`${label}: ${k}`));
  }
  assert('L-3: no correction field was left on a record', stray);
  const shape = [];
  for (const a of ['locations', 'quest_ledger', 'bestiary', 'inventory_and_loot']) {
    (campaign[a] || []).forEach((e, i) => {
      const label = `${a}[${i}] ${e.title || e.name}`;
      // A record with its text at the top level is invisible: the viewers read narrative.*.
      if (!e.narrative || typeof e.narrative !== 'object') shape.push(`${label}: no narrative block`);
      if (!e.mechanics || typeof e.mechanics !== 'object') shape.push(`${label}: no mechanics block`);
      if ('description' in e) shape.push(`${label}: description outside narrative`);
    });
  }
  assert('L-3: locations, quests, bestiary entries and items have the shape the viewers read', shape);
}

// ── L-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest L-4 — the bestiary is reusable');
{
  // The DM's rule (see CLAUDE.md): nothing in an entry records one event. Whether
  // prose tells a story needs a person, but naming a combat or round is checkable.
  const eventWords = [];
  for (const b of campaign.bestiary) {
    eachString({ mechanics: { observed_abilities: b.mechanics?.observed_abilities, observed_weaknesses: b.mechanics?.observed_weaknesses }, narrative: b.narrative }, (text, at) => {
      if (/\bcbt_\d{3}\b|\bround \d/i.test(text)) eventWords.push(`${b.name} ${at}: ${text.slice(0, 70)}`);
    });
  }
  assert('L-4: no bestiary text names a combat or a round', eventWords);
  const names = campaign.bestiary.map(b => (b.name || '').toLowerCase());
  assert('L-4: no two bestiary entries share a name, in any case',
    names.filter((n, i) => names.indexOf(n) !== i));
}

// ── L-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest L-5 — both viewers on the real data');
{
  const load = file => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('function normaliseCampaignJson');
    const end = src.indexOf('\n}\n', start);
    return new Function(src.slice(start, end + 2) + '\nreturn normaliseCampaignJson;')();
  };
  const admin = load('admin/log-viewer.html')(JSON.parse(JSON.stringify(campaign)));
  const player = load('player/index.html')(JSON.parse(JSON.stringify(campaign)));
  assert('L-5: admin and player combats are identical',
    JSON.stringify(admin.combats) === JSON.stringify(player.combats) ? [] : ['the two normalisers differ']);
  const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const bad = [], uuids = [];
  for (const c of admin.combats) {
    for (const r of c.rounds || []) {
      const lines = [...(r.slots || []).map(s => [s.act, s.notes]), ...(r.enemy || []).map(e => [e.desc, e.impact])];
      const text = JSON.stringify(lines);
      if (text.includes('undefined')) bad.push(`${c.name} round ${r.n}`);
      if (UUID_ANY.test(text)) uuids.push(`${c.name} round ${r.n}: ${text.match(UUID_ANY)[0]}`);
    }
  }
  assert('L-5: no combat line shows "undefined"', bad);
  assert('L-5: no combat line shows a raw UUID', uuids);
}

// ── L-6 ─────────────────────────────────────────────────────────────────────
console.log('\nTest L-6 — computed fields are up to date');
{
  // Publish recomputes these. A difference means a hand edit changed one side
  // of a link (a combat's location, say) and the next publish would add the other.
  const copy = JSON.parse(JSON.stringify(campaign));
  ChroniclePublish.deriveFields(copy);
  const changed = [];
  for (const { array, i, label } of records()) {
    if (JSON.stringify(campaign[array][i]) !== JSON.stringify(copy[array][i])) changed.push(label);
  }
  assert('L-6: deriveFields would change nothing', changed);
}

// ── L-7 ─────────────────────────────────────────────────────────────────────
console.log('\nTest L-7 — the frozen copy is still frozen');
{
  // If the copy were overwritten with a newer campaign, the behaviour tests
  // would fail for reasons that have nothing to do with the code.
  const ambush = frozen.combat_encounters.find(c => c.legacy_id === 'cbt_005');
  assert('L-7: the copy is the campaign from before session 6',
    frozen.meta.last_updated === '2026-10-23' && ambush?.mechanics?.outcome === 'paused' && ambush.rounds.length === 3 ? [] : ['tests/fixtures/campaign-pre-session-6.json has been changed']);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
