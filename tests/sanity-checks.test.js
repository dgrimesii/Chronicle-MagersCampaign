/**
 * tests/sanity-checks.test.js — the nine round sanity checks (issue #104)
 *
 * Tests the checks added to shared/chronicle-integrity.js: imbalance, source
 * line, ability ownership, action economy, outcome count, state, round
 * order, duplicates and gaps. One test per check on
 * tests/fixtures/test-campaign.json (its combat cbt_001 has three rounds for
 * Aldric and Sable), then the issue's acceptance cases on the real campaign.
 *   S-1 … S-9  one per check, each with a case that flags and one that does not
 *   S-10       Att's Cure Wounds in Goli's row: ability ownership and source
 *              line both flag, and suggest moving it to Att
 *   S-11       cbt_002 round 4 raises an outcome-count flag
 *   S-12       no check can block publishing
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The checks guide the AI (#101) and highlight cells in the round grid
 * (#103); a check that fires on correct data, or misses the misreads it was
 * written for, would teach the DM to ignore it. These tests pin both sides.
 *
 * RUN
 * ---
 * node tests/sanity-checks.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// chronicle-integrity.js attaches to window, as in a browser.
global.window = {};
require('../shared/chronicle-integrity.js');
const CI = window.ChronicleIntegrity;
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

const read = rel => JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
const fixture = read('tests/fixtures/test-campaign.json');
const clone = v => JSON.parse(JSON.stringify(v));
const F = ChronicleIds.buildLegacyIndex(fixture);
const ALDRIC = F.get('pc_001'), SABLE = F.get('pc_002');

// Abilities for the two fixture PCs (they have no harvested sheet).
const fxAbilities = { characters: [
  { pc_id: 'pc_001', actions: ['Second Wind'], spells: [], feats: [], action_economy: [{ ability: 'Second Wind', action_type: 'bonus_action' }] },
  { pc_id: 'pc_002', actions: ['Sneak Attack', 'Cunning Action'], spells: ['Mage Hand'], feats: [], action_economy: [] },
] };
const fxCtx = () => ({ abilities: CI.abilityContext(fixture, fxAbilities), names: CI.partyNames(fixture) });

// A three-round combat on the fixture's PCs, built fresh for each test.
const act = (economy, name, outcomes, extra) => Object.assign({ economy, name, outcomes: outcomes || [] }, extra);
const hit = (val, target, extra) => Object.assign({ res: 'hit', val: val ?? null, target_id: target || null }, extra);
function combat() {
  return {
    id: 'cbt_test', name: 'Test fight',
    mechanics: { enemies_roster: [{ actor_id: 'Goblins', type: 'group', count: 2 }, { actor_id: 'Ogre', type: 'individual', count: 1 }] },
    rounds: [1, 2, 3].map(n => ({ n,
      slots: [
        { s: 1, a: ALDRIC, activities: [act('action', 'Attack', [hit(8)], { detail: 'Longsword' })] },
        { s: 2, a: SABLE, activities: [act('action', 'Attack', [hit(11)], { detail: 'Shortsword' })] },
      ],
      enemy_turns: [{ actor_id: 'Goblins', activities: [act('action', 'Attack', [hit(4, ALDRIC)])] }],
    })),
  };
}
const of = (flags, check) => flags.filter(f => f.check === check);

// ── S-0 ─────────────────────────────────────────────────────────────────────
console.log('\nTest S-0 — a clean combat raises nothing');
{
  assert('S-0: the clean three-round fight has no flags', CI.roundChecks(combat(), fxCtx()).length === 0);
  assert('S-0: the nine checks are listed', CI.SANITY_CHECKS.length === 9);
}

console.log('\nTest S-1 — imbalance');
{
  const c = combat();
  c.rounds[1].slots = [{ s: 1, a: ALDRIC, activities: [act('action', 'Attack', [hit(8)]), act('action', 'Attack', [hit(6)])] }];
  const f = CI.imbalance(c, fxCtx());
  assert('S-1: Aldric with two actions and Sable with none in round 2 is flagged', f.length === 1 && f[0].cell.round === 2 && f[0].cell.s === 1);
  assert('S-1: it suggests moving one to Sable', f[0].suggestedMove?.to === SABLE);
  assert('S-1: two actions with nobody missing is not an imbalance', CI.imbalance((() => { const x = combat(); x.rounds[0].slots[0].activities.push(act('action', 'Attack', [hit(2)])); return x; })(), fxCtx()).length === 0);
}

console.log('\nTest S-2 — source line');
{
  const c = combat();
  c.rounds[0].slots[1].source_line = 'Aldric - Longsword hit 8';
  const f = CI.sourceLine(c, fxCtx());
  assert('S-2: a line naming Aldric in Sable\'s row is flagged', f.length === 1 && f[0].cell.s === 2 && f[0].suggestedMove?.to === ALDRIC);
  const ok = combat();
  ok.rounds[0].slots[1].source_line = 'Sable - Shortsword hit 11';
  ok.rounds[0].slots[0].source_line = 'Ald - hit (8)'; // short form, start of one PC's name
  assert('S-2: a line naming the row\'s own PC (or its short form) is not', CI.sourceLine(ok, fxCtx()).length === 0);
}

console.log('\nTest S-3 — ability ownership');
{
  const c = combat();
  c.rounds[0].slots[0].activities = [act('action', 'Magic', [hit(5)], { detail: 'Mage Hand' })];
  const f = CI.abilityOwnership(c, fxCtx());
  assert('S-3: Mage Hand in Aldric\'s row (only Sable has it) is flagged, suggesting Sable', f.length === 1 && f[0].suggestedMove?.to === SABLE);
  const ok = combat();
  ok.rounds[0].slots[0].activities.push(act('bonus_action', 'Second Wind'));
  assert('S-3: an ability on the PC\'s own list is not', CI.abilityOwnership(ok, fxCtx()).length === 0);
  assert('S-3: a standard action with a weapon is never checked', CI.abilityOwnership(combat(), fxCtx()).length === 0);
}

console.log('\nTest S-4 — action economy');
{
  const c = combat();
  c.rounds[0].slots[0].activities.push(act('action', 'Attack', [hit(3)]));
  c.rounds[1].slots[1].activities.push(act('action', 'Cunning Action'));
  c.rounds[2].enemy_turns[0].activities.push(act('action', 'Attack', [hit(1)]), act('action', 'Attack', [hit(1)]));
  const f = CI.actionEconomy(c, fxCtx());
  assert('S-4: two actions without Action Surge is flagged', f.some(x => /takes 2 actions/.test(x.message) && x.cell.round === 1));
  assert('S-4: Cunning Action recorded as an action is flagged (it uses the bonus action)', f.some(x => /Cunning Action is recorded as action but uses the bonus_action/.test(x.message)));
  assert('S-4: a group with more actions than its starting count is flagged', f.some(x => /Goblins takes 3 actions but started with 2/.test(x.message)));
  const surge = { characters: fxAbilities.characters.map(ch => ch.pc_id === 'pc_001' ? Object.assign({}, ch, { actions: ch.actions.concat('Action Surge') }) : ch) };
  const c2 = combat();
  c2.rounds[0].slots[0].activities.push(act('action', 'Attack', [hit(3)]));
  assert('S-4: two actions with Action Surge on the sheet is not', CI.actionEconomy(c2, { abilities: CI.abilityContext(fixture, surge), names: CI.partyNames(fixture) }).length === 0);
}

console.log('\nTest S-5 — outcome count');
{
  const c = combat();
  c.rounds[0].slots[0].activities = [act('action', 'Attack', [hit(8), hit(6)], { detail: '3 Melee Attacks' })];
  c.rounds[1].slots[1].activities.push(act('bonus_action', 'Flurry of Blows', [hit(3)]));
  const f = CI.outcomeCount(c, fxCtx());
  assert('S-5: "3 Melee Attacks" with two outcomes is flagged', f.some(x => x.cell.round === 1 && /states 3 attacks but 2 are recorded/.test(x.message)));
  assert('S-5: a Flurry of Blows with one strike is flagged', f.some(x => x.cell.round === 2 && /Flurry of Blows has 1 strike/.test(x.message)));
  const ok = combat();
  ok.rounds[0].slots[0].activities = [act('action', 'Attack', [hit(8), hit(6)], { detail: 'Unarmed (x2)' })];
  assert('S-5: "(x2)" with two outcomes is not', CI.outcomeCount(ok, fxCtx()).length === 0);
}

console.log('\nTest S-6 — state');
{
  // The goblins down Aldric in round 1: from round 2 he may only make death saves.
  const c = combat();
  c.rounds[0].enemy_turns[0].activities = [act('action', 'Attack', [hit(9, ALDRIC, { effect: 'downed' })])];
  const f = CI.state(c, fxCtx());
  assert('S-6: Aldric attacking in round 2 after an enemy downed him in round 1 is flagged', f.some(x => x.cell.round === 2 && x.cell.s === 1));
  assert('S-6: …but not in round 1 itself (enemy effects happen sometime in the round)', !f.some(x => x.cell.round === 1));
  const healed = clone(c);
  healed.rounds[1].slots[1].activities.push(act('action', 'Magic', [hit(5, ALDRIC)], { detail: 'Cure Wounds', val_type: 'healing' }));
  healed.rounds[1].slots.reverse().forEach((sl, i) => { sl.s = i + 1; }); // Sable now acts first, healing Aldric before his turn
  assert('S-6: a heal before his turn clears it', !CI.state(healed, fxCtx()).some(x => x.cell.round === 2));
  const saves = clone(c);
  saves.rounds[1].slots[0].activities = [act('action', 'Death Save', [{ res: 'success', val: null, target_id: null }])];
  saves.rounds[2].slots[0].activities = [act('action', 'No Action: Stable')];
  assert('S-6: death saves and No Action while downed are fine', CI.state(saves, fxCtx()).length === 0);
  const ogre = combat();
  ogre.rounds[0].slots[1].activities = [act('action', 'Attack', [hit(30, 'Ogre', { effect: 'killed' })])];
  ogre.rounds[0].enemy_turns.push({ actor_id: 'Ogre', activities: [act('action', 'Attack', [hit(10, ALDRIC)])] });
  ogre.rounds[1].enemy_turns.push({ actor_id: 'Ogre', activities: [act('action', 'Attack', [hit(10, ALDRIC)])] });
  const of6 = CI.state(ogre, fxCtx());
  assert('S-6: the Ogre acting in round 2 after being killed in round 1 is flagged, its round 1 turn is not',
    of6.some(x => x.cell.round === 2 && x.cell.actor_id === 'Ogre') && !of6.some(x => x.cell.round === 1));
  const ready = combat();
  ready.rounds[1].slots[1].activities.push(act('reaction', 'Attack', [hit(4)], { ready_ref: { round: 1, s: 2 } }));
  assert('S-6: a released readied action with no Ready is flagged', CI.state(ready, fxCtx()).some(x => /no Ready is recorded/.test(x.message)));
  const late = combat();
  assert('S-6: acting before joining (order says from round 2) is flagged',
    CI.state(late, Object.assign(fxCtx(), { order: [{ s: 1, a: ALDRIC, from: 2 }, { s: 2, a: SABLE }] })).some(x => x.cell.round === 1 && /before joining/.test(x.message)));
}

console.log('\nTest S-7 — round order');
{
  const c = combat();
  c.rounds[2].slots[0].note_order = 2;
  c.rounds[2].slots[1].note_order = 1;
  const f = CI.roundOrder(c, fxCtx());
  assert('S-7: notes listing slot 2 before slot 1 is flagged', f.length === 1 && f[0].cell.round === 3);
  const ok = combat();
  ok.rounds[2].slots[0].note_order = 1; ok.rounds[2].slots[1].note_order = 2;
  assert('S-7: notes in initiative order are not', CI.roundOrder(ok, fxCtx()).length === 0);
}

console.log('\nTest S-8 — duplicates');
{
  const c = combat();
  c.rounds[0].slots[1].activities = [act('action', 'Attack', [hit(8)], { detail: 'Longsword' })];
  const f = CI.duplicates(c, fxCtx());
  assert('S-8: the same Attack · Longsword hit 8 in two rows of round 1 is flagged', f.length === 1 && f[0].cell.round === 1);
  const ok = combat();
  ok.rounds[0].slots.forEach(sl => { sl.activities = [act('action', 'Attack', [{ res: 'hit', val: null }])]; });
  assert('S-8: two hits with no value are not duplicates', CI.duplicates(ok, fxCtx()).length === 0);
}

console.log('\nTest S-9 — gaps');
{
  const c = combat();
  c.rounds[1].slots = c.rounds[1].slots.filter(sl => sl.a !== SABLE);
  const f = CI.gaps(c, fxCtx());
  assert('S-9: Sable with no turn in round 2 is flagged, worded as possibly fine', f.length === 1 && f[0].cell.round === 2 && /Fine if/.test(f[0].message));
  assert('S-9: someone outside the confirmed order\'s range is not', CI.gaps(c, Object.assign(fxCtx(), { order: [{ s: 1, a: ALDRIC }, { s: 2, a: SABLE, to: 1 }] })).length === 0);
}

// ── Acceptance on the real campaign ────────────────────────────────────────
const campaign = read('data/magers-campaign.json');
const pcAbilities = read('data/pc-abilities.json');
const C = ChronicleIds.buildLegacyIndex(campaign);
const realCtx = () => ({ abilities: CI.abilityContext(campaign, pcAbilities), names: CI.partyNames(campaign) });

console.log('\nTest S-10 — Att\'s Cure Wounds in Goli\'s row');
{
  const cbt = clone(campaign.combat_encounters.find(c => c.id === C.get('cbt_005')));
  const r2 = cbt.rounds.find(r => r.n === 2);
  const att = r2.slots.find(sl => sl.a === C.get('pc_006'));
  const goli = r2.slots.find(sl => sl.a === C.get('pc_005'));
  // The misread: Att's line and action land in Goli's row; Att's row is empty.
  goli.activities = att.activities;
  goli.source_line = 'Att - Cure Wounds (5) on Del';
  att.activities = [];
  const f = CI.roundChecks(cbt, realCtx()).filter(x => x.cell.round === 2 && x.cell.s === goli.s);
  const own = f.find(x => x.check === 'ability-ownership');
  const src = f.find(x => x.check === 'source-line');
  assert('S-10: ability ownership flags Cure Wounds in Goli\'s row', own && /Cure Wounds is not on Goli/.test(own.message));
  assert('S-10: source line flags the line naming Att', src && /names Att/.test(src.message));
  assert('S-10: both suggest moving it to Att', own.suggestedMove?.to === C.get('pc_006') && src.suggestedMove?.to === C.get('pc_006'));
  assert('S-10: the source-line suggestion reads "Move to Att"', src.suggestedMove.label === 'Move to Att');
}

console.log('\nTest S-11 — cbt_002 round 4 outcome count');
{
  const cbt = campaign.combat_encounters.find(c => c.id === C.get('cbt_002'));
  const f = CI.outcomeCount(cbt, realCtx());
  assert('S-11: Goli\'s "3 Melee Attacks" with two recorded raises an outcome-count flag',
    f.some(x => x.cell.round === 4 && x.cell.s === 6 && /3 Melee Attacks states 3 attacks but 2 are recorded/.test(x.message)));
}

console.log('\nTest S-12 — no check blocks publish');
{
  const all = campaign.combat_encounters.flatMap(c => CI.roundChecks(c, realCtx()));
  assert('S-12: flags carry no blocking field', all.length > 0 && all.every(f => !('block' in f) && !('sev' in f)));
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'chronicle-publish.js'), 'utf8') +
              fs.readFileSync(path.join(__dirname, '..', 'shared', 'chronicle-store.js'), 'utf8');
  assert('S-12: publish and the store never call the sanity checks', !/roundChecks|ChronicleIntegrity/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
