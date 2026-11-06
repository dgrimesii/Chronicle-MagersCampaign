/**
 * tests/corrections.test.js — what an applied correction may change (#128)
 *
 *   C-1  a short correction never doubles a name or spreads an instruction
 *   C-2  references and fixed-vocabulary fields are never rewritten
 *   C-3  a real name correction still reaches other cards
 *   C-4  entity card corrections land on the field they name
 *   C-5  commands drop the card and are never stored
 *   C-6  cascades from one reply get separate ids (#125)
 *   C-7  duplicates: same record vs a possible match (#131)
 *   C-8  descriptions hold no review wording or encounter text (#123, #126)
 *   C-9  money is not an item (#122)
 *   C-10 the latest round's combat status wins, and the DM's choice stays (#127)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The session 6 publish held "Larkspur Larkspur Dragon Lair" and "CANCEL a
 * CANCEL location entry". Each input below reproduced that text through the
 * old page code before the fix, so these fail if the behaviour returns.
 * The page's wiring is not covered: no test loads delta-review.html.
 *
 * RUN
 * ---
 * node tests/corrections.test.js
 */

'use strict';

const C = require('../shared/chronicle-corrections.js');

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

// spread(diff, rawData) runs a diff the way the page does: decide whether it
// is a fact, then apply it to another card's record.
function spread(diff, rawData) {
  const fact = C.factFromDiff(diff);
  return fact ? { fact, ...C.applyFact(rawData, fact) } : { fact: null, rawData, diffs: [], possible: false };
}

console.log('\nTest C-1 — no doubled names, no spread instructions');
{
  const dragon = { k: 'name', old: 'dragon', new: 'Larkspur Dragon' };
  const r = spread(dragon, { name: 'Larkspur Dragon Lair', other: 'Lurkspur Dragon', d: "Found in the Larkspur Dragon's hoard.", e: 'A dragon enemy' });
  assert('C-1: "dragon" to "Larkspur Dragon" is flag-only', r.fact && r.fact.flagOnly === true);
  assert('C-1: it changes no other card', r.diffs.length === 0 && r.rawData.name === 'Larkspur Dragon Lair');
  assert('C-1: it flags a card that still says dragon', r.possible === true);
  assert('C-1: a merge instruction is not a name',
    C.factFromDiff({ k: 'name', old: 'Slinge', new: 'CANCEL — merge into existing Goblins (302ca3fc)' }) === null);
  assert('C-1: command keys are not names',
    C.factFromDiff({ k: 'action', old: 'Create', new: 'CANCEL' }) === null && C.factFromDiff({ k: 'action', old: 'NEW', new: 'CANCEL' }) === null);
  assert('C-1: dashed text is not a name', C.factFromDiff({ k: 'name', old: 'Slinge', new: 'Goblins — see notes' }) === null);
  assert('C-1: a nested prose field is not a name', C.factFromDiff({ k: 'narrative.description', old: 'fallen', new: 'dead' }) === null);
  assert('C-1: a long sentence is not a name', C.factFromDiff({ k: 'name', old: 'Bel', new: 'the town the party passed through on the way' }) === null);
  assert('C-1: an id is not a name', C.factFromDiff({ k: 'name', old: 'Bel', new: 'loc_005' }) === null);
}

console.log('\nTest C-2 — references and vocabulary stay intact');
{
  const r = spread({ k: 'name', old: 'goblin', new: 'Goblins' },
    { id: 'goblin-1', legacy_id: 'goblin', mon_ref: 'goblin', actor_id: 'goblin-1', a: 'goblin', type: 'goblin', text: 'A goblin bit Mal' });
  assert('C-2: id, legacy_id and mon_ref are unchanged', r.rawData.id === 'goblin-1' && r.rawData.legacy_id === 'goblin' && r.rawData.mon_ref === 'goblin');
  assert('C-2: an actor handle changes only as a whole value', r.rawData.actor_id === 'goblin-1' && r.rawData.a === 'Goblins');
  assert('C-2: a vocabulary field is unchanged', r.rawData.type === 'goblin');
  assert('C-2: prose changes', r.rawData.text === 'A Goblins bit Mal');
  const uuid = '3f2b8c1e-dead-4c7e-b1f0-6d2a9e5c4b81';
  assert('C-2: a UUID in any field is unchanged', spread({ k: 'name', old: 'dead', new: 'Dead One' }, { x: uuid }).rawData.x === uuid);
}

