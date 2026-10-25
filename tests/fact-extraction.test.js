/**
 * tests/fact-extraction.test.js — session page step 4 facts (issue #101)
 *
 * Tests shared/chronicle-facts.js: the per-page facts prompt, the reply
 * check, the imbalance and action-economy self-checks, and the merge of
 * rounds across page breaks.
 *   F-1  pageReferences: each occurrence with what step 3 settled it as
 *   F-2  combatChoices: open combats with their last recorded round
 *   F-3  the prompt: occurrences, combats, carry-forward, no slot roster
 *   F-4  parseFacts and validateFacts — the gate's "no fact refers to an
 *        entity by name instead of by occurrence"
 *   F-5  checkFacts: action economy and imbalance
 *   F-6  mergePages: a combat across a page break is one combat (the gate),
 *        a round split across pages merges, a round reset is flagged
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The phase 4 gate is that a combat crossing a page break comes out as one
 * combat and no fact names an entity instead of an occurrence. Both rules
 * are code here, so these tests pin them down without calling the AI. The
 * replies are written by hand in the shape factsPrompt asks for, modelled on
 * the DM's two session 6 pages (Goblin Ambush rounds 4–7).
 *
 * No test calls the AI or loads the page.
 *
 * RUN
 * ---
 * node tests/fact-extraction.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds = require('../shared/chronicle-ids.js');
const E            = require('../shared/chronicle-entities.js');
const F            = require('../shared/chronicle-facts.js');

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

const campaign = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'magers-campaign.json'), 'utf8'));
const C = ChronicleIds.buildLegacyIndex(campaign);
const AMBUSH = C.get('cbt_005');
const index = E.buildIndex(campaign);

// Step 3 as the DM would leave it for two pages: Asp, Mal, Gold on both,
// the Goblins group, and a new Larkspur Dragon.
const m = (kind, as_written, extra) => Object.assign({ kind, as_written }, extra);
const rows = E.buildRows([
  { page: 1, mentions: [
    m('pc', 'Asp', { candidate_id: C.get('pc_004') }),   // occ_1_1
    m('pc', 'Mal'),                                       // occ_1_2
    m('pc', 'Gold', { candidate_id: C.get('pc_001') }),  // occ_1_3
    m('creature', 'Goblins'),                             // occ_1_4
    m('pc', 'Mal'),                                       // occ_1_5 (target of the goblins)
    m('creature', 'dragon'),                              // occ_1_6
  ] },
  { page: 2, mentions: [
    m('pc', 'Asp', { candidate_id: C.get('pc_004') }),   // occ_2_1
    m('pc', 'Mail', { candidate_id: C.get('pc_002') }),  // occ_2_2
    m('creature', 'Dragons'),                             // occ_2_3
  ] },
], index);
E.bulkAcknowledgeExact(rows);
for (const r of rows) if (r.matchType === 'inexact') E.acknowledge(r);
const dragonRow = rows.find(r => r.asWritten === 'dragon');
E.acknowledge(dragonRow, 'Larkspur Dragon');
E.linkToExisting(rows.find(r => r.asWritten === 'Dragons'), dragonRow.resolution.entityId, index, rows);

const refs1 = F.pageReferences(1, rows, index);
const refs2 = F.pageReferences(2, rows, index);
const combats = F.combatChoices(campaign, rows, index);

// Hand-written replies. page1: rounds 4 and 5; page2: round 5 continued, 6.
const act = (economy, name, outcomes, extra) => Object.assign({ economy, name, outcomes: outcomes || [] }, extra);
const out = (res, val, target, extra) => Object.assign({ res, val, target: target || null }, extra);
function page1() {
  return { combats: [{ combat: AMBUSH, rounds: [
    { n: 4, turns: [
        { actor: 'occ_1_1', source_line: 'Asp - Healing Hands', activities: [act('action', 'Magic', [out('unclear', null)], { detail: 'Healing Hands' })] },
        { actor: 'occ_1_2', source_line: 'Mal - Hit (Dead)', activities: [act('action', 'Attack', [out('hit', null, 'occ_1_4', { effect: 'killed' })])] },
        { actor: 'occ_1_3', source_line: 'Gold - TS Crit (9)', activities: [act('action', 'Magic', [out('crit', 9, 'occ_1_6')], { detail: 'True Strike' })] } ],
      enemy_turns: [{ actor: 'occ_1_4', source_line: 'Goblins - Hit Mal (opportunity)', activities: [act('reaction', 'Opportunity Attack', [out('hit', null, 'occ_1_5')])], special_events: [] }],
      events: ['Larkspur dragons descend on cart from ridges.'] },
    { n: 5, turns: [
        { actor: 'occ_1_1', source_line: 'Asp - Hit (7) Dead, Hit (5)', activities: [act('action', 'Attack', [out('hit', 7, 'occ_1_4', { effect: 'killed' }), out('hit', 5, 'occ_1_4')])] } ],
      enemy_turns: [], events: [] },
  ] }], quest_progress: [], loot: [], self_check: [] };
}
function page2() {
  return { combats: [{ combat: AMBUSH, rounds: [
    { n: 5, turns: [{ actor: 'occ_2_2', source_line: 'Mail - Sword Hit (13) dragon', activities: [act('action', 'Attack', [out('hit', 13, 'occ_2_3')], { detail: 'Sword' })] }], enemy_turns: [], events: [] },
    { n: 6, turns: [{ actor: 'occ_2_1', source_line: 'Asp - Death ✓', activities: [act('action', 'Death Save', [out('success', null)])] }], enemy_turns: [], events: [] },
  ] }], quest_progress: [], loot: [], self_check: [] };
}

// ── F-1 ─────────────────────────────────────────────────────────────────────
console.log('\nTest F-1 — page references');
{
  assert('F-1: page 1 lists its six occurrences, page 2 its three', refs1.length === 6 && refs2.length === 3);
  const asp = refs1.find(r => r.occ === 'occ_1_1');
  assert('F-1: Asp is shown as Asphodel, a player character', asp.entityId === C.get('pc_004') && /Asphodel \(player character\)/.test(asp.label) && !asp.group);
  const gob = refs1.find(r => r.occ === 'occ_1_4');
  assert('F-1: Goblins is the ambush\'s enemy group, a group', /enemy group "Goblins"/.test(gob.label) && gob.group);
  const drag = refs2.find(r => r.occ === 'occ_2_3');
  assert('F-1: "Dragons" (linked) is the new Larkspur Dragon', drag.entityId === dragonRow.resolution.entityId && /Larkspur Dragon/.test(drag.label));
  assert('F-1: "Mail" and "Mal" resolve to the same entity', refs2.find(r => r.occ === 'occ_2_2').entityId === refs1.find(r => r.occ === 'occ_1_2').entityId);
}

// ── F-2 ─────────────────────────────────────────────────────────────────────
console.log('\nTest F-2 — combats a page may continue');
{
  const amb = combats.find(c => c.ref === AMBUSH);
  assert('F-2: the paused Goblin Ambush is offered, open, recorded to round 3', amb && amb.open && amb.lastRound === 3);
  assert('F-2: finished combats nobody mentioned are not offered', !combats.some(c => c.ref === C.get('cbt_002')));
}

// ── F-3 ─────────────────────────────────────────────────────────────────────
console.log('\nTest F-3 — the prompt');
{
  const p = F.factsPrompt({ pageLabel: 'page 2 of 2', references: refs2, combats, carry: { combat: AMBUSH, round: 5 }, reread: null });
  assert('F-3: lists each occurrence with what it was confirmed as', p.includes('occ_2_2 | "Mail" = Malachite (player character)'));
  assert('F-3: lists the open combat with its last recorded round', p.includes(`${AMBUSH} | Goblin Ambush (open, recorded to round 3)`));
  assert('F-3: carries forward where the previous page stopped', p.includes(`The previous page ended in combat ${AMBUSH}, round 5.`));
  assert('F-3: forbids names in actor/target and slot assignment', /Never write a character's name in "actor" or "target"/.test(p) && /Do not assign initiative slots/.test(p));
  assert('F-3: no fixed slot-to-PC roster', !/slot 1:|slot 1 =|pc_001 =/.test(p));
  const again = F.factsPrompt({ pageLabel: 'page 1 of 2', references: refs1, combats, carry: null, reread: ['Gold has 2 actions in round 4'] });
  assert('F-3: a re-read lists the problems to fix', again.includes('A FIRST READ OF THIS PAGE HAD THESE PROBLEMS') && again.includes('Gold has 2 actions in round 4'));
}

// ── F-4 ─────────────────────────────────────────────────────────────────────
console.log('\nTest F-4 — parse and validate (gate: occurrences, never names)');
{
  const ok = F.parseFacts('```json\n' + JSON.stringify(page1()) + '\n```');
  assert('F-4: a fenced reply parses', ok.combats[0].rounds.length === 2);
  assert('F-4: a valid page has no errors', F.validateFacts(ok, refs1, combats).length === 0);
  const named = page1();
  named.combats[0].rounds[0].turns[2].actor = 'Gold';
  named.combats[0].rounds[0].turns[1].activities[0].outcomes[0].target = 'Goblins';
  const errs = F.validateFacts(named, refs1, combats);
  assert('F-4: an actor named instead of an occurrence is an error', errs.some(e => /Actor "Gold"/.test(e)));
  assert('F-4: a target named instead of an occurrence is an error', errs.some(e => /Target "Goblins"/.test(e)));
  const otherPage = page1();
  otherPage.combats[0].rounds[0].turns[0].actor = 'occ_2_1';
  assert('F-4: an occurrence from another page is an error', F.validateFacts(otherPage, refs1, combats).some(e => /occ_2_1/.test(e)));
  const textTarget = page1();
  textTarget.combats[0].rounds[0].turns[1].activities[0].outcomes[0] = out('hit', 4, null, { target_text: 'horse' });
  assert('F-4: a non-entity target in target_text is fine', F.validateFacts(textTarget, refs1, combats).length === 0);
  const bad = page1();
  bad.combats[0].combat = 'Goblin Ambush';
  bad.combats[0].rounds[0].turns[0].activities[0].economy = 'main';
  bad.combats[0].rounds[0].turns[1].activities[0].outcomes[0].res = 'dead';
  const be = F.validateFacts(bad, refs1, combats);
  assert('F-4: an unknown combat, economy or result is an error', be.some(e => /Combat "Goblin Ambush"/.test(e)) && be.some(e => /Economy "main"/.test(e)) && be.some(e => /Result "dead"/.test(e)));
  const fresh = page1();
  fresh.combats[0].combat = 'new: Dragon Fight';
  assert('F-4: "new: <name>" is accepted for a new combat', !F.validateFacts(fresh, refs1, combats).some(e => /Combat/.test(e)));
  assert('F-4: no JSON throws', throws(() => F.parseFacts('I could not read the page.')));
  assert('F-4: no combats list throws', throws(() => F.parseFacts('{"rounds":[]}')));
  assert('F-4: missing lists are filled in', F.parseFacts('{"combats":[{"combat":"x","rounds":[{"n":1}]}]}').combats[0].rounds[0].turns.length === 0);
}

// ── F-5 ─────────────────────────────────────────────────────────────────────
console.log('\nTest F-5 — imbalance and action-economy checks');
{
  assert('F-5: a clean page has no issues', F.checkFacts(page1(), refs1).length === 0);
  // Gold read twice in round 5 while Mal, who acts in round 4, has no turn.
  const f = page1();
  f.combats[0].rounds[1].turns.push(
    { actor: 'occ_1_3', source_line: 'Gold - True Strike Dragon (12)', activities: [act('action', 'Magic', [out('hit', 12, 'occ_1_6')])] },
    { actor: 'occ_1_3', source_line: 'Goli - 2 Att miss/Hit (9)', activities: [act('action', 'Attack', [out('miss', null), out('hit', 9)])] });
  const issues = F.checkFacts(f, refs1);
  assert('F-5: two actions in one round for one character is an economy issue', issues.some(x => x.type === 'economy' && /Gold has 2 actions in round 5/.test(x.detail)));
  assert('F-5: …and with Mal missing that round, an imbalance', issues.some(x => x.type === 'imbalance' && /Gold has two actions while Mal has no turn/.test(x.detail)));
  // A reaction recorded as a separate turn does not count as a second action.
  const r = page1();
  r.combats[0].rounds[0].turns.push({ actor: 'occ_1_3', source_line: 'Larkspur Drag - Attack Gold cast shield', activities: [act('reaction', 'Shield')] });
  assert('F-5: a reaction in another turn is not an economy issue', F.checkFacts(r, refs1).length === 0);
  // Groups take several actions.
  const g = page1();
  g.combats[0].rounds[0].enemy_turns[0].activities.push(act('action', 'Attack', [out('hit')]), act('action', 'Attack', [out('hit')]));
  assert('F-5: an enemy group with several actions is not flagged', F.checkFacts(g, refs1).length === 0);
}

// ── F-6 ─────────────────────────────────────────────────────────────────────
console.log('\nTest F-6 — merging pages (gate: one combat across a page break)');
{
  const merged = F.mergePages([{ page: 1, facts: page1() }, { page: 2, facts: page2() }], refs1.concat(refs2));
  assert('F-6: the Goblin Ambush across both pages is one combat', merged.combats.length === 1 && merged.combats[0].combat === AMBUSH);
  assert('F-6: rounds 4, 5 and 6, in order', merged.combats[0].rounds.map(r => r.n).join() === '4,5,6');
  const r5 = merged.combats[0].rounds.find(r => r.n === 5);
  assert('F-6: round 5, split across the page break, holds both pages\' turns in page order',
    r5.turns.length === 2 && r5.turns[0].page === 1 && r5.turns[1].page === 2 && r5.pages.join() === '1,2');
  assert('F-6: every turn keeps its source line', merged.combats[0].rounds.every(r => r.turns.every(t => t.source_line)));
  assert('F-6: no round-reset flag for a continuing combat', merged.issues.length === 0);
  // Round 1 after round 6 in the same combat: likely a new combat (#91).
  const reset = page2();
  reset.combats[0].rounds.push({ n: 1, turns: [], enemy_turns: [], events: [] });
  const m2 = F.mergePages([{ page: 1, facts: page1() }, { page: 2, facts: reset }], refs1.concat(refs2));
  assert('F-6: a round number going back down is flagged as a likely new combat', m2.issues.some(x => x.type === 'round-reset' && x.round === 1));
  const across = F.mergePages([{ page: 1, facts: page1() }, { page: 2, facts: (() => { const p = page2(); p.combats[0].rounds = [{ n: 2, turns: [], enemy_turns: [], events: [] }]; return p; })() }], []);
  assert('F-6: a lower round on a later page is flagged too', across.issues.some(x => /round 2 on page 2 comes after round 5/.test(x.detail)));
}

// ── P-1 – P-4: passages (#102) ──────────────────────────────────────────────
// A typed-notes page with an NPC conversation, a place description and a
// round moment. Built on its own rows so it has an NPC (Rufus), a place
// (Belfar) and a new piece of lore an NPC tells the party.
const ChroniclePublish = require('../shared/chronicle-publish.js');
const pRows = E.buildRows([{ page: 'notes', mentions: [
  m('npc', 'Rufus'),                                        // occ_notes_1
  m('place', 'Bel', { candidate_id: C.get('loc_006') }),    // occ_notes_2
  m('lore', 'the dragon pact'),                             // occ_notes_3
  m('pc', 'Mal'),                                           // occ_notes_4
] }], index);
E.bulkAcknowledgeExact(pRows);
E.acknowledge(pRows.find(r => r.asWritten === 'Bel'));
E.acknowledge(pRows.find(r => r.asWritten === 'the dragon pact'), 'The Dragon Pact');
const pRefs = F.pageReferences('notes', pRows, index);
const RUFUS = pRefs.find(r => r.occ === 'occ_notes_1').entityId;
const BELFAR = C.get('loc_006');
const LORE = pRefs.find(r => r.occ === 'occ_notes_3').entityId;
function notesPage() {
  return { combats: [{ combat: AMBUSH, rounds: [{ n: 8, turns: [
      { actor: 'occ_notes_4', source_line: 'Mal - Hit (6)', activities: [act('action', 'Attack', [out('hit', 6)])] }], enemy_turns: [], events: [] }] }],
    quest_progress: [], loot: [], self_check: [],
    passages: [
      { text: 'Rufus said he had not slept since the dragons came, and that he would guide the party for a share of the bounty.', speaker: 'occ_notes_1', attach: { to: 'entity', occ: 'occ_notes_1' }, source_lines: ['Rufus - no sleep since drags, will guide for share'] },
      { text: 'Belfar is a walled market town on the river, its gates shut at dusk.', speaker: 'dm', attach: { to: 'entity', occ: 'occ_notes_2' }, source_lines: ['Bel - walled mkt town, river, gates shut dusk'] },
      { text: 'Rufus claimed the dragons keep an old pact with the goblins of the ridge.', speaker: 'occ_notes_1', attach: { to: 'entity', occ: 'occ_notes_3' }, source_lines: ['R: drags have pact w/ ridge gobs'] },
      { text: 'Malachite\'s blade bit deep as the last goblin turned to run.', speaker: 'dm', attach: { to: 'round', combat: AMBUSH, n: 8 }, source_lines: ['Mal - Hit (6)'] },
      { text: 'The party rode on toward the river at dusk.', speaker: 'dm', attach: { to: 'session' }, source_lines: ['on to river'] },
    ],
    page_summary: 'The party meets Rufus, hears of a dragon pact and reaches Belfar.' };
}

console.log('\nTest P-1 — passages parse and validate');
{
  const parsed = F.parseFacts(JSON.stringify(notesPage()));
  assert('P-1: passages and the page summary are kept', parsed.passages.length === 5 && /meets Rufus/.test(parsed.page_summary));
  assert('P-1: a valid page has no errors', F.validateFacts(parsed, pRefs, combats).length === 0);
  const bad = notesPage();
  bad.passages[0].speaker = 'Rufus';
  bad.passages[1].attach = { to: 'entity', occ: 'Belfar' };
  bad.passages[3].attach = { to: 'round', combat: AMBUSH, n: 12 };
  const badParsed = F.parseFacts(JSON.stringify(bad));
  const errs = F.validateFacts(badParsed, pRefs, combats);
  assert('P-1: a speaker named instead of "dm" or an occurrence is an error', errs.some(e => /speaker "Rufus"/.test(e)));
  // Since #103 a bad attachment is repaired, not an error: one misplaced
  // passage must not throw away a page of facts (seen on session 6 page 1).
  assert('P-1: an attachment by name is moved to the session, not an error', errs.length === 1 && badParsed.passages[1].attach.to === 'session');
  assert('P-1: an attachment to a round the page does not record falls back to its combat', badParsed.passages[3].attach.to === 'combat' && badParsed.passages[3].attach.combat === AMBUSH);
  assert('P-1: each repair is noted in the self-check notes', badParsed.self_check.filter(n => /which this page does not record/.test(n)).length === 2);
  const act2 = notesPage();
  act2.passages[3].attach = { to: 'activity', combat: AMBUSH, n: 8, actor: 'occ_notes_4', index: 5 };
  const a2 = F.parseFacts(JSON.stringify(act2));
  F.validateFacts(a2, pRefs, combats);
  assert('P-1: an activity the page does not record falls back to its round', a2.passages[3].attach.to === 'round' && a2.passages[3].attach.n === 8);
  assert('P-1: a passage with no attachment defaults to the session', F.parseFacts('{"combats":[],"passages":[{"text":"x","speaker":"dm"}]}').passages[0].attach.to === 'session');
  const p = F.factsPrompt({ pageLabel: 'notes', references: pRefs, combats, carry: null, reread: null });
  assert('P-1: the prompt asks for passages: clean-up rule, speaker and attachment', /add no fact the notes do not contain/.test(p) && /"speaker": "dm"/.test(p) && /A description of a place goes on the place/.test(p));
}

console.log('\nTest P-2 — passages become publish items (gate)');
{
  const merged = F.mergePages([{ page: 'notes', facts: F.parseFacts(JSON.stringify(notesPage())) }], pRefs);
  assert('P-2: the page summary is gathered', merged.summaries.length === 1);
  const { items, deferred } = F.passageItems(merged, pRefs, 'session_006');
  const on = id => items.filter(i => i.targetId === id);
  const rufus = on(RUFUS);
  assert('P-2: the NPC conversation goes on the NPC, with the NPC as speaker',
    rufus.length === 1 && rufus[0].array === 'npc_directory' && rufus[0].rawData._passage_append[0].speaker === RUFUS);
  const bel = on(BELFAR);
  assert('P-2: the place description goes on the place (DM as speaker), not the session',
    bel.length === 1 && bel[0].array === 'locations' && bel[0].rawData._passage_append[0].speaker === 'dm' &&
    !items.some(i => i.array === 'session_logs' && /walled market town/.test(i.rawData._passage_append[0].text)));
  assert('P-2: a scene-setting passage goes on the session, by its session_NNN', on('session_006').length === 1 && on('session_006')[0].array === 'session_logs');
  assert('P-2: a round passage waits for the round to be written (#106)', deferred.length === 1 && deferred[0].passage.attach.to === 'round');
  assert('P-2: each passage has the #93 shape', items.every(i => { const p = i.rawData._passage_append[0]; return p.text && p.session_id === 'session_006' && p.speaker && 'page' in p; }));
  assert('P-2: nothing is copied to a second place', items.length + deferred.length === merged.passages.length);

  // Through the real applySession, with the new lore from identification.
  const identity = F.testimonyUpdates(E.toQueueItems(pRows, index, 'session_006'), merged.passages, pRefs);
  const lore = identity.find(i => i.array === 'world_lore');
  assert('P-2: new lore an NPC told the party is rumoured npc_testimony, sourced to the NPC',
    lore.rawData.mechanics.reliability === 'rumoured' && lore.rawData.mechanics.source_type === 'npc_testimony' && lore.rawData.mechanics.source === RUFUS);
  const out = ChroniclePublish.applySession(campaign, identity.concat(items)).campaign;
  const pub = (arr, id) => out[arr].find(e => e.id === id);
  assert('P-2: published — Rufus has the conversation, speaker Rufus',
    pub('npc_directory', RUFUS).passages?.length === 1 && pub('npc_directory', RUFUS).passages[0].speaker === RUFUS);
  assert('P-2: published — Belfar has the description', pub('locations', BELFAR).passages?.length === 1);
  assert('P-2: published — the session passage, with session_id translated to the session\'s UUID',
    pub('session_logs', C.get('session_006')).passages?.[0]?.session_id === C.get('session_006'));
  const newLore = out.world_lore.find(l => l.title === 'The Dragon Pact');
  assert('P-2: published — the new lore carries its testimony passage and rumoured reliability',
    newLore && newLore.passages?.length === 1 && newLore.mechanics.reliability === 'rumoured' && newLore.passages[0].speaker === RUFUS);
  const again = ChroniclePublish.applySession(out, items).campaign;
  assert('P-2: a repeat publish adds no passage twice', again.npc_directory.find(n => n.id === RUFUS).passages.length === 1);
}

console.log('\nTest P-3 — the DM edits and drops passages (#116)');
{
  // The #17 gate published misreads that sat in passages ("ruins" for ROUS,
  // "Not 1" for Nat 1) because review could only move a passage.
  const fresh = () => F.mergePages([{ page: 'notes', facts: F.parseFacts(JSON.stringify(notesPage())) }], pRefs);
  const merged = fresh();
  const rufusAt = merged.passages.findIndex(p => p.speaker !== 'dm');
  const roundAt = merged.passages.findIndex(p => p.attach && p.attach.to === 'round');
  const sessionAt = merged.passages.findIndex(p => p.attach && p.attach.to === 'session');
  const before = merged.passages[rufusAt].text;
  F.applyPassageEdits(merged.passages, { [rufusAt]: { text: '  Rufus says the dragons keep a pact with the goblins.  ' }, [roundAt]: { dropped: true } });
  const ed = merged.passages[rufusAt];
  assert('P-3: an edit replaces the text, trimmed, and keeps the AI\'s reading', ed.text === 'Rufus says the dragons keep a pact with the goblins.' && ed.originalText === before);
  assert('P-3: the speaker and attachment are unchanged by an edit', ed.speaker !== 'dm' && ed.attach.to === 'entity');
  const { items, deferred } = F.passageItems(merged, pRefs, 'session_006');
  assert('P-3: the edited text is what is written', items.some(i => i.rawData._passage_append[0].text === ed.text) && !items.some(i => i.rawData._passage_append[0].text === before));
  assert('P-3: the written passage carries no review fields', items.every(i => !('originalText' in i.rawData._passage_append[0]) && !('dropped' in i.rawData._passage_append[0])));
  assert('P-3: a dropped passage is neither written nor deferred', deferred.length === 0 && items.length === merged.passages.length - 1);
  assert('P-3: item ids still follow the passage positions', items.some(i => i.id === 'passage_' + sessionAt));
  const same = fresh();
  F.applyPassageEdits(same.passages, { [rufusAt]: { text: before }, [sessionAt]: { text: '   ' } });
  assert('P-3: saving the AI\'s own text, or nothing, changes nothing', !('originalText' in same.passages[rufusAt]) && !('originalText' in same.passages[sessionAt]));
  const again = F.applyPassageEdits(F.applyPassageEdits(fresh().passages, { [rufusAt]: { text: 'Edited once.' } }), { [rufusAt]: { text: 'Edited twice.' } });
  assert('P-3: a second edit keeps the AI\'s first reading as originalText', again[rufusAt].text === 'Edited twice.' && again[rufusAt].originalText === before);
  // A dropped NPC passage is not testimony: new lore it named stays as identified.
  const told = fresh();
  // Every passage an NPC spoke is dropped (the lore's testimony is its own passage).
  F.applyPassageEdits(told.passages, Object.fromEntries(told.passages.map((p, i) => [i, p.speaker !== 'dm' ? { dropped: true } : null]).filter(([, e]) => e)));
  const lore = F.testimonyUpdates(E.toQueueItems(pRows, index, 'session_006'), told.passages, pRefs).find(i => i.array === 'world_lore');
  assert('P-3: dropping the NPC\'s passage means its lore is not marked as testimony', lore && lore.rawData.mechanics.reliability !== 'rumoured');
  const page = fs.readFileSync(require('path').join(__dirname, '..', 'admin', 'session.html'), 'utf8');
  assert('P-3: the page applies the edits with the moves, against the same read',
    /for \(const \[i, attach\] of Object\.entries\(session\.passageMoves[^\n]*\n[^\n]*\n\s*ChronicleFacts\.applyPassageEdits\(merged\.passages, session\.passageEdits\)/.test(page));
  assert('P-3: every passage has Edit and Drop, a dropped one Restore', /onclick="session\.passageEditing = \$\{i\}; renderReview\(\);">Edit</.test(page) && /dropPassage\(\$\{i\}, true\)">Drop</.test(page) && /dropPassage\(\$\{i\}, false\)">Restore</.test(page));
  assert('P-3: the draft and the header draft skip dropped passages', /\.filter\(p => all \|\| !p\.dropped\)/.test(page) && /passages\.filter\(p => !p\.dropped && !passageTarget\(p\)\)/.test(page) && /passages\.filter\(p => !p\.dropped\)\.map\(p => \(\{ text: p\.text, speakerLabel/.test(page));
  assert('P-3: a change after the draft asks for a Redraft', /session\.passagesChangedSinceDraft \? '<div class="flag-box">Passages were edited or dropped after this draft was made/.test(page));
  assert('P-3: dropped passages are listed as not written', /list\('Passages you dropped', droppedPassages\)/.test(page));
}

console.log('\nTest P-4 — quest progress and loot shapes (#115)');
{
  // The real session 4 read wrote quest progress as { occ, detail }, so
  // publish found no quest and left it unplaced (#17, #115).
  const x = F.parseFacts(JSON.stringify({ combats: [],
    quest_progress: [{ occ: 'occ_1_dm1', detail: 'Helen asked the party to clear the rats.' }, { quest: 'occ_1_2', entry: 'kept as written', occ: 'ignored' }],
    loot: [{ occ: 'occ_1_3', change: 'found', detail: 'a map' }] }));
  assert('P-4: occ/detail are read as quest/entry', x.quest_progress[0].quest === 'occ_1_dm1' && x.quest_progress[0].entry === 'Helen asked the party to clear the rats.');
  assert('P-4: a reply already in the right shape is left alone', x.quest_progress[1].quest === 'occ_1_2' && x.quest_progress[1].entry === 'kept as written');
  assert('P-4: loot occ/detail are read as item/item_text', x.loot[0].item === 'occ_1_3' && x.loot[0].item_text === 'a map');
  const prompt = F.factsPrompt({ pageLabel: 'page 1', references: [], combats: [], abilities: '' });
  assert('P-4: the prompt spells out the quest progress shape, with the progress types',
    prompt.includes('{"quest":"<occurrence id of the quest>","entry":') && prompt.includes('"lead_acquired"') && prompt.includes('a quest that is merely named is not progress'));
  assert('P-4: the prompt spells out the loot shape', prompt.includes('{"item":"<occurrence id of the item, or null>"') && prompt.includes('"found", "given", "lost", "used"'));
  assert('P-4: the prompt says an added occurrence has no line of its own', /"Added by the DM" has no line of its own/.test(prompt) && /never copy that text as a source line/.test(prompt));
}

console.log('\nTest P-5 — reviewing quest progress and loot (#120)');
{
  const qp = () => [{ quest: 'occ_1_dm1', entry: 'The Stone Quarry has ROUS. That is causing problems.', type: 'lead_acquired', giver: null, source_line: 'Stone Quarry sw of here', page: 1 },
                    { quest: 'occ_1_2', entry: 'A second step.', type: null, source_line: 'x', page: 1 }];
  const list = F.applyFactEdits(qp(), { 0: { type: 'inciting_event', giver: 'occ_1_5', entry: '  Helen told the party rats plague the quarry work camp.  ' }, 1: { dropped: true } });
  assert('P-5: a fact can be retyped and given a giver, keeping the AI\'s values', list[0].type === 'inciting_event' && list[0].giver === 'occ_1_5' && list[0].original.type === 'lead_acquired' && list[0].original.giver === null);
  assert('P-5: its text is edited, trimmed, with the AI\'s reading kept', list[0].entry === 'Helen told the party rats plague the quarry work camp.' && /That is causing problems/.test(list[0].original.entry));
  assert('P-5: a dropped fact is marked and stays in the list', list[1].dropped === true && list.length === 2);
  const moved = F.applyFactEdits(qp(), { 0: { quest: 'occ_1_2' } });
  assert('P-5: a fact can be moved to another quest', moved[0].quest === 'occ_1_2' && moved[0].original.quest === 'occ_1_dm1');
  const same = F.applyFactEdits(qp(), { 0: { type: 'lead_acquired', entry: '   ' } });
  assert('P-5: the AI\'s own value, or an empty text, changes nothing', !same[0].original && same[0].entry === qp()[0].entry);
  const cleared = F.applyFactEdits(qp(), { 0: { type: null } });
  assert('P-5: null clears a field', cleared[0].type === null && cleared[0].original.type === 'lead_acquired');
  const loot = F.applyFactEdits([{ item: 'occ_1_3', change: 'found', holder: null }], { 0: { change: 'given', holder: 'occ_1_4' } });
  assert('P-5: a loot fact\'s change and holder can be corrected', loot[0].change === 'given' && loot[0].holder === 'occ_1_4' && loot[0].original.change === 'found');
  const parsed = F.parseFacts(JSON.stringify({ combats: [], quest_progress: [{ occ: 'occ_1_dm1', detail: 'start', type: 'inciting_event', given_by: 'occ_1_5' }] }));
  assert('P-5: a giver written as given_by is read as giver', parsed.quest_progress[0].giver === 'occ_1_5');
  const refs = [{ occ: 'occ_1_dm1' }, { occ: 'occ_1_5' }];
  assert('P-5: a giver must be an occurrence id', F.validateFacts({ combats: [], quest_progress: [{ quest: 'occ_1_dm1', giver: 'Helen' }], loot: [], passages: [] }, refs, []).some(e => /giver/.test(e))
    && F.validateFacts({ combats: [], quest_progress: [{ quest: 'occ_1_dm1', giver: 'occ_1_5' }], loot: [], passages: [] }, refs, []).length === 0);
  const prompt = F.factsPrompt({ pageLabel: 'page 1', references: [], combats: [], abilities: '' });
  assert('P-5: the prompt asks for the giver and proposes inciting_event for a quest\'s start',
    prompt.includes('"giver":"<occurrence id of who gave the party the quest, or null>"') && /that is the quest's start: type "inciting_event"/.test(prompt) && /A quest has one start/.test(prompt));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
