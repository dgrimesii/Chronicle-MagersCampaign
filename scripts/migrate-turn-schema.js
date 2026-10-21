/**
 * scripts/migrate-turn-schema.js
 *
 * Converts combat rounds from the 4.x slot shape to the 5.0.0 turn schema
 * (issue #93, docs/intake-redesign.md "What a turn holds").
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * A 4.x slot has five fixed fields (action, bonus_action, reaction, movement,
 * object_interaction), and multi-attack actions carry an attacks[] list. The
 * redesign replaces them with one activities[] list, each activity tagged by
 * the action economy it spends and holding outcomes[] for each roll or target.
 * The 42 recorded rounds convert mechanically, so the conversion is a script
 * rather than hand edits: it can be re-run, reviewed, and its counts checked.
 *
 * WHAT IT DOES
 * ------------
 * - Every party slot:  { s, a, action, bonus_action, reaction, movement,
 *   object_interaction, notes }  →  { s, a, activities[], notes }
 * - Every enemy turn:  { actor_id, initiative_position, action, bonus_action,
 *   reaction, movement, special_events, notes }  →
 *   { actor_id, activities[], special_events, notes }
 *   (initiative_position is dropped: enemies have no initiative slots in 5.0.0,
 *   and it was null on every recorded turn.)
 * - Targets: a slash-joined 4.x target ("pc_001/pc_005") becomes one outcome
 *   per target; an entity ID or roster actor_id goes in target_id; any other
 *   target ("horse") goes in target_text with target_id null. Outcomes an
 *   earlier run of this script wrote unsplit are repaired the same way.
 * - Applies the DM's per-round decisions from #93 (EFFECT_DECISIONS,
 *   expandNoteTargets), to the Magers campaign file only, and lists the
 *   standing REVIEW_ITEMS the DM asked to see until they are resolved.
 * - Sets _schema_version to 5.0.0 and meta.last_updated to today.
 * - Reports inconsistencies it finds, and never fixes them (issue #93 scope),
 *   except where a DM decision above says otherwise.
 * - Prints before/after counts per economy, of roll results and of enemy turns,
 *   and exits 1 if they do not match.
 *
 * It is idempotent: a slot or enemy turn that already has activities[] is left
 * alone, so running it twice changes nothing the second time.
 *
 * RUN
 * ---
 *   node scripts/migrate-turn-schema.js <campaign.json>           # dry run: report and counts only
 *   node scripts/migrate-turn-schema.js <campaign.json> --write   # also rewrite the file
 *
 * WHAT WOULD BREAK IF REMOVED
 * ---------------------------
 * Nothing at runtime: the viewers read the converted data, not this script.
 * tests/turn-schema.test.js requires it to check the conversion rules. Keep it
 * until every campaign file (including tests/fixtures/test-campaign.json) is on
 * 5.0.0 and #92's publish writes the new shape directly.
 */

'use strict';

const fs = require('fs');

const NEW_SCHEMA_VERSION = '5.0.0';

// The twelve standard actions from the 2024 rules, as the design names them.
// An action activity whose old name matches one of these keeps it as its name;
// anything else (for example "Move") is kept verbatim and reported.
const STANDARD_ACTIONS = ['Attack', 'Dash', 'Disengage', 'Dodge', 'Help', 'Hide',
  'Influence', 'Magic', 'Ready', 'Search', 'Study', 'Utilize'];

// 4.x attacks[] labels that are not attack names (DM ruling on #93):
// "Attack"/"attacks" only restate that the activity is an Attack, and
// "hit"/"hits" is a result, already held in the outcome's res. Neither is
// carried into the outcome's detail. Every other label, including the
// unexplained "s", is kept as recorded.
const NOT_AN_ATTACK_NAME = /^(attacks?|hits?)$/i;

// What counts as an entity ID in target_id. Anything else the notes named
// as a target ("horse") is not an entity, so it goes in target_text instead
// and target_id stays null — the DM's decision on #93: never invent an ID.
const ENTITY_ID = /^(pc|npc|mon|loc|item|qst|cbt|lore|fac|coh|session|moment)_\d+$/;

