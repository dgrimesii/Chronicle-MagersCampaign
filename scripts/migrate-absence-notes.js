/**
 * scripts/migrate-absence-notes.js
 *
 * Moves player absences from the old PC-fact shape to session notes, and
 * raises the schema to 5.0.1 (issue #112).
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Session notes sometimes say a player was out and someone else ran their
 * character ("Lance out work, played by David"). The data recorded this as a
 * PC fact, { type: "player_absence", pc_id, note }, stored twice on each
 * session (in mechanics.player_absences and in mechanical_notes), and nothing
 * read it. The DM decided on 23 October 2026 that it is a session fact: a
 * plain sentence in session_logs[].narrative.absence_notes, with no pc_id.
 * A script rather than a hand edit, so the change can be re-run, reviewed and
 * counted.
 *
 * WHAT IT DOES (the DM's approved steps, #112)
 * ------------
 * 1. Copies each player_absence note, text unchanged, into that session's
 *    narrative.absence_notes (from mechanics.player_absences, and from
 *    mechanical_notes; the two hold the same sentence, which is kept once).
 * 2. Removes mechanics.player_absences from every session, including the
 *    empty ones.
 * 3. Removes the player_absence entries from mechanical_notes, leaving the
 *    array and any other entries in it alone (removing the array was not
 *    approved).
 * Then, for the schema: sets _schema_version to 5.0.1, documents
 * absence_notes in _field_type_reference.common_optional_fields, drops
 * player_absence from the mechanical_note_type enum (no entry uses it any
 * more), and sets meta.last_updated to today. A session with no absence gets
 * no absence_notes field (omitted, not empty).
 *
 * Idempotent: on a file already migrated it changes nothing but reports so.
 *
 * RUN
 * ---
 *   node scripts/migrate-absence-notes.js <campaign.json>           # dry run: report only
 *   node scripts/migrate-absence-notes.js <campaign.json> --write   # also rewrite the file
 *
 * Afterwards run node scripts/migrate-opaque-ids.js <campaign.json> --check;
 * it must print CHECK PASSED.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ---------------------------
 * tests/absence-notes.test.js requires it. Keep it until every campaign file
 * is on 5.0.1.
 */

'use strict';

const fs = require('fs');

const NEW_SCHEMA_VERSION = '5.0.1';

const ABSENCE_FIELD_DOC = 'ARRAY of STRING — on session_logs[].narrative only (schema 5.0.1, issue #112). ' +
  'Plain sentences recording that a player was absent and who ran their character, e.g. ' +
  '"Malachite piloted by David due to Lance\'s work schedule." A session note kept for the record, ' +
  'never a fact about a PC: no pc_id, nothing mechanical reads it. First names only. Omit when a session has no absence.';

/**
 * migrateCampaign(json, today) → { json, report }
 *
 * json   — the campaign object; a migrated deep copy is returned, the input
 *          is not changed.
 * today  — YYYY-MM-DD for meta.last_updated (tests pass a fixed date).
 * report — plain lines describing every change, for the DM to read.
 */
function migrateCampaign(input, today) {
  const json = JSON.parse(JSON.stringify(input));
  const report = [];
  for (const s of json.session_logs || []) {
    const label = s.legacy_id || s.title || s.id;
    const found = [];
    if (s.mechanics && 'player_absences' in s.mechanics) {
      for (const a of s.mechanics.player_absences || []) if (a && a.note) found.push(a.note);
      delete s.mechanics.player_absences;
      report.push(`${label}: removed mechanics.player_absences`);
    }
    if (Array.isArray(s.mechanical_notes)) {
      const before = s.mechanical_notes.length;
      for (const n of s.mechanical_notes) if (n && n.type === 'player_absence' && n.note) found.push(n.note);
      s.mechanical_notes = s.mechanical_notes.filter(n => !(n && n.type === 'player_absence'));
      if (s.mechanical_notes.length !== before) report.push(`${label}: removed ${before - s.mechanical_notes.length} player_absence entr${before - s.mechanical_notes.length === 1 ? 'y' : 'ies'} from mechanical_notes`);
    }
    // The same sentence was stored in both places; it is kept once, and
    // never added twice to a session that already has it.
    const unique = [...new Set(found)];
    if (unique.length) {
      s.narrative = s.narrative || {};
      const have = Array.isArray(s.narrative.absence_notes) ? s.narrative.absence_notes : [];
      const add = unique.filter(t => !have.includes(t));
      if (add.length) {
        s.narrative.absence_notes = have.concat(add);
        for (const t of add) report.push(`${label}: narrative.absence_notes ← "${t}"`);
      }
    }
  }
  if (json._schema_version !== NEW_SCHEMA_VERSION) {
    report.push(`_schema_version: ${json._schema_version} → ${NEW_SCHEMA_VERSION}`);
    json._schema_version = NEW_SCHEMA_VERSION;
  }
  const ref = json._field_type_reference;
  if (ref) {
    if (ref.common_optional_fields && ref.common_optional_fields.absence_notes !== ABSENCE_FIELD_DOC) {
      ref.common_optional_fields.absence_notes = ABSENCE_FIELD_DOC;
      report.push('_field_type_reference.common_optional_fields.absence_notes documented');
    }
    const types = ref.shared_enums && ref.shared_enums.mechanical_note_type;
    if (Array.isArray(types) && types.includes('player_absence')) {
      ref.shared_enums.mechanical_note_type = types.filter(t => t !== 'player_absence');
      report.push('_field_type_reference.shared_enums.mechanical_note_type: removed player_absence');
    }
  }
  if (report.length && json.meta) json.meta.last_updated = today;
  return { json, report };
}

module.exports = { migrateCampaign, NEW_SCHEMA_VERSION, ABSENCE_FIELD_DOC };

if (require.main === module) {
  const file = process.argv[2];
  const write = process.argv.includes('--write');
  if (!file) {
    console.error('Usage: node scripts/migrate-absence-notes.js <campaign.json> [--write]');
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  const { json, report } = migrateCampaign(JSON.parse(fs.readFileSync(file, 'utf8')), today);
  console.log(report.length ? report.join('\n') : 'Nothing to change: the file is already migrated.');
  if (write && report.length) {
    // The format the repo stores, so the diff shows only what changed.
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    console.log(`\nWrote ${file}.`);
  } else if (report.length) {
    console.log('\nDry run: nothing written. Add --write to apply.');
  }
}
