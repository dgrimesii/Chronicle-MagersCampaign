/**
 * tests/turn-schema.test.js
 *
 * Tests for the 5.0.0 turn schema migration (issue #93):
 *   - scripts/migrate-turn-schema.js conversion rules, on synthetic 4.x rounds
 *   - the converted data/magers-campaign.json (every round converted, counts)
 *   - the normaliseCampaignJson() viewers in admin/log-viewer.html and
 *     player/index.html, run in Node against the real data
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The migration rewrote all 42 recorded rounds. These tests pin down each
 * conversion rule so a re-run cannot silently change meaning, prove the
 * campaign file holds no 4.x slots, and check the issue's acceptance items
 * for the viewers (cbt_002 and cbt_005 render with no "undefined", Ched's
 * death still visible) without needing a browser. They also prove the two
 * normalisers produce the same combats, which CLAUDE.md requires.
 *
 * LOAD NOTE
 * ---------
 * normaliseCampaignJson lives inside each HTML page's script. The test cuts
 * the function's source out of the page text and evaluates it on its own. It
 * uses no DOM or globals, so this runs the page's real code, not a copy.
 *
 * RUN
 * ---
 * node tests/turn-schema.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { migrateCampaign, countTurns, countsMatch } = require('../scripts/migrate-turn-schema.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

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
 * act4(fields) — a 4.x action record with every field present, as the real
 * data has them. Tests pass only the fields they care about.
 */
function act4(fields) {
  return Object.assign({ name: null, type: null, res: null, val: null, val_type: null, target: null, attacks: null, notes: null }, fields);
}

/**
 * slot4(s, a, economy) — a 4.x slot; economy fields default to null.
 */
function slot4(s, a, fields) {
  return Object.assign({ s, a, action: null, bonus_action: null, reaction: null, movement: null, object_interaction: null, notes: null }, fields);
}

/**
 * campaignWith(slots, enemyTurns) — the smallest campaign object the
 * migration accepts: one combat with one round.
 */
function campaignWith(slots, enemyTurns) {
  return {
    _schema_version: '4.1.0',
    meta: { last_updated: '2026-01-01' },
    combat_encounters: [{ id: 'cbt_t', rounds: [{ n: 1, sid: 'session_t', slots, enemy_turns: enemyTurns || [] }] }],
  };
}

/**
 * loadNormaliser(file) → normaliseCampaignJson function from that page.
 * Cuts from "function normaliseCampaignJson" to the first line that is a
 * lone closing brace at column 0, which ends the function in both pages.
 */
function loadNormaliser(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function normaliseCampaignJson');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('normaliseCampaignJson not found in ' + file);
  return new Function(src.slice(start, end + 2) + '\nreturn normaliseCampaignJson;')();
}

// ── Test T-1 — action names split into name and detail by type ───────────────
console.log('\nTest T-1 — action economy: standard action name, spell or weapon as detail');
{
  const { json } = migrateCampaign(campaignWith([
    slot4(1, 'pc_001', { action: act4({ name: 'Firebolt', type: 'spell', res: 'hit', val: 7, val_type: 'damage' }) }),
    slot4(2, 'pc_002', { action: act4({ name: 'Longsword', type: 'attack', res: 'miss' }) }),
    slot4(3, 'pc_003', { action: act4({ name: 'Attack', type: 'attack', res: 'hit' }) }),
    slot4(4, 'pc_004', { action: act4({ name: 'Ready: Firebolt', type: 'ability', res: 'neutral' }) }),
    slot4(5, 'pc_005', { action: act4({ name: 'Disengage', type: 'ability', res: 'neutral' }) }),
  ]), '2026-10-20');
  const [s1, s2, s3, s4, s5] = json.combat_encounters[0].rounds[0].slots.map(s => s.activities[0]);

  assert('spell → Magic with the spell as detail', s1.name === 'Magic' && s1.detail === 'Firebolt');
  assert('val_type kept on the activity',          s1.val_type === 'damage');
  assert('single result → one outcome',            s1.outcomes.length === 1 && s1.outcomes[0].res === 'hit' && s1.outcomes[0].val === 7);
  assert('outcome has target_id (null when unknown)', Object.prototype.hasOwnProperty.call(s1.outcomes[0], 'target_id') && s1.outcomes[0].target_id === null);
  assert('weapon attack → Attack · Longsword',     s2.name === 'Attack' && s2.detail === 'Longsword');
  assert('plain "Attack" gets no detail',          s3.name === 'Attack' && !('detail' in s3));
  assert('"Ready: X" → Ready with X as detail',    s4.name === 'Ready' && s4.detail === 'Firebolt');
  assert('neutral with no value → no outcomes',    s4.outcomes.length === 0 && s5.outcomes.length === 0);
  assert('standard ability keeps its name',        s5.name === 'Disengage');
  assert('optional fields omitted when empty',     !('notes' in s2) && !('val_type' in s2));
}