/**
 * targetFields(raw, roster) → { target_id, target_text? }
 *
 * Turns one recorded target into outcome fields. An entity ID, or the
 * actor_id of one of this combat's enemies_roster groups (enemies have no
 * entity IDs until #95), goes in target_id. Any other text is kept exactly as
 * written in target_text, with target_id null. Changing this changes what
 * every outcome points at.
 */
function targetFields(raw, roster) {
  const t = raw == null ? null : String(raw).trim();
  if (!t) return { target_id: null };
  if (ENTITY_ID.test(t) || (roster || []).includes(t)) return { target_id: t };
  return { target_id: null, target_text: t };
}

/**
 * splitTargets(raw) → string[]
 * 4.x stored several targets of one roll as "pc_001/pc_005". Each becomes its
 * own outcome (DM decision on #93). A single target returns a one-item list.
 */
function splitTargets(raw) {
  if (raw == null || String(raw).trim() === '') return [null];
  return String(raw).split('/').map(s => s.trim()).filter(Boolean);
}

/**
 * outcomeFromAttack(att, roster, where, report) → outcome
 *
 * Converts one 4.x attacks[] entry into a 5.0.0 outcome. res, val and target_id
 * are schema fields, so they are always present (null when unknown), following
 * CLAUDE.md's null-vs-absent rule. The entry's name becomes the outcome's own
 * optional detail — the attack used (Bite, Claw), which overrides the
 * activity's detail, so one Multiattack can hold a claw and a bite with
 * separate targets (DM decision on #93). Labels that are not attack names
 * (NOT_AN_ATTACK_NAME) are left out. A "hits" label on a roll whose res is not
 * hit would contradict the result, so that case is reported. notes carries the
 * entry's note.
 */
function outcomeFromAttack(att, roster, where, report) {
  const out = { res: att.res ?? null, val: att.val ?? null, ...targetFields(att.target, roster) };
  const label = (att.name || '').trim();
  if (label && !NOT_AN_ATTACK_NAME.test(label)) out.detail = label;
  if (/^hits?$/i.test(label) && out.res !== 'hit') {
    report.push(`${where}: attack label "${label}" on a roll recorded as ${out.res}`);
  }
  if (att.notes) out.notes = att.notes;
  return out;
}

/**
 * outcomesFor(old, where, report) → outcome[]
 *
 * Builds an activity's outcomes from a 4.x action object.
 * - attacks[] present: one outcome per attack (the action's own res is then a
 *   summary, so it is not copied; if it was set, that is reported).
 * - res 'neutral' or null with no value: no roll was made or none recorded, so
 *   the activity has no outcomes (the design: "an activity with no roll has no
 *   outcomes"). A null result is reported because it may be a missing roll.
 * - otherwise: one outcome from the action's own res, val and target.
 * Death saves change res from hit/miss to success/failure, as the design
 * specifies; that is a relabel of the same fact, not a correction.
 */
function outcomesFor(old, where, report, roster) {
  if (Array.isArray(old.attacks) && old.attacks.length) {
    if (old.res != null || old.val != null) {
      report.push(`${where}: "${old.name}" has attacks[] and its own res/val (${old.res}, ${old.val}); kept the attacks, dropped the summary`);
    }
    // The per-attack targets are the specific record; an action-level target
    // such as "party" only summarised them, so it is dropped and reported.
    if (old.target && old.attacks.some(a => a.target)) {
      report.push(`${where}: action target "${old.target}" dropped; the per-attack targets replace it`);
    }
    return old.attacks.map(a => outcomeFromAttack(a, roster, where, report));
  }
  if ((old.res == null || old.res === 'neutral') && old.val == null) {
    if (old.res == null) report.push(`${where}: "${old.name}" has no result recorded; converted with no outcomes`);
    if (old.target) report.push(`${where}: "${old.name}" had target "${old.target}" but no roll; target not kept as an outcome`);
    return [];
  }
  let res = old.res ?? null;
  if (old.type === 'death_save') res = res === 'hit' ? 'success' : res === 'miss' ? 'failure' : res;
  return splitOutcome({ res, val: old.val ?? null, target_id: old.target ?? null }, where, report, roster);
}

