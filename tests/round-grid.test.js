/**
 * tests/round-grid.test.js — session page step 4: the round grid (issue #103)
 *
 * Tests shared/chronicle-grid.js: split assignment, building the grid from
 * #101's merged facts, the initiative order, every direct move, the three
 * session 6 misreads, #104's flags placed on cells with their one-click
 * fix, and the turn-schema output publish (#106) will write.
 *   G-1  building: party rows and enemy rows, targets resolved, held-back turns
 *   G-2  pass 1: proposed order (recorded order kept), join/leave, overrides
 *   G-3  pass 2 moves: turns (swap), activities (with source line), outcomes,
 *        economy, add/edit/remove
 *   G-4  the gate's session 6 misreads, fixed by direct moves alone
 *   G-5  flags on cells: Cure Wounds in Goli's row → "Move to Att" → no flags
 *   G-6  split assignment: AI proposal, bulk by spelling/page, unassigned held
 *   G-7  output: slot numbers follow the order, roster groups to add, events
 *   G-8  self-check notes beside their cells; re-extracting one round
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The phase 5 gate (part of #17) is that every misalignment found on a real
 * session is fixed with direct moves alone. Each move is a function here, so
 * these tests show each one doing exactly its job and nothing else.
 *
 * No test loads the page or calls the AI.
 *
 * RUN
 * ---
 * node tests/round-grid.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// chronicle-integrity.js attaches to window, as in a browser; the other
// modules then see window as their root, so it needs the Web Crypto API
// that chronicle-ids.js mints UUIDs with.
global.window = { crypto: globalThis.crypto };
require('../shared/chronicle-integrity.js');
const CI = window.ChronicleIntegrity;
const ChronicleIds = require('../shared/chronicle-ids.js');
const E  = require('../shared/chronicle-entities.js');
const F  = require('../shared/chronicle-facts.js');
const G  = require('../shared/chronicle-grid.js');

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
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };

const read = rel => JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
const campaign = read('data/magers-campaign.json');
const pcAbilities = read('data/pc-abilities.json');
const C = ChronicleIds.buildLegacyIndex(campaign);
const AMBUSH = C.get('cbt_005');
const PC = { gold: C.get('pc_001'), mal: C.get('pc_002'), ash: C.get('pc_003'), asp: C.get('pc_004'), goli: C.get('pc_005'), att: C.get('pc_006') };
const index = E.buildIndex(campaign);

// Step 3 for two pages, as the DM settled session 6.
const m = (kind, as_written, extra) => Object.assign({ kind, as_written }, extra);
const rows = E.buildRows([
  { page: 1, mentions: [
    m('pc', 'Asp', { candidate_id: PC.asp }), m('pc', 'Mal'), m('pc', 'Att', { candidate_id: PC.att }),
    m('pc', 'Goli'), m('pc', 'Ash'), m('pc', 'Gold', { candidate_id: PC.gold }),
    m('creature', 'Goblins'), m('creature', 'dragon'),
  ] },
  { page: 2, mentions: [m('pc', 'Asp', { candidate_id: PC.asp }), m('creature', 'Goblins'), m('creature', 'Dragons')] },
], index);
E.bulkAcknowledgeExact(rows);
for (const r of rows) if (r.status === 'pending' && r.matchType === 'inexact') E.acknowledge(r);
const dragonRow = rows.find(r => r.asWritten === 'dragon');
E.acknowledge(dragonRow, 'Larkspur Dragon');
E.linkToExisting(rows.find(r => r.asWritten === 'Dragons'), dragonRow.resolution.entityId, index, rows);
const DRAGON = dragonRow.resolution.entityId;
const refs = F.pageReferences(1, rows, index).concat(F.pageReferences(2, rows, index));
const occ = (page, words) => refs.find(r => String(r.occ).startsWith('occ_' + page + '_') && r.asWritten === words).occ;

// #101's merged facts for the two pages, with session 6's three misreads.
const act = (economy, name, outcomes, extra) => Object.assign({ economy, name, outcomes: outcomes || [] }, extra);
const out = (res, val, target, extra) => Object.assign({ res, val, target: target || null }, extra);
function mergedFacts() {
  return { combat: AMBUSH, rounds: [
    { n: 4, pages: [1], turns: [
        { actor: occ(1, 'Asp'), page: 1, source_line: 'ASP - Iteraling Hinds', activities: [act('action', 'Magic', [out('unclear', null)], { detail: 'Iteraling Hinds' })] },
        { actor: occ(1, 'Mal'), page: 1, source_line: 'Mal - Hit (Dead)', activities: [act('action', 'Attack', [out('hit', null, occ(1, 'Goblins'), { effect: 'killed' })])] },
        { actor: occ(1, 'Att'), page: 1, source_line: 'Att - Acid Splash 1 save 1 fail', activities: [act('action', 'Magic', [out('save', null), out('failure', null)], { detail: 'Acid Splash' })] },
        { actor: occ(1, 'Goli'), page: 1, source_line: 'Goli - 2 Att miss/Hit 8', activities: [act('action', 'Attack', [out('miss', null), out('hit', 8)], { detail: '2 Att' })] },
        { actor: occ(1, 'Ash'), page: 1, source_line: 'Ash - WB (dragon) 14', activities: [act('action', 'Magic', [out('hit', 14, occ(1, 'dragon'))], { detail: 'Witch Bolt' })] },
        { actor: occ(1, 'Gold'), page: 1, source_line: 'Gold - TS Crit (9)', activities: [act('action', 'Magic', [out('crit', 9)], { detail: 'True Strike' })] } ],
      enemy_turns: [{ actor: occ(1, 'Goblins'), page: 1, source_line: 'Goblins - Hit Mal (opportunity)', activities: [act('reaction', 'Opportunity Attack', [out('hit', null)])], special_events: [] }],
      events: ['Larkspur dragons descend on cart from ridges.'] },
    { n: 6, pages: [2], turns: [
        { actor: occ(2, 'Asp'), page: 2, source_line: 'Asp - Death ✓', activities: [act('action', 'Death Save', [out('success', null)])] } ],
      enemy_turns: [{ actor: occ(2, 'Dragons'), page: 2, source_line: '#2 Dragon - Not 1, MISS on Mal', activities: [act('action', 'Attack', [out('miss', null, null, { notes: 'Not 1' })])], special_events: [] }],
      events: ['Hit - Dragon, Dragon, Oregon'] },
  ] };
}
const recordedOrder = (() => {
  const c = campaign.combat_encounters.find(x => x.id === AMBUSH);
  const last = c.rounds.slice().sort((a, b) => b.n - a.n)[0];
  return last.slots.slice().sort((a, b) => a.s - b.s).map(s => s.a);
})();
const nameOf = id => index.entities.get(id)?.name || (id === DRAGON ? 'Larkspur Dragon' : id);
const isParty = id => campaign.party.some(p => p.id === id);
const ctxFor = assignments => ({ refs, assignments: assignments || new Map(), isParty, nameOf, name: 'Goblin Ambush', recordedOrder,
  rosterLabels: new Set(campaign.combat_encounters.find(x => x.id === AMBUSH).mechanics.enemies_roster.map(g => g.actor_id)) });
const build = () => G.buildGrid(mergedFacts(), ctxFor());
const R = (g, n) => g.rounds.find(r => r.n === n);

// ── G-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-1 — building the grid');
{
  const g = build();
  assert('G-1: six party rows, one per PC', g.rows.length === 6 && g.rows.every(r => isParty(r.key)));
  assert('G-1: enemy rows: the ambush\'s Goblins group and the new dragon',
    g.enemyRows.map(e => e.key).sort().join() === ['Goblins', 'Larkspur Dragon'].sort().join() && g.enemyRows.find(e => e.key === 'Larkspur Dragon').isNew && !g.enemyRows.find(e => e.key === 'Goblins').isNew);
  const mal = R(g, 4).cells[PC.mal].activities[0].outcomes[0];
  assert('G-1: a target occurrence of a roster group becomes its actor_id', mal.target_id === 'Goblins' && mal.effect === 'killed');
  assert('G-1: a target that is an entity becomes its id', R(g, 4).cells[PC.ash].activities[0].outcomes[0].target_id === DRAGON);
  assert('G-1: each cell keeps its source line and the order the notes listed it', R(g, 4).cells[PC.goli].source_lines[0].text === 'Goli - 2 Att miss/Hit 8' && R(g, 4).cells[PC.goli].noteOrder === 4);
  assert('G-1: events are kept on their round', R(g, 6).events[0].text === 'Hit - Dragon, Dragon, Oregon');
  assert('G-1: nothing held back', g.held.length === 0);
}

// ── G-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-2 — pass 1: the initiative order');
{
  const g = build();
  assert('G-2: the proposed order is the ambush\'s recorded slot order', g.rows.map(r => r.key).join() === recordedOrder.join());
  // A fresh combat with no recorded order follows the notes' first round.
  const fresh = G.buildGrid(Object.assign(mergedFacts(), { combat: 'new: Test' }), Object.assign(ctxFor(), { recordedOrder: null }));
  assert('G-2: without a recorded order, the notes\' order of the first round', fresh.rows.map(r => r.key).join() === [PC.asp, PC.mal, PC.att, PC.goli, PC.ash, PC.gold].join());
  // #117: a new combat is created under a name the DM can change; a page that
  // starts mid-fight gives "new: Round 10", which must not be the only option.
  assert('G-2: a new combat starts with the name the notes gave it', fresh.newName === 'Test');
  assert('G-2: a recorded combat has no new-combat name', g.newName === undefined);
  G.renameNewCombat(fresh, '  Axe Beak & Vespon Ambush ');
  assert('G-2: the DM can rename a new combat (trimmed)', fresh.newName === 'Axe Beak & Vespon Ambush');
  assert('G-2: a blank name is refused and the old one kept', throws(() => G.renameNewCombat(fresh, '   ')) && fresh.newName === 'Axe Beak & Vespon Ambush');
  assert('G-2: a recorded combat cannot be renamed here', throws(() => G.renameNewCombat(g, 'Something Else')));
  const kept = G.buildGrid(Object.assign(mergedFacts(), { combat: 'new: Round 10' }), Object.assign(ctxFor(), { recordedOrder: null, newName: 'Axe Beak & Vespon Ambush' }));
  assert('G-2: a name the DM typed survives a grid rebuild', kept.newName === 'Axe Beak & Vespon Ambush');
  G.moveRow(g, 0, 2);
  assert('G-2: dragging a row changes every round\'s slot numbers',
    G.toTurnSchema(g).rounds.find(r => r.n === 4).slots.find(s => s.a === recordedOrder[0]).s === 3);
  G.setJoinLeave(g, PC.gold, 5, null);
  assert('G-2: join round is set', g.rows.find(r => r.key === PC.gold).from === 5);
  assert('G-2: an unknown row is refused', throws(() => G.setJoinLeave(g, 'nobody', 1, 2)));
  const flags = CI.state(G.checkCombat(g, []), { names: CI.partyNames(campaign), order: G.checkOrder(g) });
  assert('G-2: acting before the join round is then flagged by #104', flags.some(f => f.cell.round === 4 && /before joining/.test(f.message)));
  G.setOverride(g, 4, [PC.gold, PC.asp, PC.mal, PC.att, PC.goli, PC.ash]);
  assert('G-2: a round override (surprise round) numbers that round only',
    G.toTurnSchema(g).rounds.find(r => r.n === 4).slots.find(s => s.a === PC.gold).s === 1 && G.orderFor(g, 6)[0] !== PC.gold);
}

// ── G-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-3 — pass 2: direct moves');
{
  const g = build();
  G.moveTurn(g, { round: 4, row: PC.goli }, { round: 4, row: PC.ash });
  assert('G-3: dragging a turn onto another swaps them',
    R(g, 4).cells[PC.ash].source_lines[0].text.startsWith('Goli') && R(g, 4).cells[PC.goli].source_lines[0].text.startsWith('Ash'));
  G.moveTurn(g, { round: 4, row: PC.goli }, { round: 4, row: PC.ash });
  G.moveTurn(g, { round: 6, row: PC.asp }, { round: 6, row: PC.mal });
  assert('G-3: moving a turn to an empty cell leaves no empty cell behind', R(g, 6).cells[PC.mal] && !R(g, 6).cells[PC.asp]);
  G.moveActivity(g, { round: 4, row: PC.gold, ai: 0 }, { round: 4, row: PC.att });
  assert('G-3: moving one activity takes its source line with it',
    R(g, 4).cells[PC.att].activities.length === 2 && R(g, 4).cells[PC.att].source_lines.some(l => l.text.startsWith('Gold')) && !R(g, 4).cells[PC.gold]);
  G.moveOutcome(g, { round: 4, row: PC.goli, ai: 0, oi: 1 }, { round: 4, row: PC.mal, ai: 0 });
  assert('G-3: moving one outcome', R(g, 4).cells[PC.goli].activities[0].outcomes.length === 1 && R(g, 4).cells[PC.mal].activities[0].outcomes.length === 2);
  G.setEconomy(g, { round: 4, enemy: 'Goblins', ai: 0 }, 'action');
  assert('G-3: changing an activity\'s economy', R(g, 4).enemy.Goblins.activities[0].economy === 'action');
  const ai = G.addActivity(g, { round: 4, row: PC.mal }, { economy: 'bonus_action', name: 'Rage' });
  G.addOutcome(g, { round: 4, row: PC.mal, ai: 0 }, { res: 'hit', val: 5, target_id: 'Goblins' });
  assert('G-3: adding an activity and an outcome', R(g, 4).cells[PC.mal].activities[ai].name === 'Rage' && R(g, 4).cells[PC.mal].activities[0].outcomes.length === 3);
  G.removeActivity(g, { round: 4, row: PC.mal, ai });
  G.removeOutcome(g, { round: 4, row: PC.mal, ai: 0, oi: 2 });
  assert('G-3: removing them again', R(g, 4).cells[PC.mal].activities.length === 1 && R(g, 4).cells[PC.mal].activities[0].outcomes.length === 2);
  G.moveActivity(g, { round: 4, enemy: 'Goblins', ai: 0 }, { round: 4, row: PC.mal }, { interrupted: 'Goblins' });
  assert('G-3: a reaction moved to the reactor\'s row keeps a note of the turn it interrupted',
    /Interrupted Goblins's turn/.test(R(g, 4).cells[PC.mal].activities[1].notes || ''));
  assert('G-3: moving an outcome onto no activity is refused', throws(() => G.moveOutcome(g, { round: 4, row: PC.mal, ai: 0, oi: 0 }, { round: 4, row: PC.gold, ai: 0 })));
}

// ── G-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-4 — session 6\'s three misreads, fixed by direct moves alone (gate)');
{
  const g = build();
  // 1. "Iteraling Hinds" → Healing Hands, edited in place.
  G.editActivity(g, { round: 4, row: PC.asp, ai: 0 }, { detail: 'Healing Hands' });
  G.editOutcome(g, { round: 4, row: PC.asp, ai: 0, oi: 0 }, { res: 'success' });
  assert('G-4: "Iteraling Hinds" is now Magic · Healing Hands', R(g, 4).cells[PC.asp].activities[0].detail === 'Healing Hands' && R(g, 4).cells[PC.asp].activities[0].outcomes[0].res === 'success');
  // 2. "Hit - Dragon, Dragon, Oregon" → the goblins' three attacks on the dragon.
  G.eventToActivity(g, 6, 0, { enemy: 'Goblins', economy: 'action', name: 'Attack', res: 'hit',
    targets: [{ target_id: DRAGON }, { target_id: DRAGON }, { target_id: DRAGON }] });
  const gob = R(g, 6).enemy.Goblins;
  assert('G-4: the event became one Attack with three outcomes on the dragon', gob.activities[0].outcomes.length === 3 && gob.activities[0].outcomes.every(o => o.target_id === DRAGON));
  assert('G-4: …keeping the event\'s text as its source line, and the event is gone', gob.source_lines[0].text === 'Hit - Dragon, Dragon, Oregon' && R(g, 6).events.length === 0);
  // 3. "Not 1" → "Nat 1" on the dragon's miss.
  G.editOutcome(g, { round: 6, enemy: 'Larkspur Dragon', ai: 0, oi: 0 }, { notes: 'Nat 1', target_id: PC.mal });
  const miss = R(g, 6).enemy['Larkspur Dragon'].activities[0].outcomes[0];
  assert('G-4: "Not 1" is now "Nat 1", targeting Mal', miss.notes === 'Nat 1' && miss.target_id === PC.mal);
  const t = G.toTurnSchema(g, 'session_006');
  const ok = t.rounds.every(r => r.slots.every(s => s.activities.every(a => F.ENUMS.economy.includes(a.economy))) && r.enemy_turns.every(e => typeof e.actor_id === 'string'));
  assert('G-4: the corrected grid is valid turn-schema rounds', ok && t.rounds.find(r => r.n === 6).enemy_turns.some(e => e.actor_id === 'Goblins' && e.activities[0].outcomes.length === 3));
  assert('G-4: no event, editor or move needed the AI (all are local functions)', typeof G.eventToActivity === 'function' && !/fetch\(|ChronicleAI/.test(fs.readFileSync(path.join(__dirname, '..', 'shared', 'chronicle-grid.js'), 'utf8')));
}

// ── G-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-5 — #104 flags on cells, and the one-click move');
{
  const g = build();
  // The misread: Att's Cure Wounds lands in Goli's row (and Goli's own turn in Att's).
  R(g, 4).cells[PC.goli] = { activities: [{ economy: 'action', name: 'Magic', detail: 'Cure Wounds', val_type: 'healing', outcomes: [{ res: 'hit', val: 5, target_id: PC.asp }] }],
    source_lines: [{ text: 'Att - Cure Wounds (5) on Asp', page: 1 }], notes: [], aiNotes: [], noteOrder: 3, special_events: [] };
  delete R(g, 4).cells[PC.att];
  const ctx = { abilities: CI.abilityContext(campaign, pcAbilities), names: CI.partyNames(campaign), order: G.checkOrder(g) };
  const roster = campaign.combat_encounters.find(x => x.id === AMBUSH).mechanics.enemies_roster;
  const flags = G.mapFlags(g, CI.roundChecks(G.checkCombat(g, roster), ctx));
  const onGoli = flags.filter(f => f.at && f.at.round === 4 && f.at.row === PC.goli);
  assert('G-5: ability-ownership and source-line flags land on Goli\'s round 4 cell',
    onGoli.some(f => f.check === 'ability-ownership') && onGoli.some(f => f.check === 'source-line'));
  const src = onGoli.find(f => f.check === 'source-line');
  assert('G-5: the source-line flag offers "Move to Att"', src.suggestedMove.label === 'Move to Att' && src.suggestedMove.to === PC.att);
  G.applySuggestedMove(g, src, src.suggestedMove.to);
  assert('G-5: one click moves the turn to Att\'s row', R(g, 4).cells[PC.att]?.activities[0].detail === 'Cure Wounds' && !R(g, 4).cells[PC.goli]);
  const after = G.mapFlags(g, CI.roundChecks(G.checkCombat(g, roster), Object.assign(ctx, { order: G.checkOrder(g) })))
    .filter(f => f.at && f.at.round === 4 && (f.at.row === PC.att || f.at.row === PC.goli) && (f.check === 'source-line' || f.check === 'ability-ownership'));
  assert('G-5: after the move, no source-line or ability flag remains on Att\'s or Goli\'s round 4 cell (Del\'s "Iteraling Hinds" still flags, rightly)' +(after.length ? ' — ' + after.map(f => f.message).join(' | ') : ''), after.length === 0);
}

// ── G-6 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-6 — split assignment');
{
  // Two PCs written "Gol" on one page: a Split into Goli and Gold.
  const sRows = E.buildRows([{ page: 1, mentions: [m('pc', 'Gol'), m('pc', 'Gol'), m('pc', 'Mal')] }, { page: 2, mentions: [m('pc', 'Gol')] }], index);
  E.bulkAcknowledgeExact(sRows);
  E.split(sRows.find(r => r.asWritten === 'Gol'), [{ linkId: PC.goli }, { linkId: PC.gold }], index);
  const sRefs = F.pageReferences(1, sRows, index).concat(F.pageReferences(2, sRows, index));
  const merged = { assignments: [{ occ: 'occ_1_1', choice: 'Derwin', reason: 'two attacks, a rogue' }, { occ: 'occ_1_2', choice: 'Zragar', reason: 'casts True Strike' }] };
  const list = G.splitAssignments(sRefs, merged);
  assert('G-6: every split occurrence is listed with its candidates', list.length === 3 && list.every(a => a.candidates.length === 2));
  assert('G-6: the AI\'s proposal and reason arrive pre-filled', list.find(a => a.occ === 'occ_1_1').assigned === PC.goli && list.find(a => a.occ === 'occ_1_2').reason === 'casts True Strike');
  assert('G-6: an occurrence the AI did not place starts unassigned', list.find(a => a.occ === 'occ_2_1').assigned === null);
  assert('G-6: bulk assign by page', G.assignWhere(list, { page: 2 }, PC.gold) === 1 && list.find(a => a.occ === 'occ_2_1').assigned === PC.gold);
  assert('G-6: bulk assign by spelling', G.assignWhere(list, { asWritten: 'gol' }, PC.goli) === 3 && list.every(a => a.assigned === PC.goli));
  assert('G-6: a choice outside the candidates is refused', G.assignWhere(list, { asWritten: 'Gol' }, PC.mal) === 0);
  list.find(a => a.occ === 'occ_1_2').assigned = null;
  const facts = { combat: AMBUSH, rounds: [{ n: 4, pages: [1], turns: [
    { actor: 'occ_1_1', page: 1, source_line: 'Gol - 2 Att', activities: [act('action', 'Attack', [out('hit', 6, 'occ_1_2')])] },
    { actor: 'occ_1_2', page: 1, source_line: 'Gol - TS (9)', activities: [act('action', 'Magic', [out('hit', 9)], { detail: 'True Strike' })] }], enemy_turns: [], events: [] }] };
  const assignments = new Map(list.map(a => [a.occ, a.assigned]));
  const g = G.buildGrid(facts, Object.assign(ctxFor(assignments), { refs: sRefs }));
  assert('G-6: an assigned occurrence\'s turn goes to that PC\'s row', R(g, 4).cells[PC.goli]?.activities.length === 1);
  assert('G-6: an unassigned actor\'s turn is held back, not guessed', g.held.length === 1 && g.held[0].source_line === 'Gol - TS (9)' && !R(g, 4).cells[PC.gold]);
  assert('G-6: an unassigned target stays as text, marked', /not yet assigned/.test(R(g, 4).cells[PC.goli].activities[0].outcomes[0].target_text));
  assert('G-6: the held-back turn is reported by the output, not published', G.toTurnSchema(g).held.length === 1 && G.toTurnSchema(g).rounds[0].slots.length === 1);
}

// ── G-7 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-7 — output for the checks and publish');
{
  const g = build();
  const t = G.toTurnSchema(g, 'session_006');
  const r4 = t.rounds.find(r => r.n === 4);
  assert('G-7: slot numbers are positions in the confirmed order', r4.slots.every(s => s.s === recordedOrder.indexOf(s.a) + 1));
  assert('G-7: each round carries the session as sid', t.rounds.every(r => r.sid === 'session_006'));
  assert('G-7: working fields for the checks are present (source_line, note_order)', r4.slots.every(s => s.source_line && Number.isFinite(s.note_order)));
  assert('G-7: the new creature becomes a roster group to add, pointing at its bestiary entry',
    t.rosterAdds.length === 1 && t.rosterAdds[0].actor_id === 'Larkspur Dragon' && t.rosterAdds[0].mon_ref === DRAGON);
  assert('G-7: events that were not converted are reported', t.events.length === 2);
  assert('G-7: the grid itself is not changed by the output', R(g, 4).cells[PC.asp].activities[0].detail === 'Iteraling Hinds');
  assert('G-7: the grid\'s working fields (an activity\'s source line) are not output',
    t.rounds.every(r => r.slots.concat(r.enemy_turns).every(x => x.activities.every(a => !('source_line' in a) && !('source_page' in a)))));
  const empty = build();
  R(empty, 4).enemy.Goblins.activities = [];
  assert('G-7: an enemy group with nothing in its cell is not written as an empty turn',
    !G.toTurnSchema(empty).rounds.find(r => r.n === 4).enemy_turns.some(e => e.actor_id === 'Goblins'));
  // Moving one of two activities takes that activity's own line, not the cell's first.
  const two = build();
  G.moveActivity(two, { round: 4, row: PC.gold, ai: 0 }, { round: 4, row: PC.att });
  G.moveActivity(two, { round: 4, row: PC.att, ai: 1 }, { round: 4, row: PC.goli });
  assert('G-7: a moved activity carries its own source line',
    R(two, 4).cells[PC.goli].source_lines.some(l => l.text.startsWith('Gold')) && !R(two, 4).cells[PC.att].source_lines.some(l => l.text.startsWith('Gold')));
}

// ── G-8 ─────────────────────────────────────────────────────────────────────
console.log('\nTest G-8 — self-check notes and re-extracting a round');
{
  const g = build();
  const loose = G.attachSelfCheck(g, [
    `Round 4: 'Iteraling Hinds' on Asp's line (${occ(1, 'Asp')}) could not be resolved to a known action or spell.`,
    'Round 6: the line \'Hit - Dragon, Dragon, Oregon\' has been recorded as an event.',
    'The note \'Lance Out Work, Played by David\' is a meta-note.',
  ], refs);
  assert('G-8: a note naming a round and an occurrence sits beside that cell', R(g, 4).cells[PC.asp].aiNotes.length === 1);
  assert('G-8: a note naming only a round sits on the round', R(g, 6).aiNotes.length === 1);
  assert('G-8: a note naming neither is returned for the general list', loose.length === 1);
  G.editActivity(g, { round: 6, row: PC.asp, ai: 0 }, { notes: 'kept' });
  G.moveRow(g, 0, 1);
  const again = { combat: AMBUSH, rounds: [{ n: 4, pages: [1], turns: [
    { actor: occ(1, 'Asp'), page: 1, source_line: 'ASP - Healing Hands', activities: [act('action', 'Magic', [out('success', null)], { detail: 'Healing Hands' })] }], enemy_turns: [], events: [] }] };
  const orderBefore = g.rows.map(r => r.key).join();
  G.replaceRound(g, 4, again, ctxFor());
  assert('G-8: re-extracting round 4 replaces only round 4', R(g, 4).cells[PC.asp].activities[0].detail === 'Healing Hands' && Object.keys(R(g, 4).cells).length === 1);
  assert('G-8: …the order and other rounds\' edits stay', g.rows.map(r => r.key).join() === orderBefore && R(g, 6).cells[PC.asp].activities[0].notes === 'kept');
  assert('G-8: a reply without that round is refused', throws(() => G.replaceRound(g, 9, again, ctxFor())));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
