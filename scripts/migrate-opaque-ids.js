/**
 * scripts/migrate-opaque-ids.js
 *
 * Gives every campaign entity an opaque UUID and keeps its old typed ID as
 * legacy_id (issue #95), then checks that every reference resolves.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Storyteller's hosting plan (C15) requires opaque, non-sequential, type-free
 * IDs, and Chronicle adopts the same format (UUID v4, chosen by the DM on #95)
 * so the platform is consistent. The change touches every entity and every
 * reference to one, so it is a script: it can be dry-run, re-run, and its
 * reference check doubles as the phase 1 gate on #95.
 *
 * WHAT IT DOES
 * ------------
 * - Every object ChronicleIds.forEachEntity() visits (the entity arrays and
 *   quest objectives) gets id = a new UUID and legacy_id = its old id.
 * - Every string anywhere in the campaign data that exactly equals an old ID
 *   becomes the new UUID: actor_id, target_id, mon_ref, character_ids,
 *   holders, locations, session links, round sid, slot a, and any field added
 *   later. Prose that merely mentions an ID ("Killed by pc_006") is left as
 *   written; legacy_id still resolves it.
 * - Rewrites _id_registry (sequential counters no longer apply) and the ID
 *   lines of _field_type_reference, and sets meta.last_updated to today.
 * - Runs checkReferences() and prints the result. Exits 1 if any reference
 *   is broken or still a legacy ID.
 *
 * It is idempotent: an object that already has a legacy_id or a UUID id keeps
 * it, and the schema notes are rewritten only once, so a second run changes
 * nothing.
 *
 * RUN
 * ---
 *   node scripts/migrate-opaque-ids.js <campaign.json>            # dry run: report and check only
 *   node scripts/migrate-opaque-ids.js <campaign.json> --write    # also rewrite the file
 *   node scripts/migrate-opaque-ids.js <campaign.json> --check    # check references, change nothing
 *
 * WHAT WOULD BREAK IF REMOVED
 * ---------------------------
 * Nothing at runtime. tests/opaque-ids.test.js requires it for checkReferences(),
 * which is the scripted gate on #95. Keep it while any campaign file could
 * still hold typed IDs, and for --check after hand edits.
 */

'use strict';

const fs  = require('fs');
const Ids = require('../shared/chronicle-ids.js');

/**
 * assignIds(campaign) → Map of legacy ID → new UUID, for every entity that
 * did not have a UUID yet. Mutates the entities in place.
 *
 * Why the keys are re-ordered: id and legacy_id sit together at the top of
 * each object (after _object_type), so a person reading the JSON sees the
 * old name beside the new one. Without it legacy_id would land at the end of
 * large objects, far from the id it explains.
 */
function assignIds(campaign) {
  const assigned = new Map();
  Ids.forEachEntity(campaign, obj => {
    if (obj.legacy_id || Ids.isOpaqueId(obj.id)) return; // already migrated
    // An object with no id at all (the test fixture's objectives) is left
    // alone: #95 converts existing IDs, it does not invent identities.
    if (!obj.id) return;
    const legacy = obj.id;
    const fresh  = Ids.newId();
    const { _object_type, id, ...rest } = obj;
    // Empty and refill the same object, so the parent array keeps pointing at it.
    for (const k of Object.keys(obj)) delete obj[k];
    if (_object_type !== undefined) obj._object_type = _object_type;
    obj.id = fresh;
    if (legacy) obj.legacy_id = legacy;
    Object.assign(obj, rest);
    if (legacy) assigned.set(legacy, fresh);
  });
  return assigned;
}

/**
 * rewriteRefs(campaign, index) — replaces every exact legacy-ID string in the
 * campaign data with its UUID. Root keys starting with "_" are skipped: they
 * are schema documentation (_field_type_reference, _about), whose example
 * strings are not references.
 *
 * Why it walks everything instead of a field list: the survey for #95 found
 * about 70 reference fields, and new ones keep arriving. Walking the whole
 * tree cannot miss one. Only exact matches change, so prose is safe.
 */
function rewriteRefs(campaign, index) {
  for (const key of Object.keys(campaign)) {
    if (key.startsWith('_')) continue;
    campaign[key] = Ids.translateRefs(campaign[key], index);
  }
}