/**
 * splitOutcome(outcome, where, report, roster) → outcome[]
 *
 * Applies the two target rules to one outcome whose target_id may still hold
 * raw 4.x text: a slash-joined target becomes one outcome per target, each
 * with the same res (val becomes null, since one number cannot belong to every
 * target; it was null in every recorded case, and a non-null one is reported),
 * and a non-ID target moves to target_text. Used both while converting 4.x
 * data and to repair outcomes an earlier run of this script wrote unsplit.
 */
function splitOutcome(outcome, where, report, roster) {
  const parts = splitTargets(outcome.target_id);
  if (parts.length > 1 && outcome.val != null) {
    report.push(`${where}: value ${outcome.val} on split target "${outcome.target_id}" set to null on each part`);
  }
  return parts.map(p => {
    const o = { ...outcome, val: parts.length > 1 ? null : outcome.val };
    delete o.target_id;
    delete o.target_text;
    // Keep field order res, val, target_id, target_text, then the optional rest.
    const { res, val, ...rest } = o;
    return { res, val, ...targetFields(p ?? outcome.target_text ?? null, roster), ...rest };
  });
}

/**
 * nameAndDetail(old, economy, where, report) → { name, detail? }
 *
 * Splits a 4.x action name into the 5.0.0 activity name and optional detail.
 * For the action economy the name is a standard action and the spell or weapon
 * becomes the detail (Magic · Firebolt, Attack · Longsword). For other
 * economies the design names the feature or spell itself (Healing Word as a
 * bonus action), so the old name is kept. The mapping goes by the 4.x type
 * field, which is mechanical; where the type looks wrong, it is reported and
 * not fixed.
 */
function nameAndDetail(old, economy, where, report) {
  const raw = (old.name || '').trim();
  if (economy !== 'action') return { name: raw || 'Unknown' };

  switch (old.type) {
    case 'spell':
      return { name: 'Magic', detail: raw };
    case 'attack':
      // "Attack" alone adds nothing as a detail.
      return raw.toLowerCase() === 'attack' ? { name: 'Attack' } : { name: 'Attack', detail: raw };
    case 'death_save':
      return { name: 'Death Save' };
    case 'other': {
      // "No Action", "None" and "Stable" all mean the creature could not act.
      // The design records that as No Action with the reason when there is one.
      if (/^(no action|none)$/i.test(raw)) return { name: 'No Action' };
      return { name: 'No Action: ' + raw };
    }
    case 'ability': {
      const ready = raw.match(/^ready:\s*(.+)$/i);
      if (ready) return { name: 'Ready', detail: ready[1].trim() };
      const std = STANDARD_ACTIONS.find(a => a.toLowerCase() === raw.toLowerCase());
      if (std) return { name: std };
      report.push(`${where}: action "${raw}" is not a standard action; kept as its own name`);
      return { name: raw };
    }
    case undefined:
    case null: {
      // Older or hand-written data (the test fixture) has no type at all.
      // A standard action name stands on its own; anything else is most
      // likely a weapon, so it is assumed to be an Attack and reported.
      const std = STANDARD_ACTIONS.find(a => a.toLowerCase() === raw.toLowerCase());
      if (std) return { name: std };
      report.push(`${where}: action "${raw}" has no type; assumed Attack`);
      return { name: 'Attack', detail: raw };
    }
    default:
      report.push(`${where}: action "${raw}" has unknown type "${old.type}"; kept as its own name`);
      return { name: raw };
  }
}

/**
 * activityFrom(old, economy, where, report) → activity
 *
 * Converts one 4.x action-economy object into a 5.0.0 activity. Optional fields
 * (detail, val_type, notes) are omitted when empty, as CLAUDE.md requires for
 * fields that do not apply. val_type falls back to the attacks' own val_type
 * when the action did not set one, so a multi-attack keeps "damage".
 */