// ── Test T-2 — turns that don't go to plan ───────────────────────────────────
console.log('\nTest T-2 — death saves, No Action, and conditions');
{
  const { json } = migrateCampaign(campaignWith([
    slot4(1, 'pc_001', { action: act4({ name: 'Death Save', type: 'death_save', res: 'hit' }) }),
    slot4(2, 'pc_002', { action: act4({ name: 'Death Save', type: 'death_save', res: 'miss' }) }),
    slot4(3, 'pc_003', { action: act4({ name: 'None', type: 'other', res: 'neutral' }) }),
    slot4(4, 'pc_004', { action: act4({ name: 'Stable', type: 'other', res: 'neutral' }) }),
  ]), '2026-10-20');
  const [d1, d2, n1, n2] = json.combat_encounters[0].rounds[0].slots.map(s => s.activities[0]);

  assert('death save hit → success',   d1.name === 'Death Save' && d1.outcomes[0].res === 'success');
  assert('death save miss → failure',  d2.outcomes[0].res === 'failure');
  assert('"None" → No Action',         n1.name === 'No Action' && n1.outcomes.length === 0);
  assert('"Stable" → No Action: Stable', n2.name === 'No Action: Stable');
}

// ── Test T-3 — attacks[] become outcomes ─────────────────────────────────────
console.log('\nTest T-3 — attacks[] → outcomes[], keeping targets and real labels');
{
  const { json, report } = migrateCampaign(campaignWith([
    slot4(1, 'pc_005', { action: act4({ name: '3 Melee Attacks', type: 'attack', attacks: [
      { name: 'Attacks', res: 'hit', val: null, val_type: null, target: null, notes: null },
      { name: 'Attacks', res: 'hit', val: null, val_type: null, target: null, notes: null },
    ] }) }),
  ], [
    { actor_id: 'ROUS', initiative_position: null, bonus_action: null, reaction: null, movement: null, special_events: [], notes: null,
      action: act4({ name: 'Pack attacks', type: 'attack', attacks: [
        { name: 'Bite', res: 'hit', val: 10, val_type: 'damage', target: 'pc_001', notes: null },
        { name: 'Attack', res: 'miss', val: null, val_type: null, target: null, notes: 'Nat 1' },
      ] }) },
  ]), '2026-10-20');
  const slotAct  = json.combat_encounters[0].rounds[0].slots[0].activities[0];
  const enemyAct = json.combat_encounters[0].rounds[0].enemy_turns[0].activities[0];

  assert('one outcome per attack entry',          slotAct.outcomes.length === 2);
  // DM rule on #93: an attacks[].name becomes the outcome's own detail,
  // except labels that are not attack names: "Attack"/"Attacks" restate the
  // activity, and "hits" is a result already held in res.
  assert('"Attacks" label not carried as detail',  !('detail' in slotAct.outcomes[0]) && !('notes' in slotAct.outcomes[0]));
  assert('target becomes target_id',              enemyAct.outcomes[0].target_id === 'pc_001');
  assert('attack name "Bite" → outcome detail',   enemyAct.outcomes[0].detail === 'Bite' && !('notes' in enemyAct.outcomes[0]));
  assert('per-roll note "Nat 1" kept; "Attack" label not a detail', enemyAct.outcomes[1].notes === 'Nat 1' && !('detail' in enemyAct.outcomes[1]));

  // "hits" on a roll that missed contradicts the result, so it is reported;
  // the unexplained label "s" is kept as recorded.
  const odd = migrateCampaign(campaignWith([
    slot4(1, 'pc_004', { action: act4({ name: '2 attacks', type: 'attack', attacks: [
      { name: 'hits', res: 'miss', val: null, val_type: null, target: null, notes: null },
      { name: 's', res: 'hit', val: 6, val_type: 'damage', target: null, notes: null },
    ] }) }),
  ]), '2026-10-20');
  const oddOuts = odd.json.combat_encounters[0].rounds[0].slots[0].activities[0].outcomes;
  assert('"hits" label on a miss is reported',     odd.report.some(l => l.includes('attack label "hits" on a roll recorded as miss')));
  assert('"s" kept as outcome detail',             oddOuts[1].detail === 's' && !('detail' in oddOuts[0]));
  assert('val_type lifted from the attacks',      enemyAct.val_type === 'damage');
  assert('stated-count mismatch reported',        report.some(l => l.includes('"3 Melee Attacks" states 3 attacks but 2')));
}

