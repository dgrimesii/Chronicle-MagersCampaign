/**
 * tests/ground-truth.test.js — the ground-truth set is well formed (issue #15)
 *
 * Checks the three files in tests/ocr-ground-truth/ without running the AI:
 *   T-1  each file names its page, image, session, what it tests and its
 *        status; all three are confirmed by the DM, with no open questions
 *   T-2  every legacy id it names exists in the real campaign, and every PC
 *        it maps to the fixture exists there (#111)
 *   T-3  rounds use the 5.0.0 vocabulary (economy, res, val_type, effect,
 *        special event type), actors follow the initiative order, targets
 *        are a PC, a roster group of the combat, or null
 *   T-4  passages have a speaker (dm or an NPC) and attach to something real
 *   T-5  the images are kept out of git
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * #17 compares a real run against these files. A typo in a legacy id or an
 * economy name would make that comparison fail for the wrong reason, so the
 * files are checked like code.
 *
 * RUN
 * ---
 * node tests/ground-truth.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds = require('../shared/chronicle-ids.js');

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
const DIR = path.join(ROOT, 'tests', 'ocr-ground-truth');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const campaign = JSON.parse(read('data/magers-campaign.json'));
const fixture = JSON.parse(read('tests/fixtures/test-campaign.json'));
const REAL = ChronicleIds.buildLegacyIndex(campaign);
const FIX = ChronicleIds.buildLegacyIndex(fixture);
const refs = shape => [...JSON.stringify(shape).matchAll(/\b((?:pc|npc|loc|qst|obj|item|cbt|session|mon|lore|moment)_\d{3})\b/g)].map(m => m[1]);

const ENUM = {
  economy: ['action', 'bonus_action', 'reaction', 'movement', 'free', 'legendary_action', 'legendary_resistance'],
  res: ['hit', 'miss', 'crit', 'save', 'success', 'failure', 'death', 'neutral', 'unclear'],
  val_type: ['damage', 'healing', 'temp_hp', 'resource_restored', 'shield_value', 'death_save_success', 'death_save_failure', 'other'],
  effect: ['killed', 'downed'],
  special: ['appeared', 'reinforcements', 'fled', 'downed', 'eliminated', 'phase_change', 'other'],
};

const files = [1, 2, 3].map(n => ({ n, name: `ground-truth-${n}.json`, data: JSON.parse(fs.readFileSync(path.join(DIR, `ground-truth-${n}.json`), 'utf8')) }));

// ── T-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest T-1 — each file names what it tests');
for (const { name, data } of files) {
  const a = data._about || {};
  assert(`T-1 ${name}: page, image, session and source named`, a.page && /^OCR Test Files\//.test(a.image) && /^session_\d{3}$/.test(a.session) && a.source_of_truth);
  assert(`T-1 ${name}: lists what it tests`, Array.isArray(a.tests) && a.tests.length >= 3);
  assert(`T-1 ${name}: status says whether the DM has confirmed it`, /DRAFT|confirmed/i.test(a.status || ''));
  assert(`T-1 ${name}: a draft lists its open questions`, !/DRAFT/.test(a.status) || (Array.isArray(data.to_confirm) && data.to_confirm.length > 0));
  // The DM confirmed all three pages on 2026-10-24 (#15's last acceptance
  // item). A later edit that reopens a question should say so in status.
  assert(`T-1 ${name}: confirmed by the DM, no open questions, answers recorded`,
    /^Confirmed by the DM/.test(a.status) && Array.isArray(data.to_confirm) && data.to_confirm.length === 0 && data.answered && data.answered.answers.length > 0);
  assert(`T-1 ${name}: every section is present`, ['entities', 'combats', 'rounds', 'passages', 'session_notes', 'quest_progress', 'loot', 'known_misreads'].every(k => k in data));
}

// ── T-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest T-2 — every legacy id exists');
for (const { name, data } of files) {
  const { _about, to_confirm, ...rest } = data;
  const missing = [...new Set(refs(rest))].filter(id => !REAL.has(id));
  assert(`T-2 ${name}: every legacy id is in the real campaign` + (missing.length ? ' — ' + missing.join(', ') : ''), missing.length === 0);
  const pcs = data.entities.filter(e => e.kind === 'pc');
  assert(`T-2 ${name}: each PC maps to a fixture PC (#111)`, pcs.length > 0 && pcs.every(e => FIX.has(e.fixture)));
  assert(`T-2 ${name}: the session exists in the fixture`, FIX.has(data.session.legacy_id));
  assert(`T-2 ${name}: every entity says what the fixture should do`, data.entities.every(e => typeof e.fixture === 'string' && e.fixture.length));
}

// ── T-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest T-3 — rounds use the turn schema');
for (const { name, data } of files) {
  const bad = [];
  for (const r of data.rounds) {
    const combat = data.combats.find(c => c.combat.startsWith(r.combat + ' '));
    if (!combat) { bad.push(`round ${r.n}: combat ${r.combat} not listed`); continue; }
    const order = combat.initiative_order;
    const real = campaign.combat_encounters.find(c => c.legacy_id === r.combat);
    const groups = new Set([...(real.mechanics.enemies_roster || []).map(g => g.actor_id), ...data.combats.flatMap(c => c.roster_adds.map(g => g.actor_id)),
      ...files.flatMap(f => f.data.combats.flatMap(c => c.roster_adds.map(g => g.actor_id)))]);
    // Turns follow the initiative order (a reaction may repeat an actor later).
    const firsts = r.turns.map(t => t.actor).filter((a, i, arr) => arr.indexOf(a) === i);
    if (JSON.stringify(firsts) !== JSON.stringify(order.slice(0, firsts.length))) bad.push(`round ${r.n}: turns not in initiative order`);
    const acts = r.turns.flatMap(t => t.activities).concat(r.enemy_turns.flatMap(t => t.activities));
    for (const t of r.enemy_turns) if (!groups.has(t.actor)) bad.push(`round ${r.n}: enemy ${t.actor} is not a roster group`);
    for (const t of r.enemy_turns) for (const ev of t.special_events || []) if (!ENUM.special.includes(ev.type)) bad.push(`round ${r.n}: event type ${ev.type}`);
    for (const a of acts) {
      if (!ENUM.economy.includes(a.economy)) bad.push(`round ${r.n}: economy ${a.economy}`);
      if (a.val_type && !ENUM.val_type.includes(a.val_type)) bad.push(`round ${r.n}: val_type ${a.val_type}`);
      for (const o of a.outcomes) {
        if (!ENUM.res.includes(o.res)) bad.push(`round ${r.n}: res ${o.res}`);
        if (o.effect && !ENUM.effect.includes(o.effect)) bad.push(`round ${r.n}: effect ${o.effect}`);
        if (o.target != null && !REAL.has(o.target) && !groups.has(o.target)) bad.push(`round ${r.n}: target ${o.target}`);
      }
    }
  }
  assert(`T-3 ${name}: rounds valid` + (bad.length ? ' — ' + bad.slice(0, 4).join('; ') : ''), bad.length === 0);
  assert(`T-3 ${name}: each combat lists six PCs in order`, data.combats.every(c => c.initiative_order.length === 6 && c.initiative_order.every(id => /^pc_00[1-6]$/.test(id))));
}

// ── T-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest T-4 — passages');
for (const { name, data } of files) {
  const ok = data.passages.every(p => p.text && (p.speaker === 'dm' || /^npc_\d{3}$/.test(p.speaker)) &&
    ['entity', 'combat', 'round', 'activity', 'quest_progress', 'session'].includes(p.attach.to));
  assert(`T-4 ${name}: every passage has text, a speaker and an attachment`, ok);
}
{
  const p3 = files[2].data.passages;
  assert('T-4: Helen\'s words on page 3 are her testimony, on the Quarry', p3.filter(p => p.speaker === 'npc_007').every(p => p.attach.entity === 'loc_002') && p3.some(p => p.speaker === 'npc_007'));
  assert('T-4: the absence note on page 2 is the sentence session_006 records (#112)',
    JSON.stringify(files[1].data.session_notes.absence_notes) === JSON.stringify(campaign.session_logs.find(s => s.legacy_id === 'session_006').narrative.absence_notes));
}

// ── T-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest T-5 — images stay out of git');
{
  const rootIgnore = read('.gitignore');
  const localIgnore = fs.readFileSync(path.join(DIR, '.gitignore'), 'utf8');
  assert('T-5: OCR Test Files/ is git-ignored', /^OCR Test Files\/\s*$/m.test(rootIgnore));
  assert('T-5: images copied into tests/ocr-ground-truth/ are git-ignored', /^\*\.jpg$/m.test(localIgnore) && /^\*\.png$/m.test(localIgnore));
  assert('T-5: no image is in the ground-truth folder\'s tracked files', !fs.readdirSync(DIR).some(f => /\.(jpe?g|png|heic)$/i.test(f)) || /^\*\.jpg$/m.test(localIgnore));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