function activityFrom(old, economy, where, report, roster) {
  const act = { economy, ...nameAndDetail(old, economy, where, report) };
  if (act.detail === '' || act.detail == null) delete act.detail;

  const attackTypes = [...new Set((old.attacks || []).map(a => a.val_type).filter(Boolean))];
  const valType = old.val_type ?? (attackTypes.length === 1 ? attackTypes[0] : null);
  if (valType) act.val_type = valType;

  act.outcomes = outcomesFor(old, where, report, roster);
  if (old.notes) act.notes = old.notes;
  checkAttackCount(old, act, where, report);
  return act;
}

/**
 * checkAttackCount(old, act, where, report)
 *
 * Reports actions whose name states how many attacks were made ("3 Melee
 * Attacks", "Punch x2", "Melee (2 hits)") when the outcomes recorded differ.
 * This is the check the issue asks for (cbt_002 round 4: Goli's "3 Melee
 * Attacks" has two attacks recorded). It only reports.
 */
function checkAttackCount(old, act, where, report) {
  const name = old.name || '';
  const m = name.match(/(\d+)\s*(?:melee\s+|unarmed\s+)?(?:attacks|hits)\b/i) || name.match(/x\s*(\d+)\b/i);
  if (!m) return;
  const stated = Number(m[1]);
  if (stated !== act.outcomes.length) {
    report.push(`${where}: "${name}" states ${stated} attacks but ${act.outcomes.length} result${act.outcomes.length === 1 ? ' is' : 's are'} recorded`);
  }
}

/**
 * activitiesFrom(turn, economies, where, report) → activity[]
 *
 * Walks a slot's or enemy turn's fixed economy fields in their usual order and
 * converts each one that was used. A 4.x movement or object_interaction was a
 * plain string; it becomes an activity named by that string with no outcomes.
 * object_interaction maps to the free economy, as the design's table does.
 */
function activitiesFrom(turn, economies, where, report, roster) {
  const out = [];
  for (const [field, economy] of economies) {
    const old = turn[field];
    if (old == null) continue;
    if (typeof old === 'string') {
      out.push({ economy, name: old, outcomes: [] });
      // A move logged under both action and movement reads as two activities;
      // the old notes may have meant one. Report it so a person can decide.
      if (field === 'movement' && turn.action && turn.action.name === old) {
        report.push(`${where}: movement "${old}" repeats the action's name; kept both`);
      }
      continue;
    }
    out.push(activityFrom(old, economy, `${where} ${field}`, report, roster));
  }
  return out;
}

const SLOT_ECONOMIES = [
  ['action', 'action'], ['bonus_action', 'bonus_action'], ['reaction', 'reaction'],
  ['movement', 'movement'], ['object_interaction', 'free'],
];
const ENEMY_ECONOMIES = [
  ['action', 'action'], ['bonus_action', 'bonus_action'], ['reaction', 'reaction'],
  ['movement', 'movement'],
];

/**
 * convertSlot(slot, where, report) → 5.0.0 slot
 * Keeps s, a and notes; replaces the five economy fields with activities[].
 */
function convertSlot(slot, where, report, roster) {
  if (Array.isArray(slot.activities)) return repairTargets(slot, where, report, roster);
  return { s: slot.s, a: slot.a, activities: activitiesFrom(slot, SLOT_ECONOMIES, where, report, roster), notes: slot.notes ?? null };
}

/**
 * repairTargets(turn, where, report, roster) → turn
 *
 * For a slot or enemy turn already in 5.0.0 shape: re-applies the target
 * rules to every outcome. Needed because the first version of this script
 * (before the DM's #93 target decisions) copied "pc_001/pc_005" and "horse"
 * into target_id. Idempotent: a split, ID-only outcome passes through as is.
 */
function repairTargets(turn, where, report, roster) {
  for (const act of turn.activities) {
    act.outcomes = act.outcomes.flatMap(o => splitOutcome(o, where, report, roster));
  }
  return turn;
}

/**
 * convertEnemyTurn(et, where, report) → 5.0.0 enemy turn
 * One turn per roster group per round, holding every activity of the group.
 * special_events and notes are kept unchanged: the viewers show them, and
 * moving a "downed" event onto a specific outcome would be a guess.
 */