// ── Test T-3b — enemy targets (DM decisions on #93) ──────────────────────────
// Enemy targets live in action.target, sometimes slash-joined ("pc_001/pc_005"),
// and in attacks[].target. Each target becomes its own outcome; an ID or a
// roster actor_id goes in target_id; anything else ("horse") goes in
// target_text with target_id null, so no ID is ever invented.
console.log('\nTest T-3b — enemy targets: split, IDs, roster actors, target_text');
{
  const input = campaignWith([
    slot4(1, 'pc_006', { action: act4({ name: 'Ice Knife', type: 'spell', res: 'hit', val: 8, target: 'Ogre' }) }),
  ], [
    { actor_id: 'Rock Lobsters', initiative_position: null, bonus_action: null, reaction: null, movement: null, special_events: [], notes: null,
      action: act4({ name: 'Melee', type: 'attack', res: 'hit', target: 'pc_001/pc_005' }) },
    { actor_id: 'Axe Beaks', initiative_position: null, bonus_action: null, reaction: null, movement: null, special_events: [], notes: null,
      action: act4({ name: 'Melee', type: 'attack', res: 'hit', target: 'horse/pc_004' }) },
    { actor_id: 'ROUS', initiative_position: null, bonus_action: null, reaction: null, movement: null, special_events: [], notes: null,
      action: act4({ name: 'Pack', type: 'attack', res: 'hit', target: 'party', attacks: [
        { name: 'Bite', res: 'hit', val: 10, val_type: 'damage', target: 'pc_001', notes: null },
      ] }) },
  ]);
  input.combat_encounters[0].mechanics = { enemies_roster: [{ actor_id: 'Ogre' }, { actor_id: 'Rock Lobsters' }] };
  const { json, report, before, after } = migrateCampaign(input, '2026-10-20');
  const r = json.combat_encounters[0].rounds[0];
  const outs = actor => r.enemy_turns.find(e => e.actor_id === actor).activities[0].outcomes;

  assert('slash target → one outcome per target',      outs('Rock Lobsters').map(o => o.target_id).join() === 'pc_001,pc_005');
  assert('split outcomes copy res, val null',          outs('Rock Lobsters').every(o => o.res === 'hit' && o.val === null));
  const ab = outs('Axe Beaks');
  assert('"horse" → target_text, target_id null',      ab[0].target_id === null && ab[0].target_text === 'horse');
  assert('ID part of the same split keeps target_id',  ab[1].target_id === 'pc_004' && !('target_text' in ab[1]));
  assert('roster actor_id is a valid target_id',       r.slots[0].activities[0].outcomes[0].target_id === 'Ogre');
  assert('per-attack target kept, "party" dropped',    outs('ROUS').length === 1 && outs('ROUS')[0].target_id === 'pc_001');
  assert('dropped "party" target reported',            report.some(l => l.includes('action target "party" dropped')));
  assert('splitting is count-neutral',                 countsMatch(before, after) && before.rolls === 6);
}