console.log('\nTest C-3 — real corrections still spread');
{
  const r = spread({ k: 'name', old: 'Gold', new: 'Goldie' },
    { slots: [{ a: 'Gold', act: 'Gold crits' }], loot: '70 gold', town: 'Goldsmith Row' });
  assert('C-3: the actor and text change', r.rawData.slots[0].a === 'Goldie' && r.rawData.slots[0].act === 'Goldie crits');
  assert('C-3: lower-case "70 gold" is not rewritten', r.rawData.loot === '70 gold');
  assert('C-3: the other spelling is flagged', r.possible === true);
  assert('C-3: a longer word is not rewritten', r.rawData.town === 'Goldsmith Row');
  assert('C-3: each change is recorded', r.diffs.length === 2);
  const phrase = spread({ k: 'slots[2].act', old: 'Gold crits with True Strike', new: 'Goldie crits with True Strike' }, { t: 'Gold fell' });
  assert('C-3: a phrase diff spreads its one changed word', phrase.rawData.t === 'Goldie fell');
  const again = C.applyFact(phrase.rawData, phrase.fact);
  assert('C-3: applying a fact twice changes nothing more', again.diffs.length === 0);
  const caps = spread({ k: 'name', old: 'larkspur', new: 'Larkspur' }, { t: 'larkspur and LARKSPUR' });
  assert('C-3: a capitals fix reaches every case', caps.rawData.t === 'Larkspur and Larkspur' && !caps.fact.flagOnly);
  assert('C-3: "Bel" is not flagged inside a correct "Belfar"', spread({ k: 'name', old: 'Bel', new: 'Belfar' }, { t: 'Belfar' }).possible === false);
  assert('C-3: controlled round fields do not spread', C.factFromDiff({ k: 'slots[1].res', old: 'hit', new: 'miss' }) === null);
}

console.log('\nTest C-4 — entity corrections land on their field');
{
  const nested = { name: 'Kobold', narrative: { description: 'old' }, mechanics: { creature_type: null } };
  const w = C.writeEntityDiffs(nested, [
    { k: 'name', old: 'Kobold', new: 'Kobolds' },
    { k: 'narrative.description', old: 'old', new: 'small' },
    { k: 'creature_type', old: null, new: 'humanoid' },
  ]);
  assert('C-4: every diff is written', w.written.length === 3 && w.refused.length === 0);
  assert('C-4: a dotted path writes the nested field, not a literal key', nested.narrative.description === 'small' && !('narrative.description' in nested));
  assert('C-4: a bare name finds the field in its block', nested.mechanics.creature_type === 'humanoid' && !('creature_type' in nested));
  const flat = { name: 'Lair', description: 'old' };
  C.writeEntityDiffs(flat, [{ k: 'narrative · description', old: 'old', new: 'new' }]);
  assert('C-4: a flat card stays flat, so it shows the change', flat.description === 'new' && !flat.narrative);
  const open = { name: 'x' };
  C.writeEntityDiffs(open, [{ k: 'narrative.significance', new: 'big' }]);
  assert('C-4: a missing block is created', open.narrative.significance === 'big');
  const list = { mechanics: { objectives: [{ text: 'a' }] } };
  C.writeEntityDiffs(list, [{ k: 'mechanics.objectives[0].text', new: 'b' }]);
  assert('C-4: an existing array item can be edited', list.mechanics.objectives[0].text === 'b');
  assert('C-4: a missing array item is refused', C.writeEntityDiffs(list, [{ k: 'mechanics.objectives[5].text', new: 'b' }]).refused.length === 1);
  assert('C-4: a prototype path is refused', C.writeEntityDiffs({}, [{ k: '__proto__.bad', new: 1 }]).refused.length === 1 && ({}).bad === undefined);
}