function convertEnemyTurn(et, where, report, roster) {
  if (Array.isArray(et.activities)) return repairTargets(et, where, report, roster);
  if (et.initiative_position != null) {
    report.push(`${where}: initiative_position ${et.initiative_position} dropped (enemies have no initiative slots)`);
  }
  return {
    actor_id: et.actor_id,
    activities: activitiesFrom(et, ENEMY_ECONOMIES, where, report, roster),
    special_events: et.special_events ?? [],
    notes: et.notes ?? null,
  };
}

/**
 * countTurns(json) → { action, bonus_action, …, rolls, enemy_turns }
 *
 * Counts the same facts in either shape, so the before/after comparison proves
 * nothing was lost or duplicated. "rolls" counts every recorded result per
 * target: each attacks[] entry, or one per target for an action whose own res
 * is not neutral/null (4.x); each outcome (5.0.0). A slash-joined target
 * ("pc_001/pc_005") counts once per target in both shapes, so splitting it into
 * outcomes is count-neutral and the check still catches a real loss.
 */
function countTurns(json) {
  const c = { action: 0, bonus_action: 0, reaction: 0, movement: 0, free: 0, rolls: 0, enemy_turns: 0, rounds: 0 };
  const perTarget = t => splitTargets(t).length;
  const count4 = (turn, economies) => {
    for (const [field, economy] of economies) {
      const v = turn[field];
      if (v == null) continue;
      c[economy]++;
      if (typeof v === 'object') {
        if (Array.isArray(v.attacks) && v.attacks.length) c.rolls += v.attacks.length;
        else if (!((v.res == null || v.res === 'neutral') && v.val == null)) c.rolls += perTarget(v.target);
      }
    }
  };
  const count5 = turn => {
    for (const a of turn.activities) {
      c[a.economy] = (c[a.economy] || 0) + 1;
      for (const o of a.outcomes) c.rolls += perTarget(o.target_id);
    }
  };
  for (const cbt of json.combat_encounters || []) {
    for (const r of cbt.rounds || []) {
      c.rounds++;
      for (const s of r.slots || []) Array.isArray(s.activities) ? count5(s) : count4(s, SLOT_ECONOMIES);
      for (const e of r.enemy_turns || []) { c.enemy_turns++; Array.isArray(e.activities) ? count5(e) : count4(e, ENEMY_ECONOMIES); }
    }
  }
  return c;
}

// ── DM decisions (issue #93) ──────────────────────────────────────────────────
// Per-round choices the DM made after reviewing the enemy-target check on #93.
// They are not general rules, so each is listed here by combat, round and
// actor. Each one checks that the data is in the shape it expects before
// changing anything, and does nothing if it has already been applied, so the
// script stays safe to re-run. A decision whose expected shape is missing is
// reported, never forced.

/**
 * hasCombat(json, cbt) → boolean
 * True when the file has that combat. Lets the DM decisions skip files they
 * were never meant for, instead of reporting them as failures.
 */
function hasCombat(json, cbt) {
  return (json.combat_encounters || []).some(c => c.id === cbt);
}

/**
 * turnOf(json, cbt, n, actor) → { round, turn } or null
 * Finds an enemy turn (actor = roster actor_id) or a party slot (actor =
 * pc_NNN) in one round.
 */
function turnOf(json, cbt, n, actor) {
  const round = (json.combat_encounters || []).find(c => c.id === cbt)?.rounds?.find(r => r.n === n);
  if (!round) return null;
  const turn = /^pc_\d+$/.test(actor) ? round.slots.find(s => s.a === actor) : round.enemy_turns.find(e => e.actor_id === actor);
  return turn && Array.isArray(turn.activities) ? { round, turn } : null;
}

/**
 * attachEffect(json, d, applied, report)
 *
 * Puts d.effect ('downed' or 'killed') on the one outcome of d.actor's turn
 * that matches d.target, optionally setting that outcome's target first
 * (d.setTarget, used for the Ogre, whose kill is recorded on a party slot
 * with no target). Then removes the special_events entry that recorded the
 * same fact, so it lives in one place (DM decision). Changes nothing unless
 * exactly one outcome matches and the event is still present or the effect is
 * already set.
 */
