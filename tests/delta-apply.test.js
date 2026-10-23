/**
 * tests/delta-apply.test.js — Group F (publish) and Group G (issue #92)
 *
 * Automated tests for ChroniclePublish.applySession() in
 * shared/chronicle-publish.js, the function Delta Review's Publish applies the
 * approved queue with, and for the remainingRounds rule of the gap-fill panel.
 *   F-1 – F-4   ROUND routing and round order (issue #39); merge, not overwrite (#92)
 *   F-5 – F-8   remainingRounds for partial gap fill (issue #38)
 *   F-9 – F-12  RAW items, new-entity ids, unknown arrays, legacy-ID translation (#66, #68, #95)
 *   G-1 – G-9   issue #92: turn schema, enemy turns, sessions, derived fields,
 *               rounds split across pages, the gate, inputs left untouched
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Publish is the one place review results become campaign data, and every
 * later phase of the intake rebuild depends on it writing shapes the viewers
 * read. Until #92 these tests ran a copy of the page's function (later, a cut
 * of it); #92 moved the logic into a shared module, so the tests require the
 * same file the page loads and test the real code directly.
 *
 * The #92 tests (Group G) run against an in-memory copy of the real campaign,
 * because it has what they need and the fixture does not: the session_006
 * placeholder, combat rosters, a bestiary and party nicknames. Nothing is
 * written back to the file.
 *
 * RUN
 * ---
 * node tests/delta-apply.test.js
 *
 * Plain Node.js — no external test framework required.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ChronicleIds     = require('../shared/chronicle-ids.js');
const ChroniclePublish = require('../shared/chronicle-publish.js');
const { checkReferences, checkPassed } = require('../scripts/migrate-opaque-ids.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * assert(label, condition)
 * Prints PASS or FAIL with the test label and increments counters.
 * All tests run regardless of earlier failures.
 */
function assert(label, condition) {
  if (condition) {
    console.log('  PASS  ' + label);
    passed++;
  } else {
    console.log('  FAIL  ' + label);
    failed++;
  }
}

const ROOT     = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const fixture  = readJson('tests/fixtures/test-campaign.json');
const campaign = readJson('data/magers-campaign.json');

// apply(base, items, options) → the updated campaign. Most tests only need
// the campaign; applyN returns the notes too.
const applyN = (base, items, options) => ChroniclePublish.applySession(base, items, options);
const apply  = (base, items, options) => applyN(base, items, options).campaign;

// Entities have UUID ids since #95. L (fixture) and C (campaign) find one by
// its legacy ID, as the DM and the AI still name them.
const L = ChronicleIds.buildLegacyIndex(fixture);
const C = ChronicleIds.buildLegacyIndex(campaign);

// sameCampaign(a, b) — equal apart from the timestamps every publish stamps
// (_last_published, _delta_count, meta.last_updated) and the derived fields it
// may complete. Used by the "nothing changed" tests on the fixture, after the
// fixture has had its derived fields completed once.
function sameCampaign(a, b) {
  const strip = c => JSON.stringify(Object.assign({}, c, {
    _last_published: null, _delta_count: null, meta: Object.assign({}, c.meta, { last_updated: null }),
  }));
  return strip(a) === strip(b);
}
const fixtureDerived = (() => { const c = JSON.parse(JSON.stringify(fixture)); ChroniclePublish.deriveFields(c); return c; })();

// loadNormaliser(file) — normaliseCampaignJson cut from a viewer page, as in
// tests/turn-schema.test.js, so the gate renders through the real viewer code.
function loadNormaliser(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function normaliseCampaignJson');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('normaliseCampaignJson not found in ' + file);
  return new Function(src.slice(start, end + 2) + '\nreturn normaliseCampaignJson;')();
}

// A ROUND queue item in the shape interpretRawItem() and approveGapProposal()
// build: rawData holds the AI's flat proposal (slots one entry per roll,
// enemy_turns of {desc, impact}).
function roundItem(combatId, n, sessionId, slots, enemy) {
  return { type: 'ROUND', array: 'combat_encounters', combatId, roundNumber: n, status: 'approved',
    rawData: { n, session_id: sessionId, slots: slots || [], enemy_turns: enemy || [] } };
}
// One flat AI entry (chronicle-ai.js _normaliseRoundProposals output).
function entry(s, a, act, res, val, more) {
  return Object.assign({ s, a, act, res, val, notes: null, action_type: 'action', target: null, target_effects: [], val_type: null }, more || {});
}

// ── Inline remainingRounds computation ───────────────────────────────────────
// Mirrors the logic in renderGapCard() and gapFillFromImage() / gapFillFromText().

/**
 * computeRemainingRounds(g, st)
 * Returns the round numbers from g.miss that are not already in st.approvedRounds.
 * This is what the AI fill calls receive after issue #38 — only unresolved rounds.
 */