console.log('\nTest C-5 — commands are obeyed, never stored');
{
  assert('C-5: "op": "delete" cancels', C.classifyDiffs([{ k: 'op', new: 'delete' }]).cancel === true);
  assert('C-5: { op: "cancel" } cancels', C.classifyDiffs([{ op: 'cancel' }]).cancel === true);
  assert('C-5: "action": "CANCEL" cancels', C.classifyDiffs([{ k: 'action', old: null, new: 'CANCEL' }]).cancel === true);
  const merge = C.classifyDiffs([{ k: 'name', old: 'x', new: 'CANCEL — merge into existing Goblins' }]);
  assert('C-5: an instruction in a field is refused, not written or cancelled', merge.refused.length === 1 && merge.data.length === 0 && merge.cancel === false);
  const rounds = C.classifyDiffs([{ op: 'reorder', slots: [] }, { op: 'add_slot', slot: {} }, { k: 'slots[0].action', new: 'Attack' }]);
  assert('C-5: round operations and round fields pass through', rounds.data.length === 3 && !rounds.cancel && !rounds.refused.length);
  assert('C-5: an unknown operation is refused', C.classifyDiffs([{ op: 'teleport' }]).refused.length === 1);
  assert('C-5: ordinary prose starting "Remove" in lower case is kept',
    C.classifyDiffs([{ k: 'description', new: 'remove the curse first' }]).data.length === 1);
}

console.log('\nTest C-6 — cascade ids (#125)');
{
  const taken = [];
  for (let i = 0; i < 3; i++) taken.push(C.newCascadeId(taken, 1000));
  assert('C-6: three cascades in one millisecond get three ids', new Set(taken).size === 3 && taken[0] === 'd_cascade_1000');
}

console.log('\nTest C-7 — duplicates (#131)');
{
  const index = C.buildRecordIndex({
    bestiary: [{ id: 'b1', name: 'Goblins' }, { id: 'b2', name: 'Larkspur Dragon', aliases: ['Old Scales'] }, { id: 'b3', name: 'Wolves' }],
    inventory_and_loot: [{ id: 'i1', legacy_id: 'item_011', name: 'Immovable Rod' }],
    locations: [{ id: 'l1', legacy_id: 'loc_011', name: 'Lake Town' }],
    npc_directory: [{ id: 'n1', name: 'Bel' }],
    quest_ledger: [{ id: 'q1', title: 'Escort Cart to Lake Town' }],
  });
  const dup = (name, type) => C.findDuplicate(name, type, index);
  assert('C-7: exact name in any case is the same record', dup('immovable rod', 'item').strength === 'same' && dup('Immovable Rod', 'item').legacy_id === 'item_011');
  assert('C-7: singular and plural are the same record', dup('goblin', 'monster').id === 'b1' && dup('goblin', 'monster').strength === 'same' && dup('Wolf', 'monster').id === 'b3');
  assert('C-7: an alias is the same record', dup('Old Scales', 'monster').id === 'b2');
  assert('C-7: a quest is found by its title', dup('Escort Cart to Lake Town', 'quest').id === 'q1');
  assert('C-7: a misspelling is only a warning', dup('Lurkspur Dragon', 'monster').strength === 'close' && dup('Lurkspur Dragon', 'monster').name === 'Larkspur Dragon');
  assert('C-7: the same name on another kind is only a warning', dup('Lake Town', 'monster').strength === 'close');
  assert('C-7: a short different name is not caught', dup('Ben', 'npc') === null);
  assert('C-7: a different creature is not caught', dup('Hobgoblins', 'monster') === null && dup('Kobold', 'monster') === null);
}