function attachEffect(json, d, applied, report) {
  // These decisions are about the Magers campaign only. A file without this
  // combat (the test fixture, synthetic test data) is simply not affected.
  if (!hasCombat(json, d.cbt)) return;
  const where = `${d.cbt} r${d.n} ${d.actor}`;
  const found = turnOf(json, d.cbt, d.n, d.actor);
  if (!found) { report.push(`${where}: DM decision "${d.label}" not applied — turn not found`); return; }
  const outs = found.turn.activities.flatMap(a => a.outcomes);
  const matches = outs.filter(o => d.setTarget ? (o.target_id === null || o.target_id === d.setTarget) : (o.target_id ?? o.target_text) === d.target);
  if (matches.length !== 1) { report.push(`${where}: DM decision "${d.label}" not applied — ${matches.length} matching outcomes`); return; }
  const o = matches[0];
  if (o.effect === d.effect) return; // already applied on an earlier run
  if (d.setTarget) o.target_id = d.setTarget;
  o.effect = d.effect;
  const evTurn = turnOf(json, d.cbt, d.n, d.eventActor || d.actor).turn;
  const before = evTurn.special_events.length;
  evTurn.special_events = evTurn.special_events.filter(ev => ev.description !== d.eventDescription);
  if (evTurn.special_events.length === before) report.push(`${where}: "${d.label}" applied, but special_events entry "${d.eventDescription}" was not found to remove`);
  applied.push(`${where}: ${d.label}`);
}

const EFFECT_DECISIONS = [
  { cbt: 'cbt_001', n: 2, actor: 'Vespon Queen', target: 'pc_004', effect: 'downed',
    eventDescription: 'pc_004 downed by Sonic Buzz (12 dmg)', label: 'pc_004 outcome → effect downed' },
  { cbt: 'cbt_005', n: 2, actor: 'Goblin Slingers', target: 'pc_004', effect: 'downed',
    eventDescription: 'pc_004 (Del) downed by Goblin Slinger', label: 'pc_004 outcome → effect downed' },
  { cbt: 'cbt_003', n: 7, actor: 'Axe Beaks', target: 'horse', effect: 'killed',
    eventDescription: 'Both horses killed', label: 'horse outcome → effect killed' },
  { cbt: 'cbt_003', n: 7, actor: 'Axe Beaks', target: 'pc_004', effect: 'downed',
    eventDescription: 'pc_004 (Del) downed', label: 'pc_004 outcome → effect downed' },
  // Second round of DM approvals on #93: each has exactly one outcome on the
  // downed PC, and the event's ID and name agree.
  { cbt: 'cbt_002', n: 7, actor: 'Rock Lobsters', target: 'pc_004', effect: 'downed',
    eventDescription: 'pc_004 (Del) downed', label: 'pc_004 outcome → effect downed' },
  { cbt: 'cbt_002', n: 12, actor: 'Rock Lobsters', target: 'pc_003', effect: 'downed',
    eventDescription: 'pc_003 (Ash) downed', label: 'pc_003 outcome → effect downed' },
  { cbt: 'cbt_002', n: 14, actor: 'Rock Lobsters', target: 'pc_006', effect: 'downed',
    eventDescription: 'pc_006 (Atti) downed', label: 'pc_006 outcome → effect downed' },
  { cbt: 'cbt_003', n: 9, actor: 'Vespon Swarm', target: 'pc_003', effect: 'downed',
    eventDescription: 'pc_003 (Ash) downed', label: 'pc_003 outcome → effect downed' },
  // The event sits on the Ogre's own turn but names Atti's Ice Knife (slot 3)
  // as the kill, so the effect goes on Atti's outcome, targeting the Ogre's
  // roster actor_id.
  { cbt: 'cbt_005', n: 3, actor: 'pc_006', setTarget: 'Ogre', effect: 'killed', eventActor: 'Ogre',
    eventDescription: 'Ogre killed by pc_006 Ice Knife (slot 3) this round', label: 'Ice Knife outcome → target Ogre, effect killed' },
];