function computeRemainingRounds(g, st) {
  return g.miss.filter(n => !(st?.approvedRounds || []).includes(n));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-1 — ROUND delta inserts into combat.rounds[], not the root array
// ═══════════════════════════════════════════════════════════════════════════
// Before issue #39 a gap-approved round was routed through the NEW branch and
// appended as a root-level combat. type:'ROUND' must insert into rounds[].

console.log('\nTest F-1 — ROUND delta inserts round into combat.rounds[]');
{
  const result = apply(fixture, [roundItem('cbt_001', 4, 'session_001')]);
  const cbt    = result.combat_encounters.find(c => c.id === L.get('cbt_001'));
  const before = fixture.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.length;

  assert('combat_encounters length unchanged (round not added as a new combat)',
    result.combat_encounters.length === fixture.combat_encounters.length);
  assert('cbt_001.rounds now contains round 4', cbt.rounds.some(r => r.n === 4));
  assert('cbt_001.rounds length increased by 1', cbt.rounds.length === before + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-2 — rounds stay in ascending order
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest F-2 — ROUND delta sorts rounds in ascending order after insert');
{
  const withGap = JSON.parse(JSON.stringify(fixture));
  withGap.combat_encounters[0].rounds = withGap.combat_encounters[0].rounds.filter(r => r.n !== 2);
  const result = apply(withGap, [roundItem('cbt_001', 2, 'session_001')]);
  const nums   = result.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.map(r => r.n);
  assert('rounds are sorted [1, 2, 3] after gap fill', nums.join(',') === '1,2,3');
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-3 — a round already recorded is merged, not overwritten (#92)
// ═══════════════════════════════════════════════════════════════════════════
// Until #92 a ROUND delta for a recorded round number replaced the round. A
// round split across two pages arrives as two halves with the same number,
// so replacing lost the first half. Now the halves merge, and publishing a
// round that is already recorded adds nothing.

console.log('\nTest F-3 — ROUND delta for a recorded round merges (no overwrite, no duplicate)');
{
  const cbtBefore = fixture.combat_encounters.find(c => c.id === L.get('cbt_001'));
  const r2Before  = cbtBefore.rounds.find(r => r.n === 2);
  const extra = entry(3, 'pc_002', 'Dash', 'neutral', null);
  const { campaign: result, notes } = applyN(fixture, [roundItem('cbt_001', 2, 'session_001', [extra])]);
  const r2 = result.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.find(r => r.n === 2);

  assert('round count unchanged (no second round 2)',
    result.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.length === cbtBefore.rounds.length);
  assert('every recorded slot of round 2 is still there',
    r2Before.slots.every(s => r2.slots.some(x => x.s === s.s && JSON.stringify(x.activities) === JSON.stringify(s.activities))));
  assert('the new slot was added', r2.slots.some(s => s.s === 3 && s.activities[0].name === 'Dash'));
  assert('a note says the round was merged', notes.some(n => /round 2: merged/.test(n)));

  const again = apply(fixtureDerived, [{ type: 'ROUND', array: 'combat_encounters', combatId: 'cbt_001', rawData: JSON.parse(JSON.stringify(r2Before)) }]);
  assert('publishing a round that is already recorded changes nothing', sameCampaign(fixtureDerived, again));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-4 — NEW on combat_encounters adds a combat, never a round
// ═══════════════════════════════════════════════════════════════════════════
// The pre-#39 bug path: a round-shaped object queued as NEW. It becomes a
// (badly named) new combat, which shows NEW and ROUND stay separate routes.

console.log('\nTest F-4 — NEW delta on combat_encounters appends a combat (not into rounds)');
{
  const result = apply(fixture, [{ type: 'NEW', array: 'combat_encounters', rawData: { n: 4, slots: [], enemy_turns: [] } }]);
  const cbt    = result.combat_encounters.find(c => c.id === L.get('cbt_001'));
  assert('NEW delta increases combat_encounters length', result.combat_encounters.length === fixture.combat_encounters.length + 1);
  assert('cbt_001.rounds unchanged',
    cbt.rounds.length === fixture.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-5 – F-8 — remainingRounds for partial gap fill (issue #38)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest F-5 — remainingRounds returns all g.miss when no rounds approved yet');
{
  const remaining = computeRemainingRounds({ miss: [4, 5, 6] }, { approvedRounds: [] });
  assert('remainingRounds length === 3', remaining.length === 3);
  assert('rounds 4, 5, 6 are in remainingRounds', [4, 5, 6].every(n => remaining.includes(n)));
}

console.log('\nTest F-6 — remainingRounds excludes approved rounds (partial fill state)');
{
  const remaining = computeRemainingRounds({ miss: [4, 5, 6] }, { approvedRounds: [4] });
  assert('remainingRounds length === 2', remaining.length === 2);
  assert('round 4 NOT in remainingRounds', !remaining.includes(4));
}

console.log('\nTest F-7 — remainingRounds returns [] when all miss rounds are approved');
{
  assert('remainingRounds is empty', computeRemainingRounds({ miss: [4, 5, 6] }, { approvedRounds: [4, 5, 6] }).length === 0);
}

console.log('\nTest F-8 — remainingRounds returns g.miss when gapState is undefined');
{
  assert('remainingRounds equals g.miss when st is undefined', computeRemainingRounds({ miss: [4, 5, 6] }, undefined).length === 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-9 — RAW and narrative-notes items write nothing (#70, #92)
// ═══════════════════════════════════════════════════════════════════════════
// RAW OCR pages are reference text. Intake's "Narrative notes" item is queued
// under session_logs with no id; before #92 publish pushed it as a session.

console.log('\nTest F-9 — RAW and narrative-notes items are not written');
{
  const raw = { type: 'RAW', array: 'session_logs', status: 'approved',
    rawData: { page_index: 0, ocr_text: 'ROUND 1\nSlot 1: Gold — Firebolt, hit, 8\n', page_failed: false } };
  const narr = { id: 'intake_narrative', type: 'NEW', array: 'session_logs', status: 'approved',
    rawData: { narrative_text: 'We met the mayor.' } };
  const { campaign: result, notes } = applyN(fixtureDerived, [raw, narr]);
  assert('session_logs length unchanged', result.session_logs.length === fixture.session_logs.length);
  assert('campaign otherwise identical', sameCampaign(fixtureDerived, result));
  assert('a note says the narrative notes are not saved', notes.some(n => /narrative notes item is not saved/.test(n)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-10 — NEW delta with no id gets a UUID (issues #66, #95)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest F-10 — NEW delta with no id gets a UUID');
{
  const cascadeNpc = { type: 'NEW', array: 'npc_directory', status: 'approved',
    rawData: { name: 'Barnes', type: 'npc', description: 'Mayor of Lake Town.' } };
  const r = apply(fixture, [cascadeNpc]);
  const added = r.npc_directory.find(n => n.name === 'Barnes');
  assert('F-10a: cascade NPC is added', r.npc_directory.length === fixture.npc_directory.length + 1);
  assert('F-10a: its id is a UUID', ChronicleIds.isOpaqueId(added?.id));
  assert('F-10a: it has no legacy_id', !!added && !('legacy_id' in added));
  assert('F-10a: the queue item is not modified', !('id' in cascadeNpc.rawData));
  const two = apply(fixture, [cascadeNpc, Object.assign({}, cascadeNpc, { rawData: { name: 'Delta' } })]);
  const ids = two.npc_directory.map(n => n.id);
  assert('F-10b: two new NPCs get two different ids', new Set(ids).size === ids.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-11 — NEW delta with an unrecognised array is skipped (issue #68)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest F-11 — NEW delta with unrecognised array is silently skipped');
{
  const garbage = { type: 'NEW', array: 'session_note', status: 'approved',
    rawData: { name: 'Session 006 — Lance absent', type: 'session_note' } };
  assert('campaign identical — unknown array produces no mutation', sameCampaign(fixtureDerived, apply(fixtureDerived, [garbage])));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-12 — legacy IDs and placeholders become UUIDs at publish (#95)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest F-12 — legacy IDs and placeholders become UUIDs at publish');
{
  const round = { n: 4, slots: [{ s: 1, a: 'pc_001', activities: [], notes: null }], enemy_turns: [] };
  const r12a  = apply(fixture, [{ type: 'ROUND', combatId: 'cbt_001', array: 'combat_encounters', rawData: round }]);
  const added = r12a.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.find(r => r.n === 4);
  assert('F-12a: round lands in cbt_001 (legacy combatId translated)', !!added);
  assert('F-12a: slot actor pc_001 written as its UUID', added?.slots[0].a === L.get('pc_001'));
  assert('F-12a: the queue item still says pc_001', round.slots[0].a === 'pc_001');

  const r12b = apply(fixture, [
    roundItem('cbt_099', 1, 'session_001'),
    { type: 'NEW', array: 'combat_encounters', rawData: { id: 'cbt_099', name: 'New Fight', rounds: [] } },
  ]);
  const fight = r12b.combat_encounters.find(c => c.name === 'New Fight');
  assert('F-12b: new combat gets a UUID', ChronicleIds.isOpaqueId(fight?.id));
  assert('F-12b: its placeholder is not kept as legacy_id', !!fight && !('legacy_id' in fight));
  assert('F-12b: the round queued before it found it', fight?.rounds.length === 1);

  const r12c = apply(fixture, [
    { type: 'NEW', array: 'session_logs', rawData: { id: 'session_042', title: 'S42' } },
    { type: 'MOD', array: 'npc_directory', targetId: 'npc_001', rawData: { id: 'npc_001', last_seen: 'session_042' } },
  ]);
  const s42 = r12c.session_logs.find(s => s.title === 'S42');
  assert('F-12c: new session id is a UUID', ChronicleIds.isOpaqueId(s42?.id));
  assert('F-12c: new session keeps legacy_id session_042', s42?.legacy_id === 'session_042');
  assert('F-12c: MOD by legacy targetId patched the right NPC',
    r12c.npc_directory.find(n => n.id === L.get('npc_001'))?.last_seen === s42?.id);

  const r12d = apply(fixture, [{ type: 'NEW', array: 'npc_directory', rawData: { id: 'npc_001', name: 'Dup' } }]);
  assert('F-12d: NEW with an existing legacy id adds nothing', r12d.npc_directory.length === fixture.npc_directory.length);

  const withRels = Object.assign(JSON.parse(JSON.stringify(fixture)), { entity_relationships: [] });
  const rel = apply(withRels, [{ type: 'RELATIONSHIP', array: 'entity_relationships',
    rawData: { from_id: 'pc_001', to_id: 'npc_001', significance: 'significant_event' } }]).entity_relationships[0];
  assert('F-12e: relationship id is a UUID', ChronicleIds.isOpaqueId(rel?.id));
  assert('F-12e: endpoints translated', rel?.from_id === L.get('pc_001') && rel?.to_id === L.get('npc_001'));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-1 — a flat AI round is written in the 5.0.0 turn schema (#92)
// ═══════════════════════════════════════════════════════════════════════════
// The AI returns one entry per roll. Publish must group them into one slot per
// turn, one activity per action (with an outcome per roll), split the action
// name (Magic · spell, Attack · weapon), resolve targets to ids, and write the
// session as sid.

console.log('\nTest G-1 — flat AI entries become activities and outcomes');
{
  const spells = ['Fire Bolt', 'Cure Wounds', 'Acid Splash'];
  const slots = [
    // Del (pc_004): two unarmed strikes, then Flurry of Blows as a bonus action.
    entry(1, 'pc_004', 'Unarmed Strike', 'hit', 5, { target: 'goblin', target_effects: ['killed'] }),
    entry(1, 'pc_004', 'Unarmed Strike', 'miss', null, { target: 'goblin' }),
    entry(1, 'pc_004', 'Flurry of Blows', 'hit', 4, { action_type: 'bonus_action', target: 'Ogre' }),
    // Att (pc_006): a spell by name, aimed at a party nickname.
    entry(3, 'pc_006', 'Cure Wounds', 'neutral', 5, { target: 'Del', val_type: 'healing' }),
    // Gold (pc_001): Acid Splash on two targets; one failed its save.
    entry(6, 'pc_001', 'Acid Splash', 'fail', 4, { target: 'Goblins', target_effects: ['prone'] }),
    entry(6, 'pc_001', 'Acid Splash', 'save', 4, { target: 'Goblin Slingers' }),
    // Mal (pc_002): a death save recorded as hit; Goli (pc_005): Dash, no roll.
    entry(2, 'pc_002', 'Death save', 'hit', null),
    entry(4, 'pc_005', 'Dash', 'neutral', null, { notes: 'to the cart' }),
    // An action the AI could not type.
    entry(5, 'pc_003', 'Shortbow', 'hit', 7, { action_type: null, target: 'horse' }),
  ];
  const { campaign: out, notes } = applyN(campaign, [roundItem('cbt_005', 4, 'session_006', slots)], { spellNames: spells });
  const r4  = out.combat_encounters.find(c => c.id === C.get('cbt_005')).rounds.find(r => r.n === 4);
  const del = r4.slots.find(s => s.s === 1);
  const att = r4.slots.find(s => s.s === 3);
  const gold = r4.slots.find(s => s.s === 6);
  const mal = r4.slots.find(s => s.s === 2);
  const goli = r4.slots.find(s => s.s === 4);
  const ash = r4.slots.find(s => s.s === 5);

  assert('G-1: round written with sid = the session UUID (not session_id)', r4.sid === C.get('session_006') && !('session_id' in r4));
  assert('G-1: one slot per turn, sorted by slot', r4.slots.map(s => s.s).join(',') === '1,2,3,4,5,6');
  assert('G-1: actors are UUIDs', del.a === C.get('pc_004'));
  assert('G-1: two rolls of one action are one activity with two outcomes',
    del.activities[0].name === 'Attack' && del.activities[0].detail === 'Unarmed Strike' && del.activities[0].outcomes.length === 2);
  assert('G-1: bonus action is its own activity named after the feature',
    del.activities[1].economy === 'bonus_action' && del.activities[1].name === 'Flurry of Blows');
  assert('G-1: "goblin" resolves to the roster group Goblins', del.activities[0].outcomes[0].target_id === 'Goblins');
  assert('G-1: killed becomes the outcome effect', del.activities[0].outcomes[0].effect === 'killed');
  assert('G-1: a known spell is Magic · spell', att.activities[0].name === 'Magic' && att.activities[0].detail === 'Cure Wounds');
  assert('G-1: a nickname target resolves to the PC', att.activities[0].outcomes[0].target_id === C.get('pc_004'));
  assert('G-1: healing keeps its val_type and value', att.activities[0].val_type === 'healing' && att.activities[0].outcomes[0].val === 5);
  assert('G-1: AoE spell is one activity with one outcome per target', gold.activities.length === 1 && gold.activities[0].outcomes.length === 2);
  assert('G-1: "fail" (target failed its save) is recorded as hit; "save" stays save',
    gold.activities[0].outcomes[0].res === 'hit' && gold.activities[0].outcomes[1].res === 'save');
  assert('G-1: a condition that is not down/killed is kept in the outcome notes', gold.activities[0].outcomes[0].notes === 'prone');
  assert('G-1: death save hit is relabelled success', mal.activities[0].name === 'Death Save' && mal.activities[0].outcomes[0].res === 'success');
  assert('G-1: Dash with no roll has no outcomes and keeps its note',
    goli.activities[0].name === 'Dash' && goli.activities[0].outcomes.length === 0 && goli.activities[0].notes === 'to the cart');
  assert('G-1: an untyped action is recorded as the action', ash.activities[0].economy === 'action');
  assert('G-1: a weapon is Attack · weapon, and the assumption is noted',
    ash.activities[0].name === 'Attack' && notes.some(n => /"Shortbow" is not a known spell/.test(n)));
  assert('G-1: a target that is no entity is kept as target_text', ash.activities[0].outcomes[0].target_id === null && ash.activities[0].outcomes[0].target_text === 'horse');
  // Cure Wounds is in the spell list passed in here. Without any list, a spell
  // the campaign already records as Magic (Entangle, cbt_005 r1) is still known.
  const noList = apply(campaign, [roundItem('cbt_005', 4, 'session_006', [entry(3, 'pc_006', 'Entangle', 'neutral', null)])]);
  const ent = noList.combat_encounters.find(c => c.id === C.get('cbt_005')).rounds.find(r => r.n === 4).slots[0].activities[0];
  assert('G-1: a spell already recorded as Magic is known without a spell list', ent.name === 'Magic' && ent.detail === 'Entangle');
  assert('G-1: no flat or 4.x field is written on any slot',
    r4.slots.every(s => !['act', 'res', 'val', 'action', 'bonus_action', 'action_type', 'target'].some(k => k in s)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-2 — enemy lines become one turn per roster group (#92)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest G-2 — enemy {desc, impact} lines become roster-group turns');
{
  const enemy = [
    { desc: 'Goblins: Melee, 4 to Mal', impact: null },
    { desc: 'Goblin Slingers: Sling, 7 to Del', impact: 'Del downed' },
    { desc: 'goblins flank the cart', impact: null },        // opens with a roster label, singular/plural
    { desc: 'Larkspur Dragon: Breath weapon', impact: null }, // a group the roster lacks
    { desc: 'Something rustles in the trees', impact: null }, // no group at all
  ];
  const { campaign: out, notes } = applyN(campaign, [roundItem('cbt_005', 4, 'session_006', [], enemy)]);
  const cbt = out.combat_encounters.find(c => c.id === C.get('cbt_005'));
  const r4  = cbt.rounds.find(r => r.n === 4);
  const gob = r4.enemy_turns.find(t => t.actor_id === 'Goblins');
  const sl  = r4.enemy_turns.find(t => t.actor_id === 'Goblin Slingers');

  assert('G-2: one turn per group (Goblins lines merged)', gob && gob.activities.length === 2);
  assert('G-2: the label is dropped from the action text', gob.activities[0].name === 'Melee, 4 to Mal');
  assert('G-2: impact becomes a special event', sl.special_events.some(e => e.type === 'other' && e.description === 'Del downed'));
  assert('G-2: a labelled group the roster lacked is added to the roster',
    cbt.mechanics.enemies_roster.some(g => g.actor_id === 'Larkspur Dragon' && g.type === 'group'));
  assert('G-2: an unlabelled line with several groups goes to "Unidentified enemies" and is noted',
    r4.enemy_turns.some(t => t.actor_id === 'Unidentified enemies') && notes.some(n => /names no known group/.test(n)));
  assert('G-2: every enemy actor_id is in the combat roster',
    r4.enemy_turns.every(t => cbt.mechanics.enemies_roster.some(g => g.actor_id === t.actor_id)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-3 — a placeholder session is filled, never duplicated (#92)
// ═══════════════════════════════════════════════════════════════════════════
// session_006 holds the DM's title, date and summary. Intake's stub uses the
// old field names and dates itself to the day of intake. Filling must keep the
// recorded values, fill only what is empty, and not append a second session.

console.log('\nTest G-3 — the session_006 placeholder is filled in place');
{
  const before = campaign.session_logs.find(s => s.legacy_id === 'session_006');
  const stub = { id: 'intake_session', type: 'NEW', array: 'session_logs', status: 'approved',
    rawData: { session_id: 'session_006', title: 'The Larkspur Dragons', summary: 'Different summary.',
      session_date: '2026-10-23', narrative: { key_moments: [], tone: 'Smoke and scales.' } } };
  const { campaign: out, notes } = applyN(campaign, [stub]);
  const after = out.session_logs.filter(s => s.legacy_id === 'session_006');

  assert('G-3: still exactly one session_006', after.length === 1 && out.session_logs.length === campaign.session_logs.length);
  assert('G-3: its UUID is unchanged', after[0].id === before.id);
  assert('G-3: the recorded date is kept', after[0].date === before.date);
  assert('G-3: the recorded summary is kept', after[0].narrative.summary === before.narrative.summary);
  assert('G-3: an empty field (tone) is filled', after[0].narrative.tone === 'Smoke and scales.');
  assert('G-3: the kept date is reported', notes.some(n => /session_006: kept the recorded date/.test(n)));
  assert('G-3: no stub field names are written', !('session_id' in after[0]) && !('session_date' in after[0]) && !('summary' in after[0]));

  // The same stub after translateQueueIds() has turned session_006 into its UUID.
  const translated = JSON.parse(JSON.stringify(stub));
  translated.rawData.session_id = before.id;
  const out2 = apply(campaign, [translated]);
  assert('G-3: a stub carrying the UUID also fills, not appends', out2.session_logs.length === campaign.session_logs.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-4 — a new session gets the full schema shape, date and summary (#92)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest G-4 — a new session is written with date, summary and every schema field');
{
  const stub = { id: 'intake_session', type: 'NEW', array: 'session_logs', status: 'approved',
    rawData: { session_id: 'session_008', title: 'Back to the Ranch', summary: 'The party returned.',
      session_date: '2026-04-16', narrative: { key_moments: [] } } };
  const s8 = apply(campaign, [stub]).session_logs.find(s => s.legacy_id === 'session_008');
  assert('G-4: session added with a UUID and legacy_id session_008', ChronicleIds.isOpaqueId(s8?.id));
  assert('G-4: date written to date', s8?.date === '2026-04-16');
  assert('G-4: summary written to narrative.summary', s8?.narrative?.summary === 'The party returned.');
  assert('G-4: mechanics lists present (npcs_met, locations_visited, combats)',
    ['npcs_met', 'locations_visited', 'combats'].every(k => Array.isArray(s8?.mechanics?.[k])));
  assert('G-4: narrative generation fields present', s8?.narrative?.chronicle_entry === null && s8?.narrative?.chronicle_entry_version === 0);
  assert('G-4: _object_type is session', s8?._object_type === 'session');
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-5 — derived fields are recomputed on publish (#92)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest G-5 — combat sessions, round counts, session combats and locations are derived');
{
  const out = apply(campaign, [roundItem('cbt_005', 4, 'session_006', [entry(1, 'pc_004', 'Dash', 'neutral', null)])]);
  const cbt = out.combat_encounters.find(c => c.id === C.get('cbt_005'));
  const s6  = out.session_logs.find(s => s.legacy_id === 'session_006');
  const loc = out.locations.find(l => l.id === cbt.mechanics.location);
  assert('G-5: the combat lists session_006 among its sessions', cbt.mechanics.sessions.includes(C.get('session_006')));
  assert('G-5: total_rounds_logged equals the number of rounds', cbt.mechanics.total_rounds_logged === cbt.rounds.length && cbt.rounds.length === 4);
  assert('G-5: session_006 lists the combat', s6.mechanics.combats.includes(cbt.id));
  assert('G-5: session_006 lists the combat\'s location', s6.mechanics.locations_visited.includes(cbt.mechanics.location));
  assert('G-5: the location lists session_006', loc.mechanics.sessions_visited.includes(s6.id));
  assert('G-5: nothing recorded was removed (session_005 still listed)', cbt.mechanics.sessions.includes(C.get('session_005')));

  const npcsMet = campaign.session_logs.map(s => JSON.stringify(s.mechanics.npcs_met));
  assert('G-5: npcs_met unchanged on today\'s data (it already matches first_appeared)',
    JSON.stringify(out.session_logs.slice(0, campaign.session_logs.length).map(s => JSON.stringify(s.mechanics.npcs_met))) === JSON.stringify(npcsMet));
  const bestiaryBefore = JSON.stringify(campaign.bestiary.map(b => b.mechanics.combat_appearances));
  assert('G-5: bestiary combat_appearances unchanged (already complete)',
    JSON.stringify(out.bestiary.map(b => b.mechanics.combat_appearances)) === bestiaryBefore);

  // deriveFields on its own: idempotent, and on today's file it changes only
  // Lake Town's sessions_visited (session_006 listed it; it did not list back).
  const once = JSON.parse(JSON.stringify(campaign)); ChroniclePublish.deriveFields(once);
  const twice = JSON.parse(JSON.stringify(once)); ChroniclePublish.deriveFields(twice);
  assert('G-5: deriveFields is idempotent', JSON.stringify(once) === JSON.stringify(twice));
  const changed = once.locations.filter((l, i) => JSON.stringify(l) !== JSON.stringify(campaign.locations[i])).map(l => l.legacy_id);
  const otherArrays = ['combat_encounters', 'session_logs', 'bestiary', 'npc_directory'].every(a => JSON.stringify(once[a]) === JSON.stringify(campaign[a]));
  assert('G-5: on today\'s file deriveFields changes only loc_011 (Lake Town)', changed.join(',') === 'loc_011' && otherArrays);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-6 — a round split across two pages is merged (#92)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest G-6 — two halves of one round merge into one');
{
  const page1 = roundItem('cbt_005', 4, 'session_006', [entry(1, 'pc_004', 'Unarmed Strike', 'hit', 5, { target: 'goblin' })]);
  const page2 = roundItem('cbt_005', 4, 'session_006',
    [entry(1, 'pc_004', 'Flurry of Blows', 'hit', 3, { action_type: 'bonus_action' }), entry(2, 'pc_002', 'Dash', 'neutral', null)],
    [{ desc: 'Ogre: Greatclub', impact: null }]);
  const out = apply(campaign, [page1, page2]);
  const rounds = out.combat_encounters.find(c => c.id === C.get('cbt_005')).rounds.filter(r => r.n === 4);
  const del = rounds[0]?.slots.find(s => s.s === 1);
  assert('G-6: one round 4', rounds.length === 1);
  assert('G-6: slot 1 holds both pages\' activities', del?.activities.length === 2 && del.activities[1].name === 'Flurry of Blows');
  assert('G-6: slot 2 from page 2 is present', rounds[0]?.slots.some(s => s.s === 2));
  assert('G-6: the enemy turn from page 2 is present', rounds[0]?.enemy_turns.some(t => t.actor_id === 'Ogre'));
  const again = apply(out, [page1, page2]);
  assert('G-6: publishing both halves again changes nothing in the round',
    JSON.stringify(again.combat_encounters.find(c => c.id === C.get('cbt_005')).rounds) ===
    JSON.stringify(out.combat_encounters.find(c => c.id === C.get('cbt_005')).rounds));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-7 — a round's session is resolved, never written as text (#92)
// ═══════════════════════════════════════════════════════════════════════════
// An integrity gap fill passes the gap's session hint, which may be "incoming
// session" or a comma-joined list. Publish must write a session id or null.

console.log('\nTest G-7 — round session hints resolve to a session id or null');
{
  const stub = { type: 'NEW', array: 'session_logs', rawData: { session_id: 'session_008', title: 'S8' } };
  const out = apply(campaign, [stub,
    roundItem('cbt_005', 4, 'incoming session', [entry(1, 'pc_004', 'Dash', 'neutral', null)]),
    roundItem('cbt_005', 5, 'unknown', [entry(1, 'pc_004', 'Dash', 'neutral', null)])]);
  const cbt = out.combat_encounters.find(c => c.id === C.get('cbt_005'));
  const s8  = out.session_logs.find(s => s.legacy_id === 'session_008');
  assert('G-7: "incoming session" becomes this publish\'s session', cbt.rounds.find(r => r.n === 4).sid === s8.id);
  assert('G-7: "unknown" is written as null', cbt.rounds.find(r => r.n === 5).sid === null);
  assert('G-7: no session text leaks into the combat\'s sessions', cbt.mechanics.sessions.every(s => ChronicleIds.isOpaqueId(s)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-8 — the gate: a sample session publishes and renders correctly (#92)
// ═══════════════════════════════════════════════════════════════════════════
// The issue's gate, without a browser: fill the session_006 placeholder with a
// continuation of the Goblin Ambush and a new combat, run both viewers'
// normalisers on the result, and check date, summary and every round are
// visible, nothing reads "undefined", there is one session_006, and every
// reference resolves (the #95 check, as `--check` runs it).

console.log('\nTest G-8 — gate: sample session renders in both viewers, references resolve');
{
  const queue = [
    { id: 'intake_session', type: 'NEW', array: 'session_logs', status: 'approved',
      rawData: { session_id: 'session_006', title: 'The Larkspur Dragons', summary: '', session_date: '2026-10-23', narrative: { key_moments: [] } } },
    roundItem('cbt_005', 4, 'session_006', [
      entry(1, 'pc_004', 'Unarmed Strike', 'hit', 6, { target: 'goblin' }),
      entry(3, 'pc_006', 'Cure Wounds', 'neutral', 7, { target: 'Mal', val_type: 'healing' }),
      entry(6, 'pc_001', 'Fire Bolt', 'hit', 9, { target: 'Goblin Slingers', target_effects: ['killed'] }),
    ], [{ desc: 'Goblins: Melee, miss', impact: null }, { desc: 'Larkspur Dragon: Bite on Goli', impact: 'Goli downed' }]),
    { type: 'NEW', array: 'combat_encounters', status: 'approved', title: 'New Combat — Return Ambush',
      rawData: { id: 'cbt_007', name: 'Return Ambush', mechanics: { outcome: null, location: null, sessions: ['session_006'], total_rounds_logged: 0 }, narrative: { setup: null, finale: null, aftermath: null }, rounds: [] } },
    roundItem('cbt_007', 1, 'session_006', [entry(2, 'pc_002', 'Attack', 'hit', 8, { target: 'Ogre' })], [{ desc: 'Ogres: Greatclub on Mal', impact: null }]),
  ];
  const queueCopy = JSON.stringify(queue);
  const { campaign: out } = applyN(campaign, queue, { spellNames: ['Cure Wounds', 'Fire Bolt'], now: new Date('2026-10-23T12:00:00Z') });

  assert('G-8: one session_006, no session appended', out.session_logs.filter(s => s.legacy_id === 'session_006').length === 1 && out.session_logs.length === campaign.session_logs.length);
  const check = checkReferences(out);
  assert('G-8: every reference resolves (opaque-ID gate)', checkPassed(check));
  if (!checkPassed(check)) console.log('        ', JSON.stringify({ broken: check.broken, legacy: check.legacy, badTargets: check.badTargets }).slice(0, 600));
  assert('G-8: the queue items were not modified', JSON.stringify(queue) === queueCopy);
  assert('G-8: meta.last_updated is the publish date', out.meta.last_updated === '2026-10-23');

  const views = {};
  for (const file of ['admin/log-viewer.html', 'player/index.html']) {
    const view = loadNormaliser(file)(out);
    views[file] = view;
    const s6 = view.sessions.find(s => s.legacy_id === 'session_006');
    const ambush = view.combats.find(c => c.id === C.get('cbt_005'));
    const fresh  = view.combats.find(c => c.name === 'Return Ambush');
    assert(file + ': session_006 shows its date and summary', s6?.date === '2026-04-02' && !!s6?.summary);
    assert(file + ': Goblin Ambush shows all 4 rounds', ambush?.rounds.length === 4);
    const r4 = ambush.rounds.find(r => r.n === 4);
    assert(file + ': round 4 slots read as text with results', r4.slots.length === 3 && r4.slots.every(s => typeof s.act === 'string' && s.act !== '—'));
    assert(file + ': Fire Bolt shows as the spell with its kill', r4.slots.find(s => s.act === 'Fire Bolt')?.notes === 'Goblin Slingers killed');
    assert(file + ': enemy rows show group and action', r4.enemy.some(e => e.desc === 'Goblins: Melee, miss') && r4.enemy.some(e => e.desc === 'Larkspur Dragon: Bite on Goli' && e.impact === 'Goli downed'));
    assert(file + ': the new combat is visible with its round', fresh?.rounds.length === 1);
    const text = JSON.stringify({ s: view.sessions, c: view.combats });
    assert(file + ': no "undefined" anywhere in sessions or combats', !text.includes('undefined'));
  }
  assert('G-8: admin and player show identical combats',
    JSON.stringify(views['admin/log-viewer.html'].combats) === JSON.stringify(views['player/index.html'].combats));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group G-9 — workflow records, inputs untouched (#92)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nTest G-9 — deferred gaps and prompt log are written; inputs are untouched');
{
  const base = JSON.stringify(fixture);
  const gaps = [{ id: 'gap_001', combat_id: 'cbt_001', session_id: 'session_001', missing_rounds: [4], gap_type: 'incoming', status: 'pending' }];
  const log  = [{ session_id: 'session_001', page_index: 0, steering_text: 'x', status: 'pending_review' }];
  const out  = apply(fixture, [], { deferredGaps: gaps, promptLog: log });
  assert('G-9: deferred gap written with its session translated', out.deferred_gaps.some(g => g.id === 'gap_001' && g.session_id === L.get('session_001')));
  assert('G-9: prompt-log entry written as pil_001', out.prompt_improvement_log?.[0]?.id === 'pil_001');
  assert('G-9: the campaign passed in is not modified', JSON.stringify(fixture) === base);
  const again = apply(out, [], { deferredGaps: gaps });
  assert('G-9: a deferred gap is not added twice', again.deferred_gaps.filter(g => g.id === 'gap_001').length === 1);
}

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n' + passed + '/' + total + ' tests passed.');
if (failed > 0) process.exit(1);