// ── Test T-4 — other economies, enemy turns, idempotence ─────────────────────
console.log('\nTest T-4 — bonus action, movement, enemy turns, and re-running');
{
  const input = campaignWith([
    slot4(1, 'pc_006', {
      action: act4({ name: 'Move', type: 'ability', res: 'neutral' }),
      bonus_action: act4({ name: 'HW', type: 'spell', res: 'hit', val: 4, val_type: 'healing' }),
      movement: 'Move',
    }),
  ], [
    { actor_id: 'Goblins', initiative_position: null, action: null, bonus_action: null, reaction: null,
      movement: 'Goblins advance', special_events: [{ type: 'downed', description: 'pc_004 downed' }], notes: 'n' },
  ]);
  const { json, report, before, after } = migrateCampaign(input, '2026-10-20');
  const slot = json.combat_encounters[0].rounds[0].slots[0];
  const et   = json.combat_encounters[0].rounds[0].enemy_turns[0];

  assert('activities in economy order',            slot.activities.map(a => a.economy).join() === 'action,bonus_action,movement');
  assert('bonus-action spell keeps the spell as its name', slot.activities[1].name === 'HW' && !('detail' in slot.activities[1]));
  assert('movement string → movement activity, no outcomes', slot.activities[2].name === 'Move' && slot.activities[2].outcomes.length === 0);
  assert('old economy fields removed from the slot', !('action' in slot) && !('bonus_action' in slot) && !('movement' in slot));
  assert('non-standard action reported',           report.some(l => l.includes('"Move" is not a standard action')));
  assert('enemy initiative_position dropped',      !('initiative_position' in et));
  assert('enemy special_events kept',              et.special_events.length === 1 && et.notes === 'n');
  assert('enemy movement → activity',              et.activities[0].economy === 'movement');
  assert('schema version set to 5.0.0',            json._schema_version === '5.0.0');
  assert('meta.last_updated set to the given date', json.meta.last_updated === '2026-10-20');
  assert('input object not modified',              input._schema_version === '4.1.0' && 'action' in input.combat_encounters[0].rounds[0].slots[0]);
  assert('counts match before and after',          countsMatch(before, after));

  const again = migrateCampaign(json, '2026-10-20');
  assert('second run changes nothing',             JSON.stringify(again.json) === JSON.stringify(json) && again.report.length === 0);
}