console.log('\nTest C-8 — descriptions (#123, #126)');
{
  const dedup = "DEDUP CHECK REQUIRED before creating: Search existing location records for 'Lake Town' … If a match is found, link the existing location record to this quest …";
  assert('C-8: the session 6 instruction text is removed', C.cleanDescription(dedup).text === null && C.cleanDescription(dedup).removed === dedup);
  assert('C-8: a placeholder id is removed', C.cleanDescription('loc_new_01 — "The Old Bridge" added to review queue').text === null);
  for (const fine of ['A trading town on the lake.', 'A queue of refugees waits at the gate.', 'A cascade of water falls from the cliff.', 'Create a warm light with a word.']) {
    assert(`C-8: "${fine}" is kept`, C.cleanDescription(fine).text === fine);
  }
  const party = ['Mal', 'Ash', 'Goldie'];
  const fight = 'Kobolds mostly repositioning; one attacked Mal and missed.';
  assert('C-8: the session 6 encounter text moves to evidence', C.reusableDescription(fight, party).text === null && C.reusableDescription(fight, party).evidence === fight);
  assert('C-8: a round reference moves to evidence', C.reusableDescription('Appeared in Round 4.', party).text === null);
  assert('C-8: "Ash-grey" does not match a PC called Ash', C.reusableDescription('An Ash-grey lizard with a long tail.', party).text !== null);
  assert('C-8: a standard description is kept', C.reusableDescription('Small reptilian humanoid that fights in packs.', party).text !== null);
  const frozen = require('./fixtures/campaign-pre-session-6.json');
  const names = frozen.party.flatMap(p => [p.name, p.nickname]);
  const flagged = frozen.bestiary.filter(b => b.narrative?.description && C.reusableDescription(b.narrative.description, names).text === null).map(b => b.name);
  assert('C-8: no description in the frozen bestiary is caught' + (flagged.length ? ' — ' + flagged.join(', ') : ''), flagged.length === 0);
}

console.log('\nTest C-9 — treasure (#122)');
{
  for (const name of ['1,400 cp', '1300 sp', '70 gp', 'Art and Gems (900 gp)', 'emerald worth 100 GP', '2 smoky quartz, 25 GP each', 'Gold pieces']) {
    assert(`C-9: "${name}" is cash`, C.isCashTreasure(name, null));
  }
  assert('C-9: a gem priced in its description is cash', C.isCashTreasure('Unrefined Emerald', 'Worth 100 GP'));
  for (const name of ['Silver Dagger', 'Golden Idol', 'Potion of Healing ×2', 'oddly warm gem', 'shimmering diamond', 'Immovable Rod', '+1 Moon Sickle', 'Map to the Quarry']) {
    assert(`C-9: "${name}" stays an item`, !C.isCashTreasure(name, null));
  }
  assert('C-9: a priced magic item stays an item', !C.isCashTreasure('Potion of Healing', 'worth 50 gp'));
}

console.log('\nTest C-10 — combat status (#127)');
{
  let s = C.mergeCombatStatus(null, { outcome: 'paused', evidence: 'Combat continues', location: 'Road to Lake Town' }, 3);
  assert('C-10: the first reading sets the card', s.outcome === 'paused' && s.evidence === 'Combat continues' && s.location === 'Road to Lake Town' && s.round === 3);
  s = C.mergeCombatStatus(s, { outcome: 'victory', evidence: 'Combat Ended' }, 7);
  assert('C-10: a later round wins', s.outcome === 'victory' && s.round === 7 && s.location === 'Road to Lake Town');
  const earlier = C.mergeCombatStatus(s, { outcome: 'paused' }, 2);
  assert('C-10: a page from an earlier round does not undo it', earlier.outcome === 'victory' && earlier.round === 7);
  const chosen = C.mergeCombatStatus(Object.assign({}, s, { outcome: 'pyrrhic', outcomeChosen: true }), { outcome: 'defeat' }, 9);
  assert('C-10: the DM\'s choice is never replaced', chosen.outcome === 'pyrrhic');
  assert('C-10: a value outside the schema is ignored', C.mergeCombatStatus(null, { outcome: 'won' }, 1).outcome === null);
  const data = require('./fixtures/campaign-pre-session-6.json');
  const ref = JSON.stringify(data._field_type_reference || {});
  assert('C-10: the outcome list matches the data file\'s own', C.OUTCOMES.every(o => ref.includes(`"${o}"`)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
