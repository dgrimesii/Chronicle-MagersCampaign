/**
 * tests/delta-apply.test.js — Group F
 *
 * Automated tests for:
 *   F-1 through F-4 — applyDeltasToCampaign() ROUND branch routing (issue #39)
 *   F-5 through F-7 — remainingRounds computation for partial gap fill (issue #38)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Issue #39 fixed a data-corruption bug where gap-approved round objects were
 * routed through the NEW branch of applyDeltasToCampaign(), appending them as
 * root-level combat entries. These tests verify the ROUND branch inserts rounds
 * into combat.rounds[] and that the NEW branch no longer accepts a gap-source item.
 *
 * Issue #38 added partial-fill tracking so AI fill calls target only rounds that
 * are still missing. These tests verify the remainingRounds computation is correct
 * under all relevant state combinations.
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

// ── Load test fixture ────────────────────────────────────────────────────────

const fixturePath = path.join(__dirname, 'fixtures', 'test-campaign.json');
const fixture     = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// ── applyDeltasToCampaign, cut from delta-review.html ────────────────────────
// Until issue #95 this file held a hand-kept copy of the function, which had
// drifted (it lacked the MOD, RELATIONSHIP and metadata code). It now cuts the
// real function, and its helper withOpaqueId, out of the page, the same way
// tests/turn-schema.test.js loads normaliseCampaignJson. The page's browser
// globals are passed in: deferredGaps (empty), a sessionStorage with no
// prompt-log entries, and ChronicleIds from shared/chronicle-ids.js.
const ChronicleIds = require('../shared/chronicle-ids.js');
function loadApplyDeltas() {
  const src   = fs.readFileSync(path.join(__dirname, '..', 'admin', 'delta-review.html'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function withOpaqueId');
  const fnAt  = src.indexOf('function applyDeltasToCampaign', start);
  const end   = src.indexOf('\n}\n', fnAt);
  if (start < 0 || fnAt < 0 || end < 0) throw new Error('applyDeltasToCampaign not found in delta-review.html');
  const sessionStorage = { getItem: () => null, removeItem: () => {} };
  return new Function('ChronicleIds', 'deferredGaps', 'sessionStorage',
    src.slice(start, end + 2) + '\nreturn applyDeltasToCampaign;')(ChronicleIds, [], sessionStorage);
}
const applyDeltasToCampaign = loadApplyDeltas();

// The fixture's entities have UUID ids since #95. L finds one by legacy ID.
const L = ChronicleIds.buildLegacyIndex(fixture);

// sameCampaign(a, b) — equal apart from the publish metadata that every
// publish stamps (_last_published, _delta_count). The old inline copy left
// those out, so "nothing changed" tests compared whole files.
function sameCampaign(a, b) {
  const strip = c => JSON.stringify(Object.assign({}, c, { _last_published: null, _delta_count: null }));
  return strip(a) === strip(b);
}

// ── Inline remainingRounds computation ───────────────────────────────────────
// Mirrors the logic in renderGapCard() and gapFillFromImage() / gapFillFromText().
// The gap object (g) and gap state (st) match the shapes those functions receive.

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
// Before issue #39 fix: type:'NEW' + array:'combat_encounters' pushed rawData
// as a new root combat entry. After fix: type:'ROUND' routes to the ROUND
// branch which inserts into the target combat's rounds[] array.

console.log('\nTest F-1 — ROUND delta inserts round into combat.rounds[]');
{
  // cbt_001 in the fixture has rounds 1, 2, 3. Add round 4.
  const newRound = { n: 4, slots: [], enemy_turns: [] };
  const delta = {
    type:     'ROUND',
    combatId: 'cbt_001',
    array:    'combat_encounters',
    rawData:  newRound,
    source:   'integrity',
    status:   'approved',
  };

  const result = applyDeltasToCampaign(fixture, [delta]);
  const cbt    = result.combat_encounters.find(c => c.id === L.get('cbt_001'));

  assert(
    'combat_encounters length unchanged (round not added as new combat entry)',
    result.combat_encounters.length === fixture.combat_encounters.length
  );
  assert(
    'cbt_001.rounds now contains round 4',
    cbt.rounds.some(r => r.n === 4)
  );
  assert(
    'cbt_001.rounds length increased by 1',
    cbt.rounds.length === fixture.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.length + 1
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-2 — ROUND delta keeps rounds sorted in ascending order
// ═══════════════════════════════════════════════════════════════════════════
// The ROUND branch sorts rounds after inserting so the viewer always gets
// them in round order regardless of insertion order.

console.log('\nTest F-2 — ROUND delta sorts rounds in ascending order after insert');
{
  // Insert round 2 into a campaign that has rounds 1 and 3 (simulating a gap fill).
  // Rounds are currently [1, 2, 3] in fixture — clone with only rounds 1 and 3.
  const campaignWithGap = JSON.parse(JSON.stringify(fixture));
  campaignWithGap.combat_encounters[0].rounds =
    campaignWithGap.combat_encounters[0].rounds.filter(r => r.n !== 2);

  const delta = {
    type:     'ROUND',
    combatId: 'cbt_001',
    array:    'combat_encounters',
    rawData:  { n: 2, slots: [], enemy_turns: [] },
    source:   'integrity',
    status:   'approved',
  };

  const result     = applyDeltasToCampaign(campaignWithGap, [delta]);
  const cbt        = result.combat_encounters.find(c => c.id === L.get('cbt_001'));
  const roundNums  = cbt.rounds.map(r => r.n);

  assert(
    'rounds are sorted [1, 2, 3] after gap fill',
    roundNums[0] === 1 && roundNums[1] === 2 && roundNums[2] === 3
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-3 — ROUND delta overwrites an existing round (upsert behaviour)
// ═══════════════════════════════════════════════════════════════════════════
// If the round number already exists in rounds[], the ROUND branch replaces
// it rather than duplicating it. This allows corrections to be applied.

console.log('\nTest F-3 — ROUND delta overwrites existing round (no duplicate)');
{
  const correctedRound = {
    n: 2,
    slots: [{ s: 1, a: 'pc_001', action: { name: 'CORRECTED', res: 'hit', val: 99 }, notes: null }],
    enemy_turns: [],
  };
  const delta = {
    type:     'ROUND',
    combatId: 'cbt_001',
    array:    'combat_encounters',
    rawData:  correctedRound,
    source:   'integrity',
    status:   'approved',
  };

  const result    = applyDeltasToCampaign(fixture, [delta]);
  const cbt       = result.combat_encounters.find(c => c.id === L.get('cbt_001'));
  const round2    = cbt.rounds.find(r => r.n === 2);
  const origCount = fixture.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.length;

  assert(
    'round count unchanged after overwrite (no duplicate added)',
    cbt.rounds.length === origCount
  );
  assert(
    'round 2 now has the corrected action name',
    round2?.slots?.[0]?.action?.name === 'CORRECTED'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-4 — NEW delta does NOT insert into rounds[] (regression guard)
// ═══════════════════════════════════════════════════════════════════════════
// This is the pre-#39 bug path. A delta with type:'NEW' + array:'combat_encounters'
// appends rawData as a new combat entry, not a round. This test confirms
// the fix (type:'ROUND') is the only path that goes to rounds[].

console.log('\nTest F-4 — NEW delta on combat_encounters appends new combat (not into rounds)');
{
  // Simulate the pre-fix shape: type:'NEW', array:'combat_encounters'.
  // rawData looks like a round object, not a combat — this was the bug.
  const roundLookingData = { n: 4, slots: [], enemy_turns: [] };
  const delta = {
    type:    'NEW',
    array:   'combat_encounters',
    rawData: roundLookingData, // no .id field — would be skipped by NEW duplicate check
    source:  'integrity',
    status:  'approved',
  };

  const result = applyDeltasToCampaign(fixture, [delta]);
  const cbt    = result.combat_encounters.find(c => c.id === L.get('cbt_001'));

  // NEW branch with no .id pushes directly — confirming NEW != ROUND routing
  assert(
    'NEW delta increases combat_encounters root length (not rounds)',
    result.combat_encounters.length > fixture.combat_encounters.length
  );
  assert(
    'cbt_001.rounds unchanged — round object went to root, not into rounds[]',
    cbt.rounds.length === fixture.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.length
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-5 — remainingRounds with no prior approvals returns all miss rounds
// ═══════════════════════════════════════════════════════════════════════════
// When no rounds have been approved yet, all missing rounds should be targets.

console.log('\nTest F-5 — remainingRounds returns all g.miss when no rounds approved yet');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = { approvedRounds: [] };

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds length === 3', remaining.length === 3);
  assert('round 4 is in remainingRounds', remaining.includes(4));
  assert('round 5 is in remainingRounds', remaining.includes(5));
  assert('round 6 is in remainingRounds', remaining.includes(6));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-6 — remainingRounds excludes already-approved rounds (partial fill)
// ═══════════════════════════════════════════════════════════════════════════
// After one round is approved, only the unapproved rounds should remain.
// This is the core of issue #38 — the edit panel and AI calls must not
// re-request rounds the DM already approved in this session.

console.log('\nTest F-6 — remainingRounds excludes approved rounds (partial fill state)');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = { approvedRounds: [4] }; // round 4 was already approved

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds length === 2', remaining.length === 2);
  assert('round 4 NOT in remainingRounds', !remaining.includes(4));
  assert('round 5 is in remainingRounds',  remaining.includes(5));
  assert('round 6 is in remainingRounds',  remaining.includes(6));
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-7 — remainingRounds returns empty array when all rounds are filled
// ═══════════════════════════════════════════════════════════════════════════
// All-approved state should yield an empty remainingRounds — the card
// transitions to 'pending-confirm' at this point.

console.log('\nTest F-7 — remainingRounds returns [] when all miss rounds are approved');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = { approvedRounds: [4, 5, 6] }; // all rounds approved

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds is empty', remaining.length === 0);
}

// ── F-8 — remainingRounds handles null/undefined gapState gracefully ─────────
// If gapStates[gapId] is undefined (e.g. gap card rendered before state init),
// remainingRounds should fall back to g.miss rather than throwing.

console.log('\nTest F-8 — remainingRounds returns g.miss when gapState is undefined');
{
  const g  = { id: 'g_cbt_001', miss: [4, 5, 6] };
  const st = undefined; // no state initialised yet

  const remaining = computeRemainingRounds(g, st);

  assert('remainingRounds equals g.miss when st is undefined', remaining.length === 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-9 — RAW delta item is silently skipped (regression guard, issue #70)
// ═══════════════════════════════════════════════════════════════════════════
// Before issue #70: approving a RAW OCR page item and publishing produced no
// change in the campaign JSON — applyDeltasToCampaign() has no RAW handler.
// This test locks in that behaviour so no future change accidentally causes
// RAW items to write garbage into an array.

console.log('\nTest F-9 — RAW delta item is silently skipped — nothing written to campaign');
{
  // Build a RAW delta item shaped exactly like the ones intake.html produces.
  // array is 'session_logs' because that is what sendToAnalysis() sets on these items.
  const rawDelta = {
    type:    'RAW',
    array:   'session_logs',
    status:  'approved',
    rawData: {
      page_index: 0,
      ocr_text:   'ROUND 1 [session: session_001]\nSlot 1: Gold — Firebolt, hit, 8\n',
      page_failed: false,
    },
  };

  const result = applyDeltasToCampaign(fixture, [rawDelta]);

  assert(
    'session_logs length unchanged — RAW item not appended as a new session entry',
    result.session_logs.length === fixture.session_logs.length
  );
  assert(
    'campaign JSON identical to input — RAW item produces no mutations',
    sameCampaign(fixture, result)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-10 — NEW delta with no id gets a UUID (issues #66, #95)
// ═══════════════════════════════════════════════════════════════════════════
// Before issue #66 cascade items arrived with no id and were pushed without
// one. #66 counted the next typed id (npc_004); since #95 every new entity
// gets an opaque UUID instead, and no legacy_id, so nothing is counted.

console.log('\nTest F-10 — NEW delta with no id gets a UUID');
{
  const cascadeNpc = {
    type:    'NEW',
    array:   'npc_directory',
    status:  'approved',
    rawData: { name: 'Barnes', type: 'npc', description: 'Mayor of Lake Town.' },
    // no id field — simulates a _buildCascadeItem() output
  };

  const result10a = applyDeltasToCampaign(fixture, [cascadeNpc]);
  const added10a  = result10a.npc_directory.find(n => n.name === 'Barnes');

  assert('F-10a: cascade NPC is added to npc_directory',
    result10a.npc_directory.length === fixture.npc_directory.length + 1);
  assert('F-10a: its id is a UUID', ChronicleIds.isOpaqueId(added10a?.id));
  assert('F-10a: it has no legacy_id (no typed IDs are minted after #95)', !!added10a && !('legacy_id' in added10a));
  assert('F-10a: the queue item itself is not modified', !('id' in cascadeNpc.rawData));

  const twice = applyDeltasToCampaign(fixture, [cascadeNpc, Object.assign({}, cascadeNpc, { rawData: { name: 'Delta' } })]);
  const ids   = twice.npc_directory.map(n => n.id);
  assert('F-10b: two new NPCs get two different ids', new Set(ids).size === ids.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-11 — NEW delta with unrecognised array is silently skipped (issue #68)
// ═══════════════════════════════════════════════════════════════════════════
// _buildCascadeItem() now returns null for unknown types (instead of routing
// them to 'locations' via the old || fallback). If a garbage item somehow slipped
// through into the approved list, applyDeltasToCampaign() provides a second
// safety layer: the '!out[arr]' guard skips any delta whose array key doesn't
// exist in the campaign object — so session_note, correction, etc. cannot land
// anywhere in the JSON.

console.log('\nTest F-11 — NEW delta with unrecognised array is silently skipped');
{
  // Simulate what the old fallback would produce if it were still active:
  // a NEW item routed to a made-up array name like 'session_note'.
  const garbageDelta = {
    type:    'NEW',
    array:   'session_note',   // not a key in any campaign JSON — old fallback target
    status:  'approved',
    rawData: { name: 'Session 006 — Lance absent', type: 'session_note', description: 'Malachite piloted by David.' },
  };

  const result = applyDeltasToCampaign(fixture, [garbageDelta]);

  assert(
    'locations[] unchanged — garbage item not appended',
    result.locations.length === fixture.locations.length
  );
  assert(
    'campaign JSON identical to input — unknown array produces no mutation',
    sameCampaign(fixture, result)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Group F-12 — legacy IDs in staged deltas are translated at publish (#95)
// ═══════════════════════════════════════════════════════════════════════════
// Intake and the AI name entities by legacy ID. Publish must write the UUIDs
// the data uses, or every new reference would resolve to nothing.

console.log('\nTest F-12 — legacy IDs and placeholders become UUIDs at publish');
{
  // F-12a: references inside a round (slot actor) and the round's combat.
  const round = { n: 4, slots: [{ s: 1, a: 'pc_001', activities: [], notes: null }], enemy_turns: [] };
  const r12a  = applyDeltasToCampaign(fixture, [{ type: 'ROUND', combatId: 'cbt_001', array: 'combat_encounters', rawData: round }]);
  const added = r12a.combat_encounters.find(c => c.id === L.get('cbt_001')).rounds.find(r => r.n === 4);
  assert('F-12a: round lands in cbt_001 (legacy combatId translated)', !!added);
  assert('F-12a: slot actor pc_001 written as its UUID', added?.slots[0].a === L.get('pc_001'));
  assert('F-12a: the queue item still says pc_001 (not mutated)', round.slots[0].a === 'pc_001');

  // F-12b: a combat created this publish, with its round queued before it.
  const r12b = applyDeltasToCampaign(fixture, [
    { type: 'ROUND', combatId: 'cbt_099', array: 'combat_encounters', rawData: { n: 1, slots: [], enemy_turns: [] } },
    { type: 'NEW', array: 'combat_encounters', rawData: { id: 'cbt_099', name: 'New Fight', rounds: [] } },
  ]);
  const fight = r12b.combat_encounters.find(c => c.name === 'New Fight');
  assert('F-12b: new combat gets a UUID', ChronicleIds.isOpaqueId(fight?.id));
  assert('F-12b: its placeholder is not kept as legacy_id', !!fight && !('legacy_id' in fight));
  assert('F-12b: the round queued before it found it', fight?.rounds.length === 1);

  // F-12c: a new session keeps the DM's session number as legacy_id, and a
  // reference to it elsewhere in the same publish is translated.
  const r12c = applyDeltasToCampaign(fixture, [
    { type: 'NEW', array: 'session_logs', rawData: { id: 'session_042', title: 'S42' } },
    { type: 'MOD', array: 'npc_directory', targetId: 'npc_001', rawData: { id: 'npc_001', last_seen: 'session_042' } },
  ]);
  const s42 = r12c.session_logs.find(s => s.title === 'S42');
  assert('F-12c: new session id is a UUID', ChronicleIds.isOpaqueId(s42?.id));
  assert('F-12c: new session keeps legacy_id session_042', s42?.legacy_id === 'session_042');
  const npc1 = r12c.npc_directory.find(n => n.id === L.get('npc_001'));
  assert('F-12c: MOD by legacy targetId patched the right NPC', npc1?.last_seen === s42?.id);

  // F-12d: a NEW delta for an entity that already exists is skipped.
  const r12d = applyDeltasToCampaign(fixture, [{ type: 'NEW', array: 'npc_directory', rawData: { id: 'npc_001', name: 'Dup' } }]);
  assert('F-12d: NEW with an existing legacy id adds nothing', r12d.npc_directory.length === fixture.npc_directory.length);

  // F-12e: relationship ids are UUIDs and their endpoints are translated.
  // The fixture has no entity_relationships array (publish skips a delta whose
  // array is missing), so this uses a copy that has an empty one, as the real
  // campaign file does.
  const withRels = Object.assign(JSON.parse(JSON.stringify(fixture)), { entity_relationships: [] });
  const r12e = applyDeltasToCampaign(withRels, [{ type: 'RELATIONSHIP', array: 'entity_relationships',
    rawData: { from_id: 'pc_001', to_id: 'npc_001', significance: 'significant_event' } }]);
  const rel = (r12e.entity_relationships || [])[0];
  assert('F-12e: relationship id is a UUID', ChronicleIds.isOpaqueId(rel?.id));
  assert('F-12e: endpoints translated', rel?.from_id === L.get('pc_001') && rel?.to_id === L.get('npc_001'));
}

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n' + passed + '/' + total + ' tests passed.');
if (failed > 0) process.exit(1);
