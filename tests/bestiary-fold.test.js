/**
 * tests/bestiary-fold.test.js
 *
 * Tests for issue #94: Goblin Slinger (mon_006) folded into Goblins (mon_004)
 * and mon_006 voided.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The fold is a one-off data edit, so nothing else would notice if a later
 * publish or hand edit brought mon_006 back, or pointed the slingers at a
 * second bestiary entry again. These checks pin down the issue's acceptance
 * items: no mon_006 reference, both Goblin Ambush groups still logged under
 * their own names, and one Goblins entry that shows both roles in both viewers.
 *
 * LOAD NOTE
 * ---------
 * Like tests/turn-schema.test.js, this cuts normaliseCampaignJson out of each
 * HTML page and runs the page's real code in Node. No browser is involved.
 *
 * RUN
 * ---
 * node tests/bestiary-fold.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

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

/**
 * loadNormaliser(file) → normaliseCampaignJson function from that page.
 * Same cut as tests/turn-schema.test.js: from the function keyword to the
 * first lone closing brace at column 0, which ends the function in both pages.
 */
function loadNormaliser(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function normaliseCampaignJson');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('normaliseCampaignJson not found in ' + file);
  return new Function(src.slice(start, end + 2) + '\nreturn normaliseCampaignJson;')();
}

const rawText  = fs.readFileSync(path.join(ROOT, 'data/magers-campaign.json'), 'utf8');
const campaign = JSON.parse(rawText);

// ── B-1: mon_006 is gone ────────────────────────────────────────────────────
console.log('\nB-1  No reference to mon_006');
assert('the text "mon_006" appears nowhere in the campaign file', !rawText.includes('mon_006'));
assert('no bestiary entry is named Goblin Slinger',
  !campaign.bestiary.some(b => /slinger/i.test(b.name)));

// ── B-2: the Goblin Ambush roster ───────────────────────────────────────────
console.log('\nB-2  Goblin Ambush roster');
const ambush = campaign.combat_encounters.find(c => c.id === 'cbt_005');
const roster = ambush.mechanics.enemies_roster;
const slingers = roster.find(g => g.actor_id === 'Goblin Slingers');
const goblins  = roster.find(g => g.actor_id === 'Goblins');
assert('Goblin Slingers points at mon_004', slingers?.mon_ref === 'mon_004');
assert('Goblin Slingers has role "slinger"', slingers?.role === 'slinger');
assert('Goblins still points at mon_004 with no role', goblins?.mon_ref === 'mon_004' && goblins.role === undefined);
const turnActors = new Set(ambush.rounds.flatMap(r => (r.enemy_turns || []).map(t => t.actor_id)));
assert('enemy turns are still logged as "Goblins" and "Goblin Slingers"',
  turnActors.has('Goblins') && turnActors.has('Goblin Slingers'));

// ── B-3: the merged Goblins entry ───────────────────────────────────────────
console.log('\nB-3  Merged Goblins entry');
const gob = campaign.bestiary.find(b => b.id === 'mon_004');
const slingAbilities = gob.mechanics.observed_abilities.filter(a => a.role === 'slinger');
assert('two abilities are tagged slinger', slingAbilities.length === 2);
assert('the general abilities stay untagged',
  gob.mechanics.observed_abilities.filter(a => !a.role).length === 2);
assert('the slinger description was carried into the narrative',
  gob.narrative.description.includes('hangs back and uses a sling'));
assert('the slinger sensory details were carried over', gob.narrative.sensory.includes('crack of sling'));

// ── B-4: both viewers show one Goblins entry with both roles ────────────────
console.log('\nB-4  Viewers');
for (const file of ['admin/log-viewer.html', 'player/index.html']) {
  const data = loadNormaliser(file)(campaign);
  const entries = data.bestiary.filter(b => /goblin/i.test(b.name));
  const e = entries[0];
  assert(file + ': one goblin bestiary entry', entries.length === 1);
  assert(file + ': roles list "Goblins" and "Goblin Slingers (slinger)"',
    JSON.stringify(e?.roles) === JSON.stringify(['Goblins', 'Goblin Slingers (slinger)']));
  assert(file + ': slinger abilities are labelled in traits',
    e?.traits.filter(t => t.startsWith('[slinger] ')).length === 2);
  assert(file + ': description is mapped to content', typeof e?.content === 'string' && e.content.length > 0);
  // Every bestiary entry, not just Goblins, must render without "undefined".
  assert(file + ': no bestiary trait or role contains "undefined"',
    data.bestiary.every(b => ![...b.traits, ...b.roles].some(s => s.includes('undefined'))));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