/**
 * expandNoteTargets(json, applied, report)
 *
 * cbt_002 round 4: the Rock Lobsters' one recorded hit has no target, but its
 * note says "Hits on Goli, Del, Mal". The DM decided this becomes three hit
 * outcomes (Goli pc_005, Del pc_004, Mal pc_002), values unknown, note kept.
 * Applies only while the turn still has exactly one untargeted outcome.
 */
function expandNoteTargets(json, applied, report) {
  if (!hasCombat(json, 'cbt_002')) return; // not the Magers campaign file
  const found = turnOf(json, 'cbt_002', 4, 'Rock Lobsters');
  const act = found?.turn.activities[0];
  if (act && act.outcomes.length === 3 && act.outcomes.every(o => o.target_id)) return; // already applied
  if (!act || act.outcomes.length !== 1 || act.outcomes[0].target_id !== null || act.outcomes[0].res !== 'hit') {
    report.push('cbt_002 r4 Rock Lobsters: DM decision "three outcomes from the note" not applied — shape not as expected');
    return;
  }
  act.outcomes = ['pc_005', 'pc_004', 'pc_002'].map(id => ({ res: 'hit', val: null, target_id: id }));
  applied.push('cbt_002 r4 Rock Lobsters: one untargeted hit → hits on pc_005 (Goli), pc_004 (Del), pc_002 (Mal), from the note');
}

/**
 * repeatTargets(json, applied, report)
 *
 * cbt_002 rounds 13 and 15: the Rock Lobsters' "Melee (x2)" was stored as one
 * hit on Malachite (pc_002), but the notes say "2 hits on Malachite" and "Hit
 * twice on Malachite". DM rule on #93: one outcome per attack, even when the
 * target repeats, so each becomes two hits on pc_002. Applies only while the
 * turn still has exactly one hit on pc_002.
 */
function repeatTargets(json, applied, report) {
  for (const n of [13, 15]) {
    if (!hasCombat(json, 'cbt_002')) return;
    const act = turnOf(json, 'cbt_002', n, 'Rock Lobsters')?.turn.activities[0];
    const os = act?.outcomes || [];
    if (os.length === 2 && os.every(o => o.target_id === 'pc_002' && o.res === 'hit')) continue; // already applied
    if (os.length !== 1 || os[0].target_id !== 'pc_002' || os[0].res !== 'hit') {
      report.push(`cbt_002 r${n} Rock Lobsters: DM decision "two hits on pc_002" not applied — shape not as expected`);
      continue;
    }
    act.outcomes = [{ ...os[0] }, { ...os[0] }];
    applied.push(`cbt_002 r${n} Rock Lobsters: "Melee (x2)" one hit on pc_002 → two hits on pc_002`);
  }
}

// Items the DM asked to see on every run until they are resolved outside this
// script. Each is reported only while the data still shows it.
const REVIEW_ITEMS = [
  {
    present: json => turnOf(json, 'cbt_003', 5, 'Axe Beaks')?.turn.notes?.includes('swarm attacks each horse'),
    text: 'cbt_003 r5: Axe Beaks note "1 swarm attacks each horse (2 total). Del hit." looks like the Vespon Swarm\'s turn, which has one horse outcome but notes "2 separate swarm attacks". Left as is — DM to check the session_004 notes.',
  },
  {
    present: json => !!turnOf(json, 'cbt_002', 6, 'Rock Lobsters'),
    text: 'cbt_002 r6: IDs and names disagree. The event "pc_001 (Goli) downed" and "pc_005 (Del) at 1HP" (pc_001 is Goldie, pc_005 is Goli); mechanics.pcs_downed records Del\'s round 7 down twice (pc_005 "Del at 1HP Round 6, then DOWNED Round 7" and pc_004 "DOWNED Round 7") and pc_001 "Goli DOWNED Round 6"; and the round 6 hit targets pc_001 and pc_005. Slot data (pc_005 death saves from r7, pc_004 from r8, pc_001 acting every round) supports the names. IDs not changed — DM to check against the notes and file a separate data fix.',
  },
];