/**
 * updateSchemaDocs(campaign, today) — rewrites the parts of the data file
 * that describe IDs, so they no longer tell a reader to count upwards.
 *
 * Why: _id_registry held "next" counters (npc_015…). Following them after
 * #95 would mint typed IDs again. The voided list is kept, because the
 * legacy IDs it names must still never be reused as legacy IDs.
 */
function updateSchemaDocs(campaign, today) {
  const oldReg = campaign._id_registry || {};
  // Already rewritten by an earlier run: leave both blocks alone, or the old
  // formats would be wrapped a second time and the date would move.
  if (oldReg.format === 'uuid-v4') return;
  // mon_006 was voided by #94 (folded into Goblins) after the registry was
  // last updated by hand, so it is added here rather than read from it.
  const voided = [...new Set([...Object.values(oldReg).flatMap(r => (r && r.voided) || []), 'mon_006'])];
  campaign._id_registry = {
    _note: 'Since issue #95 (' + today + ') every entity id is a UUID v4, allocated with ChronicleIds.newId() ' +
      '(shared/chronicle-ids.js), never counted. The old typed ID is kept as legacy_id and is frozen: no new ' +
      'legacy IDs are assigned, except a session_NNN the DM supplies when a session is published.',
    format: 'uuid-v4',
    legacy_voided: voided,
  };
  const ref = campaign._field_type_reference;
  if (ref && ref.id_formats) {
    ref.id_formats = {
      _note: 'Issue #95. Every entity id is a lowercase UUID v4 (8-4-4-4-12 hex). The type lives in the array, never in the id.',
      id: 'UUID v4, e.g. 3f2b8c1e-9a4d-4c7e-b1f0-6d2a9e5c4b81',
      legacy_id: 'STRING — the typed ID the entity had before #95 (pc_001, npc_014, cbt_005, session_005, obj_003…). ' +
        'Frozen; kept so old notes and links still resolve. Absent on entities created after #95, except sessions, ' +
        'which keep the session_NNN the DM gives them.',
      _legacy_formats: ref.id_formats,
    };
  }
  if (campaign.meta) campaign.meta.last_updated = today;
}

/**
 * checkReferences(campaign) → { entities, references, broken[], legacy[],
 * duplicates[], badTargets[] }.
 *
 * The scripted gate on #95: every reference must resolve to an existing
 * opaque ID. Rules:
 * - every entity id is a UUID and unique;
 * - any UUID string anywhere (outside an entity's own id) names an entity;
 * - no string anywhere is still an exact legacy ID, except a legacy_id field;
 * - a combat outcome's target_id is an entity UUID, a roster actor_id of the
 *   same combat (enemies have no entity IDs yet), or null; an enemy turn's
 *   actor_id is a roster actor_id of the same combat.
 * Why separate from the migration: run with --check after any hand edit or
 * publish, and from the tests, without rewriting anything.
 */
function checkReferences(campaign) {
  const ids = new Set();
  const duplicates = [];
  let entities = 0;
  Ids.forEachEntity(campaign, (obj, arr) => {
    if (obj.id === undefined) return; // never had an id; nothing can point at it
    entities++;
    if (!Ids.isOpaqueId(obj.id)) duplicates.push(arr + ': id is not a UUID: ' + obj.id);
    else if (ids.has(obj.id)) duplicates.push(arr + ': duplicate id ' + obj.id);
    ids.add(obj.id);
  });

  const broken = [];
  const legacy = [];
  let references = 0;
  // Walk every value; path is kept for the report so a failure says where it is.
  function walk(v, p, ownerIsEntity) {
    if (typeof v === 'string') {
      if (Ids.isOpaqueId(v)) { references++; if (!ids.has(v)) broken.push(p + ' = ' + v); }
      else if (Ids.isLegacyId(v)) legacy.push(p + ' = ' + v);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']', false)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'legacy_id') continue;           // the frozen old name, not a reference
        if (k === 'id' && Ids.isOpaqueId(x)) continue; // an object's own id, not a reference
        walk(x, p + '.' + k, false);
      }
    }
  }
  for (const key of Object.keys(campaign)) {
    if (!key.startsWith('_')) walk(campaign[key], key, false);
  }

  // Combat targets and actors: the one place a reference may be a roster label.
  const badTargets = [];
  for (const c of campaign.combat_encounters || []) {
    // A combat with no roster at all (older test data) cannot be checked for
    // roster labels, so only its UUID references are checked, by the walk above.
    if (!Array.isArray(c.mechanics?.enemies_roster)) continue;
    const roster = new Set(c.mechanics.enemies_roster.map(g => g.actor_id));
    (c.rounds || []).forEach(r => {
      const where = (c.legacy_id || c.id) + ' r' + r.n;
      const checkOutcomes = acts => (acts || []).forEach(a => (a.outcomes || []).forEach(o => {
        const t = o.target_id;
        if (t !== null && t !== undefined && !ids.has(t) && !roster.has(t)) badTargets.push(where + ' target_id ' + t);
      }));
      (r.slots || []).forEach(s => checkOutcomes(s.activities));
      (r.enemy_turns || []).forEach(et => {
        if (!roster.has(et.actor_id)) badTargets.push(where + ' enemy actor_id ' + et.actor_id);
        checkOutcomes(et.activities);
      });
    });
  }

  return { entities, references, broken, legacy, duplicates, badTargets };
}