// ── Test T-5 — the converted campaign file ───────────────────────────────────
console.log('\nTest T-5 — data/magers-campaign.json is fully on 5.0.0');
const campaign = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'magers-campaign.json'), 'utf8'));
// Since issue #95 entity ids are UUIDs. These tests name entities by their
// legacy ID (pc_004, cbt_002), which is how the DM's decisions were written:
// L turns a legacy ID into the UUID, R turns a UUID back for comparisons.
const L = require('../shared/chronicle-ids.js').buildLegacyIndex(campaign);
const R = new Map([...L].map(([legacy, id]) => [id, legacy]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
{
  const rounds = campaign.combat_encounters.flatMap(c => c.rounds);
  const slots  = rounds.flatMap(r => r.slots);
  const ets    = rounds.flatMap(r => r.enemy_turns);
  const counts = countTurns(campaign);

  // 5.0.1 (#112) keeps the 5.0.0 turn schema and adds narrative.absence_notes.
  assert('_schema_version is 5.0.1 (the turn schema plus #112)', campaign._schema_version === '5.0.1');
  assert('42 rounds',                                rounds.length === 42);
  assert('249 party slots, all with activities[]',   slots.length === 249 && slots.every(s => Array.isArray(s.activities)));
  assert('34 enemy turns, all with activities[]',    ets.length === 34 && ets.every(e => Array.isArray(e.activities)));
  assert('no 4.x economy field left anywhere',       ![...slots, ...ets].some(t => ['action', 'bonus_action', 'reaction', 'movement', 'object_interaction', 'initiative_position'].some(f => f in t)));
  // These totals are the scripted before-count from the 4.1.0 file (issue #93
  // acceptance): 280 actions, 3 bonus actions, 7 movements, and 280 results
  // counted per target (276 rolls, 4 of them on two targets each). The DM's
  // cbt_002 r4 decision then turns one hit into three (+2), and the r13/r15
  // "Melee (x2)" decision turns one hit into two each (+2), so 284 outcomes.
  assert('activity and roll counts match the 4.1.0 totals', counts.action === 280 && counts.bonus_action === 3 && counts.movement === 7 && counts.rolls === 284);
  assert('one enemy turn per roster group per round', rounds.every(r => new Set(r.enemy_turns.map(e => e.actor_id)).size === r.enemy_turns.length));
}

// ── Test T-8 — DM target and effect decisions in the real data ───────────────
console.log('\nTest T-8 — enemy targets and effects in data/magers-campaign.json');
{
  const turn = (cbt, n, actor) => {
    const r = campaign.combat_encounters.find(c => c.legacy_id === cbt).rounds.find(x => x.n === n);
    return /^pc_/.test(actor) ? r.slots.find(s => s.a === L.get(actor)) : r.enemy_turns.find(e => e.actor_id === actor);
  };
  const outs = t => t.activities.flatMap(a => a.outcomes);
  const ids = t => outs(t).map(o => (R.get(o.target_id) ?? o.target_id) ?? '#' + o.target_text).join();
  const allOuts = campaign.combat_encounters.flatMap(c => {
    const roster = (c.mechanics.enemies_roster || []).map(g => g.actor_id);
    return c.rounds.flatMap(r => [...r.slots, ...r.enemy_turns]).flatMap(outs).map(o => ({ o, roster }));
  });

  assert('every target_id is an entity ID, a roster actor, or null',
    allOuts.every(({ o, roster }) => o.target_id === null || (UUID.test(o.target_id) && R.has(o.target_id)) || roster.includes(o.target_id)));
  assert('target_text only where target_id is null', allOuts.every(({ o }) => !('target_text' in o) || o.target_id === null));
  assert('cbt_002 r6 split → pc_001, pc_005',  ids(turn('cbt_002', 6, 'Rock Lobsters')) === 'pc_001,pc_005');
  assert('cbt_002 r10 split → pc_001, pc_003', ids(turn('cbt_002', 10, 'Rock Lobsters')) === 'pc_001,pc_003');
  assert('cbt_002 r12 split → pc_006, pc_003', ids(turn('cbt_002', 12, 'Rock Lobsters')) === 'pc_006,pc_003');
  assert('cbt_003 r7 split → horse (text), pc_004', ids(turn('cbt_003', 7, 'Axe Beaks')) === '#horse,pc_004');
  assert('cbt_002 r4 note → hits on pc_005, pc_004, pc_002, note kept',
    ids(turn('cbt_002', 4, 'Rock Lobsters')) === 'pc_005,pc_004,pc_002' && /Goli, Del, Mal/.test(turn('cbt_002', 4, 'Rock Lobsters').notes));

  // Repeated target (DM rule 6): one outcome per attack even on the same target.
  for (const n of [13, 15]) {
    const os = outs(turn('cbt_002', n, 'Rock Lobsters'));
    assert(`cbt_002 r${n} "Melee (x2)" → two hits on pc_002`, os.length === 2 && os.every(o => o.target_id === L.get('pc_002') && o.res === 'hit'));
  }
  // Outcome-level detail (DM rule 7): each 4.x attacks[].name came through.
  assert('cbt_004 r3 ROUS: four outcomes with detail "Bite"', outs(turn('cbt_004', 3, 'ROUS')).map(o => o.detail).join() === 'Bite,Bite,Bite,Bite');
  assert('cbt_005 r2 Goblins: two outcomes with detail "Melee"', outs(turn('cbt_005', 2, 'Goblins')).map(o => o.detail).join() === 'Melee,Melee');

  const eff = (t, target) => outs(t).find(o => ((R.get(o.target_id) ?? o.target_id) ?? o.target_text) === target)?.effect;
  const events = t => t.special_events.map(e => e.description);
  assert('cbt_001 r2 pc_004 downed, event removed',  eff(turn('cbt_001', 2, 'Vespon Queen'), 'pc_004') === 'downed' && events(turn('cbt_001', 2, 'Vespon Queen')).length === 0);
  assert('cbt_005 r2 pc_004 downed, event removed',  eff(turn('cbt_005', 2, 'Goblin Slingers'), 'pc_004') === 'downed' && events(turn('cbt_005', 2, 'Goblin Slingers')).length === 0);
  assert('cbt_003 r7 horse killed, pc_004 downed, both events removed',
    eff(turn('cbt_003', 7, 'Axe Beaks'), 'horse') === 'killed' && eff(turn('cbt_003', 7, 'Axe Beaks'), 'pc_004') === 'downed' && events(turn('cbt_003', 7, 'Axe Beaks')).length === 0);
  assert('cbt_005 r3 Ice Knife → target Ogre, killed; event removed',
    eff(turn('cbt_005', 3, 'pc_006'), 'Ogre') === 'killed' && events(turn('cbt_005', 3, 'Ogre')).length === 0);
  // Second round of approvals: four more single-outcome downs.
  assert('cbt_002 r7/r12/r14 and cbt_003 r9 downs on their outcomes, events removed',
    [['cbt_002', 7, 'Rock Lobsters', 'pc_004'], ['cbt_002', 12, 'Rock Lobsters', 'pc_003'], ['cbt_002', 14, 'Rock Lobsters', 'pc_006'], ['cbt_003', 9, 'Vespon Swarm', 'pc_003']]
      .every(([c, n, a, pc]) => eff(turn(c, n, a), pc) === 'downed' && !events(turn(c, n, a)).some(d => d.includes('downed'))));
  assert('exactly 9 outcome effects in the file', allOuts.filter(({ o }) => o.effect).length === 9);
  assert('only cbt_002 r6 and the familiar remain as down/kill events',
    campaign.combat_encounters.flatMap(c => c.rounds.flatMap(r => r.enemy_turns.flatMap(e => e.special_events)))
      .filter(ev => /downed|eliminated|killed/i.test(ev.type + ' ' + ev.description)).map(ev => ev.description).join('|') === "pc_001 (Goli) downed|Del's familiar (Deer) killed");
  assert('unmatched: Del\'s familiar stays in special_events', events(turn('cbt_004', 4, 'ROUS')).includes("Del's familiar (Deer) killed"));
  assert('cbt_002 r6 event left as recorded (IDs not changed)', events(turn('cbt_002', 6, 'Rock Lobsters')).includes('pc_001 (Goli) downed'));

  const again = migrateCampaign(campaign, campaign.meta.last_updated);
  assert('re-running applies no further DM decisions', again.applied.length === 0 && JSON.stringify(again.json.combat_encounters) === JSON.stringify(campaign.combat_encounters));
  assert('re-run still lists both review items', again.report.filter(l => l.startsWith('REVIEW:')).length === 2);
}

// ── Test T-6 — both viewers render the converted combats ─────────────────────
console.log('\nTest T-6 — log-viewer and player normalisers on the real data');
{
  const adminView  = loadNormaliser('admin/log-viewer.html')(campaign);
  const playerView = loadNormaliser('player/index.html')(campaign);

  for (const [label, view] of [['admin', adminView], ['player', playerView]]) {
    const cbt2 = view.combats.find(c => c.id === L.get('cbt_002'));
    const cbt5 = view.combats.find(c => c.id === L.get('cbt_005'));
    const text = c => JSON.stringify(c.rounds.map(r => [r.slots.map(s => [s.act, s.res, s.val, s.notes]), r.enemy.map(e => [e.desc, e.impact])]));

    assert(label + ': cbt_002 has all 19 rounds',          cbt2.rounds.length === 19);
    assert(label + ': cbt_002 slots and enemies have no undefined', !text(cbt2).includes('undefined'));
    assert(label + ': cbt_005 has no undefined',           !text(cbt5).includes('undefined'));
    // Ched's death is recorded in round 19's summary, which the round viewer
    // shows; the round remap must still carry round-level fields through.
    const r19 = cbt2.rounds.find(r => r.n === 19);
    assert(label + ': Ched\'s death in cbt_002 round 19',  /Ched Warmfire confirmed dead/.test(r19?.summary || ''));
    const r4 = cbt2.rounds.find(r => r.n === 4);
    assert(label + ': cbt_002 r4 Goli shows the action',   r4.slots.find(s => s.a === L.get('pc_005')).act === '3 Melee Attacks');
    assert(label + ': single-outcome result still shown',  r4.slots.find(s => s.a === L.get('pc_001')).res === 'hit');
    // cbt_002 r4 now has three outcomes (DM decision), so no single result is shown.
    assert(label + ': enemy turn lists its activity',      r4.enemy[0].desc === 'Rock Lobsters: Melee');
    // Downs and kills moved from special_events to outcome effects must still
    // appear where the viewer showed them before.
    const cbt1 = view.combats.find(c => c.id === L.get('cbt_001'));
    // The target is named by nickname since #95 (target_id is a UUID).
    assert(label + ': cbt_001 r2 enemy impact shows Del downed', cbt1.rounds.find(r => r.n === 2).enemy[0].impact === 'Del downed');
    const c5r3 = cbt5.rounds.find(r => r.n === 3);
    assert(label + ': cbt_005 r3 Atti\'s notes show Ogre killed',  /Ogre killed$/.test(c5r3.slots.find(s => s.a === L.get('pc_006')).notes));
    const c3r7 = view.combats.find(c => c.id === L.get('cbt_003')).rounds.find(r => r.n === 7);
    assert(label + ': cbt_003 r7 impact shows horse killed and Del downed', c3r7.enemy[0].impact === 'horse killed; Del downed');
  }

  assert('admin and player combats are identical',
    JSON.stringify(adminView.combats) === JSON.stringify(playerView.combats));
}

// ── Test T-7 — the 4.x shim is gone, and a turn with no list still renders ───
// Until #92 this test proved the viewers still read 4.x slots, because publish
// wrote them. #92 rebuilt publish to write activities[] and removed the shim
// from both normalisers, as this test's old note asked. What remains to check
// is that a slot or enemy turn with no activities list (hand-edited data) shows
// as an empty turn instead of breaking the combat viewer.
console.log('\nTest T-7 — a turn with no activities list renders as empty (4.x shim removed, #92)');
{
  const bare = {
    party: [], session_logs: [],
    combat_encounters: [{ id: 'cbt_t', name: 'T', mechanics: {}, narrative: {}, rounds: [{ n: 1,
      slots: [{ s: 1, a: 'x', notes: null }], enemy_turns: [{ actor_id: 'Goblins', special_events: [] }] }] }],
  };
  for (const file of ['admin/log-viewer.html', 'player/index.html']) {
    const r = loadNormaliser(file)(bare).combats[0].rounds[0];
    assert(file + ': slot with no activities shows "—" and no result', r.slots[0].act === '—' && r.slots[0].res === null);
    assert(file + ': enemy turn with no activities shows its group only', r.enemy[0].desc === 'Goblins' && r.enemy[0].impact === null);
    // Code only: the comments that record the shim's removal mention the old
    // field names, so line comments are dropped before searching.
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert(file + ': no 4.x slot.action / et.action read left in the normaliser', !/slot\.action\b|et\.action\b/.test(code));
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