/**
 * applyDmDecisions(json, report) → applied[]
 * Runs the #93 DM decisions in order and adds the standing review items to the
 * report. Returns a description of each change made on this run.
 */
function applyDmDecisions(json, report) {
  const applied = [];
  // The decisions name rounds of the Magers campaign. The test fixture reuses
  // IDs such as cbt_001 for unrelated synthetic combats, so checking IDs alone
  // would report false failures there; check the campaign itself.
  if (json.meta?.campaign_name !== 'Magers Campaign') return applied;
  expandNoteTargets(json, applied, report);
  repeatTargets(json, applied, report);
  for (const d of EFFECT_DECISIONS) attachEffect(json, d, applied, report);
  for (const item of REVIEW_ITEMS) if (item.present(json)) report.push('REVIEW: ' + item.text);
  return applied;
}

/**
 * migrateCampaign(json, today) → { json, report, before, after, applied }
 *
 * Converts every round of every combat and returns the new campaign object
 * (the input is not modified), the inconsistency report, both counts, and the
 * DM decisions applied. The counts are taken before the DM decisions, so they
 * prove the mechanical conversion lost and duplicated nothing; the decisions
 * then add outcomes on purpose (cbt_002 r4) and are listed separately.
 * today is passed in, not read from the clock, so tests get a fixed date.
 */
function migrateCampaign(input, today) {
  const json = JSON.parse(JSON.stringify(input));
  const report = [];
  const before = countTurns(json);

  for (const cbt of json.combat_encounters || []) {
    // Roster actor_ids are valid target_id values for this combat only.
    const roster = (cbt.mechanics?.enemies_roster || []).map(g => g.actor_id);
    for (const r of cbt.rounds || []) {
      const where = `${cbt.id} r${r.n}`;
      r.slots = (r.slots || []).map(s => convertSlot(s, `${where} ${s.a}`, report, roster));
      r.enemy_turns = (r.enemy_turns || []).map(e => convertEnemyTurn(e, `${where} ${e.actor_id}`, report, roster));
    }
  }
  const after = countTurns(json);
  const applied = applyDmDecisions(json, report);

  json._schema_version = NEW_SCHEMA_VERSION;
  if (json.meta) json.meta.last_updated = today;

  return { json, report, before, after, applied };
}

/**
 * countsMatch(before, after) → boolean
 * True when every economy, the roll count and the enemy turn count agree.
 */
function countsMatch(before, after) {
  return ['action', 'bonus_action', 'reaction', 'movement', 'free', 'rolls', 'enemy_turns', 'rounds']
    .every(k => (before[k] || 0) === (after[k] || 0));
}

module.exports = { migrateCampaign, countTurns, countsMatch, NEW_SCHEMA_VERSION };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const file = process.argv[2];
  const write = process.argv.includes('--write');
  if (!file) {
    console.error('Usage: node scripts/migrate-turn-schema.js <campaign.json> [--write]');
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Local date, not UTC: toISOString() would record tomorrow's date for an
  // evening run in the Americas. en-CA formats as YYYY-MM-DD.
  const today = new Date().toLocaleDateString('en-CA');
  const { json, report, before, after, applied } = migrateCampaign(input, today);

  console.log(`Schema: ${input._schema_version} → ${json._schema_version}`);
  console.log('Counts (conversion only, before DM decisions)');
  console.log('              before  after');
  for (const k of Object.keys(before)) console.log(`  ${k.padEnd(12)}${String(before[k]).padStart(5)}${String(after[k] || 0).padStart(7)}`);
  console.log(`\nDM decisions applied this run: ${applied.length}`);
  applied.forEach(line => console.log('  + ' + line));
  console.log(`\nInconsistencies found (reported, not fixed): ${report.length}`);
  report.forEach(line => console.log('  - ' + line));

  if (!countsMatch(before, after)) {
    console.error('\nCOUNTS DO NOT MATCH — file not written.');
    process.exit(1);
  }
  if (write) {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    console.log(`\nWrote ${file}`);
  } else {
    console.log('\nDry run — pass --write to rewrite the file.');
  }
}