/** checkPassed(result) — true when checkReferences found nothing wrong. */
function checkPassed(r) {
  return !r.broken.length && !r.legacy.length && !r.duplicates.length && !r.badTargets.length;
}

/**
 * proseMentions(campaign) → number of strings that mention a legacy ID inside
 * longer text. Reported, never changed: rewriting prose to UUIDs would make
 * the notes unreadable, and legacy_id resolves them.
 */
function proseMentions(campaign) {
  let n = 0;
  const re = /\b(pc|npc|loc|qst|item|cbt|mon|lore|session|moment)_\d{3}\b/;
  (function walk(v) {
    if (typeof v === 'string') { if (!Ids.isLegacyId(v) && re.test(v)) n++; }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'legacy_id') walk(x); });
  })(Object.fromEntries(Object.entries(campaign).filter(([k]) => !k.startsWith('_'))));
  return n;
}

/**
 * migrateCampaign(campaign, today) → { assigned, result } after migrating the
 * campaign in place. Exported so the tests run the same code as the CLI.
 */
function migrateCampaign(campaign, today) {
  const assigned = assignIds(campaign);
  rewriteRefs(campaign, Ids.buildLegacyIndex(campaign));
  updateSchemaDocs(campaign, today);
  return { assigned, result: checkReferences(campaign) };
}

/** printCheck(result) — the check report, shared by --check and migration runs. */
function printCheck(r) {
  console.log('Entities: ' + r.entities + ' · UUID references checked: ' + r.references);
  const lists = [['Broken references', r.broken], ['Still a legacy ID', r.legacy],
                 ['Bad or duplicate entity ids', r.duplicates], ['Unresolved combat targets/actors', r.badTargets]];
  for (const [label, list] of lists) {
    console.log(label + ': ' + list.length);
    list.slice(0, 40).forEach(x => console.log('  ' + x));
    if (list.length > 40) console.log('  … ' + (list.length - 40) + ' more');
  }
  console.log(checkPassed(r) ? 'CHECK PASSED' : 'CHECK FAILED');
}

module.exports = { migrateCampaign, checkReferences, checkPassed, proseMentions };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const file  = process.argv[2];
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (!file) {
    console.error('Usage: node scripts/migrate-opaque-ids.js <campaign.json> [--write | --check]');
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const campaign = JSON.parse(text);

  if (check) {
    const r = checkReferences(campaign);
    printCheck(r);
    process.exit(checkPassed(r) ? 0 : 1);
  }

  // Local date, not UTC: the DM's "today" is what meta.last_updated records.
  const today = new Date().toLocaleDateString('en-CA');
  const { assigned, result } = migrateCampaign(campaign, today);
  console.log('IDs assigned: ' + assigned.size);
  console.log('Prose strings that mention a legacy ID (left as written): ' + proseMentions(campaign));
  printCheck(result);

  if (write) {
    // Keep the file's own line endings so the diff shows only real changes.
    const crlf = text.includes('\r\n');
    let out = JSON.stringify(campaign, null, 2) + '\n';
    if (crlf) out = out.replace(/\n/g, '\r\n');
    fs.writeFileSync(file, out);
    console.log('Wrote ' + file);
  } else {
    console.log('Dry run — nothing written. Add --write to rewrite the file.');
  }
  process.exit(checkPassed(result) ? 0 : 1);
}
