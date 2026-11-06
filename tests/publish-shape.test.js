/**
 * tests/publish-shape.test.js — publish checks what it is given (#129, #130)
 *
 *   S-1  a flat new record is written in the shape the viewers read
 *   S-2  command fields and dotted keys never reach a record
 *   S-3  a whole-object MOD changes only the fields it holds
 *   S-4  a combat status card sets the outcome, and a location named in the review
 *   R-1  a slot that is not a number takes the actor's number, or is left blank
 *   R-2  an enemy label with a verb joins the right group, linked to the bestiary
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The session 6 publish wrote flat locations, a slot called "enemies" and a roster
 * group called "Goblins hit". These inputs have those shapes and run through the
 * real applySession(). Each test has its own small data (see README "Test data").
 *
 * RUN
 * ---
 * node tests/publish-shape.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ChroniclePublish = require('../shared/chronicle-publish.js');
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

const base = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'test-campaign.json'), 'utf8'));
const NEW = (array, rawData) => ({ id: 'n' + Math.random(), type: 'NEW', array, status: 'approved', title: 'card', rawData });
const named = (list, name) => (list || []).find(e => (e.name || e.title) === name);

console.log('\nTest S-1 — flat records');
{
  const { campaign: c } = ChroniclePublish.applySession(base(), [
    NEW('locations', { name: 'Road to Lake Town', type: 'location', description: 'The road to Lake Town.' }),
    NEW('quest_ledger', { name: 'Escort the Cart', type: 'quest', description: 'Take the cart to Lake Town.', status: 'active' }),
    NEW('inventory_and_loot', { name: 'Silver Dagger', description: 'A plain dagger.', item_type: 'weapon' }),
    NEW('bestiary', { name: 'Kobold', type: 'monster', description: 'A small reptilian humanoid.' }),
    NEW('npc_directory', { name: 'Tess', mechanics: { disposition: 'friendly' }, narrative: { description: 'A carter.' } }),
  ], {});
  const loc = named(c.locations, 'Road to Lake Town');
  assert('S-1: a location description moves into narrative', loc.narrative.description === 'The road to Lake Town.' && !('description' in loc));
  assert('S-1: the card kind word is not stored', !('type' in loc) && !('type' in loc.mechanics));
  assert('S-1: a new record gets its type tag, id and notes', loc._object_type === 'location' && ChronicleIds.isOpaqueId(loc.id) && loc.notes === null);
  const q = named(c.quest_ledger, 'Escort the Cart');
  assert('S-1: a quest name becomes its title', q.title === 'Escort the Cart' && !('name' in q));
  assert('S-1: a quest description becomes the motivation the viewers show', q.narrative.motivation === 'Take the cart to Lake Town.' && !('description' in q));
  assert('S-1: a quest status moves into mechanics, not out as a command', q.mechanics.status === 'active' && !('status' in q));
  const item = named(c.inventory_and_loot, 'Silver Dagger');
  assert('S-1: item fields reach both blocks', item.narrative.description === 'A plain dagger.' && item.mechanics.item_type === 'weapon');
  assert('S-1: a bestiary entry is shaped', named(c.bestiary, 'Kobold').narrative.description === 'A small reptilian humanoid.');
  const npc = named(c.npc_directory, 'Tess');
  assert('S-1: a record already in shape is unchanged in its blocks', npc.mechanics.disposition === 'friendly' && npc.narrative.description === 'A carter.');
}

console.log('\nTest S-2 — commands and dotted keys');
{
  const { campaign: c, notes } = ChroniclePublish.applySession(base(), [
    NEW('bestiary', { name: 'Ghoul', op: 'delete', action: 'CANCEL', 'narrative.description': 'A pale corpse-eater.', 'mechanics.threat_level': 'high' }),
    NEW('locations', { name: 'Keep', description: 'flat copy', narrative: { description: 'nested copy' } }),
  ], {});
  const g = named(c.bestiary, 'Ghoul');
  assert('S-2: command fields are not written', !('op' in g) && !('action' in g));
  assert('S-2: dotted keys reach their fields', g.narrative.description === 'A pale corpse-eater.' && g.mechanics.threat_level === 'high' && !('narrative.description' in g));
  assert('S-2: a dropped command is reported', [...notes].some(n => /Ghoul.*"op"/.test(n)));
  const keep = named(c.locations, 'Keep');
  assert('S-2: the nested value wins over a flat copy', keep.narrative.description === 'nested copy' && !('description' in keep));
  assert('S-2: the difference is reported', [...notes].some(n => /Keep.*narrative\.description/.test(n)));
}

console.log('\nTest S-3 — a whole-object MOD');
{
  const b = base();
  const loc = b.locations[0];
  loc.narrative = { description: 'recorded', significance: 'kept' };
  loc.mechanics = { region: 'kept' };
  const { campaign: c } = ChroniclePublish.applySession(b, [
    { id: 'm', type: 'MOD', array: 'locations', status: 'approved', title: 'card', targetId: loc.id,
      rawData: { id: loc.id, description: 'updated', narrative: { flavor_text: null } } },
  ], {});
  const after = c.locations.find(l => l.id === loc.id);
  assert('S-3: the changed field is written', after.narrative.description === 'updated');
  assert('S-3: other fields in the blocks survive', after.narrative.significance === 'kept' && after.mechanics.region === 'kept');
  assert('S-3: no flat copy is left', !('description' in after));
}

// A published combat holding one round, for the round checks below.
function roundCase(slots, enemy) {
  const b = base();
  const pc = b.party[0];
  b.bestiary.push({ _object_type: 'monster', id: ChronicleIds.newId(), name: 'Goblins', mechanics: {}, narrative: {}, notes: null });
  const combat = NEW('combat_encounters', { id: 'cbt_900', name: 'Test Fight', rounds: [
    { n: 1, session_id: b.session_logs[0].id, slots: slots(pc), enemy_turns: enemy },
  ] });
  const { campaign: c, notes } = ChroniclePublish.applySession(b, [combat], {});
  return { pc, combat: named(c.combat_encounters, 'Test Fight'), bestiary: c.bestiary, notes: [...notes] };
}

console.log('\nTest R-1 — slot numbers');
{
  const flat = (s, a, act) => ({ s, a, act, res: 'hit', val: 3, action_type: 'action', target: null, target_effects: [] });
  const r = roundCase(pc => [flat(4, pc.id, 'Attack'), flat('enemies', pc.id, 'Opportunity Attack')], []);
  const slots = r.combat.rounds[0].slots;
  assert('R-1: "enemies" takes the actor\'s number', slots.every(s => s.s === 4) && slots.length === 1);
  assert('R-1: the change is reported', r.notes.some(n => /slot "enemies".*used slot 4/.test(n)));
  const blank = roundCase(pc => [flat('enemies', pc.id, 'Attack')], []);
  assert('R-1: with no number to find it is left blank, not stored as text', blank.combat.rounds[0].slots[0].s === null);
  assert('R-1: a blank is reported', blank.notes.some(n => /left blank/.test(n)));
  const str = roundCase(pc => [flat('2', pc.id, 'Attack')], []);
  assert('R-1: a number in text form still becomes a number', str.combat.rounds[0].slots[0].s === 2);
}

console.log('\nTest R-2 — enemy labels');
{
  const r = roundCase(() => [], [{ desc: 'Goblins hit: Mal for 7' }]);
  const roster = r.combat.mechanics.enemies_roster;
  const goblinId = named(r.bestiary, 'Goblins').id;
  assert('R-2: no group is named after the verb', roster.length === 1 && roster[0].actor_id === 'Goblins');
  assert('R-2: the group links to the bestiary', roster[0].mon_ref === goblinId);
  const turn = r.combat.rounds[0].enemy_turns[0];
  assert('R-2: the verb stays with the action', turn.actor_id === 'Goblins' && turn.activities[0].name === 'hit Mal for 7');
  const unknown = roundCase(() => [], [{ desc: 'Shadow Beast: claws Mal' }]);
  assert('R-2: a real new creature still gets its own group', unknown.combat.mechanics.enemies_roster[0].actor_id === 'Shadow Beast');
  const none = roundCase(() => [], [{ desc: 'something moved in the dark' }, { desc: 'Goblins: rush' }]);
  assert('R-2: a line naming no group is still recorded honestly',
    none.combat.mechanics.enemies_roster.some(g => g.actor_id === 'Unidentified enemies'));
}

console.log('\nTest S-4 — combat status cards (#127)');
{
  const card = (id, outcome, place) => ({ id: 'status', type: 'MOD', array: 'combat_encounters', status: 'approved', title: 'card', targetId: id,
    rawData: { id, _set: { 'mechanics.outcome': outcome }, _location_name: place } });
  const b = base();
  const newCombat = NEW('combat_encounters', { id: 'cbt_900', name: 'Road Fight', mechanics: { outcome: null, location: null } });
  const place = NEW('locations', { name: 'Road to Lake Town', description: 'A road.' });
  const { campaign: c, notes } = ChroniclePublish.applySession(b, [card('cbt_900', 'paused', 'road to lake town'), newCombat, place], {});
  const fight = named(c.combat_encounters, 'Road Fight');
  assert('S-4: a new combat takes its outcome', fight.mechanics.outcome === 'paused');
  assert('S-4: it takes a location queued in the same publish, by id', fight.mechanics.location === named(c.locations, 'Road to Lake Town').id);
  const other = ChroniclePublish.applySession(base(), [NEW('combat_encounters', { id: 'cbt_900', name: 'Fight' }), card('cbt_900', 'victory', 'Nowhere')], {});
  const f = named(other.campaign.combat_encounters, 'Fight');
  assert('S-4: an unknown place is not written', f.mechanics.location === null && f.mechanics.outcome === 'victory');
  assert('S-4: an unknown place is reported', [...other.notes].some(n => /no location is named "Nowhere"/.test(n)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
