/**
 * shared/chronicle-corrections.js — window.ChronicleCorrections
 *
 * The rules for what an applied correction in Delta Review may change (#128).
 *
 * WHY THIS EXISTS
 * ---------------
 * The session 6 publish held "Larkspur Larkspur Dragon Lair" and "CANCEL a
 * CANCEL location entry". A short correction on one card was registered as a
 * name and replaced across every other card, including text already correct
 * and text that was an instruction to the reviewer. Corrections on entity
 * cards were also stored as literal fields ("narrative.description", "op")
 * or not stored at all. These rules live here, not in the page, so
 * tests/corrections.test.js runs the real code.
 *
 * Also holds the rules for what a card may propose: unique ids (#125), duplicates
 * (#131), descriptions (#123, #126), treasure (#122) and combat status (#127).
 *
 * No dependencies, DOM, storage or network. Delta Review is its only user;
 * delete this module with that page when phase 7 retires it (#121 P7-1).
 *
 * If removed: Delta Review cannot apply a correction, because applyDiff(),
 * applyGlobalCorrection() and propagateGroundTruth() all call it.
 */

(function(root) {
  'use strict';

  // Prose fields describe events rather than name things, so a short change to
  // one ("fallen" to "dead") must never spread as if it were a name.
  const CONTENT_FIELDS = new Set(['description', 'notes', 'summary', 'motivation', 'aftermath',
    'setup', 'finale', 'background', 'content', 'entry', 'session_notes']);

  // In a round only these fields hold names worth spreading. The others hold
  // controlled words ("action", "hit") that appear in every round.
  const ROUND_NAME_FIELDS = new Set(['act', 'action', 'desc', 'description']);

  // Top-level keys that are commands to the review, not fields of any record.
  // Session 6 published "op": "delete" and "action": "CANCEL" on a bestiary entry.
  const COMMAND_KEYS = new Set(['op', 'action', 'status']);

  // Operations the round code in the page applies itself.
  const ROUND_OPS = new Set(['reorder', 'add_slot']);

  // Fields that hold a reference. Changing one here would break the link to the
  // record it points at, as goblin-1 becoming Goblins-1 did in the reproduction.
  const REFERENCE_FIELDS = new Set(['id', 'legacy_id', 'mon_ref', 'sid', 'session_id', 'combat_id',
    'combatId', 'targetId', 'current_holder', 'first_appeared', 'last_appeared', 'origin_session', 'given_by']);

  // Fields holding a fixed vocabulary. A name correction never applies to them.
  const VOCABULARY_FIELDS = new Set(['_object_type', 'type', 'economy', 'res', 'result', 'action_type',
    'val_type', 'effect', 'status', 'disposition', 'reliability', 'visibility']);

  // Fields holding a whole actor name that other records must match exactly, so
  // "goblin" may become "Goblins" but "goblin-1" stays one handle.
  const WHOLE_VALUE_FIELDS = new Set(['a', 'actor_id', 'target_id']);

  const CANCEL_WORD = /^\s*(cancel|delete|remove|reject)\b/i;
  // Shouted commands and "merge into …" are text written to the reviewer. A
  // lower-case "remove" could be real prose in a field, so only the shouted form counts.
  const SHOUTED_OR_MERGE = /^\s*(CANCEL|DELETE|REMOVE|REJECT|SKIP|IGNORE)\b|^\s*[Mm]erge into\b/;
  // A name is held to a stricter test: no real name is just a command word in any case.
  const COMMAND_AS_NAME = /^\s*(cancel|delete|remove|reject|skip|ignore)\b|^\s*merge into\b/i;
  const LOOKS_LIKE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]+_\d{3,})$/i;
  // A longer value is a phrase or a sentence, not a replacement name.
  const MAX_NAME_WORDS = 6;

  /**
   * escapeRegex(str) — makes a literal string safe inside a RegExp.
   * Why: a corrected name can hold "." or "(", which would otherwise be read
   * as pattern syntax. If removed, such a name throws or matches the wrong text.
   */
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * wholeWord(key, flags) — a pattern matching key only as a whole word.
   * Why: "Gold" must not match inside "Goldsmith". If changed to a plain
   * substring match, corrections would rewrite parts of unrelated words.
   */
  function wholeWord(key, flags) {
    return new RegExp('(?<![\\w])' + escapeRegex(key) + '(?![\\w])', flags);
  }

  /**
   * pathOf(k) — splits a diff's field name into its steps.
   * Why: the correction prompt's schema shows "field · subfield" while the page
   * and the AI's usual output use dots, so both must reach the same field.
   * If removed, "narrative.description" is stored as one literal key again.
   */
  function pathOf(k) {
    return String(k).split(/\s*[.·]\s*/).filter(Boolean);
  }

  /**
   * classifyDiffs(diffs) → { data, cancel, refused }
   *
   * Sorts one AI reply's diffs before anything is written. A command to drop
   * the card sets cancel; a value that is an instruction to the reviewer, or a
   * command key or operation this page cannot carry out, goes in refused so
   * the DM is told instead of it being saved as campaign text.
   *
   * Why: the session 6 hand review found "action": "CANCEL" stored on a record
   * that still published. If removed, a request to cancel a card changes
   * nothing and its words reach the campaign log.
   */
  function classifyDiffs(diffs) {
    const out = { data: [], cancel: false, refused: [] };
    for (const d of Array.isArray(diffs) ? diffs : []) {
      if (!d) continue;
      if (d.op != null) {
        if (ROUND_OPS.has(d.op)) out.data.push(d);
        else if (CANCEL_WORD.test(String(d.op))) out.cancel = true;
        else out.refused.push(d);
        continue;
      }
      if (COMMAND_KEYS.has(d.k)) {
        if (CANCEL_WORD.test(String(d.new ?? ''))) out.cancel = true;
        else out.refused.push(d);
        continue;
      }
      if (typeof d.new === 'string' && SHOUTED_OR_MERGE.test(d.new)) { out.refused.push(d); continue; }
      out.data.push(d);
    }
    return out;
  }

  /**
   * writeEntityDiffs(rawData, diffs) → { written, refused }
   *
   * Writes each diff to the field it names on an entity card's record, in place.
   * A bare "description" goes to narrative.description when the card keeps it
   * there, and "narrative.description" goes to a flat description when the card
   * keeps it flat, so the card shows the change and no second copy is made.
   *
   * Why: applyDiff() had no write for entity cards, so a correction said
   * "Applied" and was lost, while applyGlobalCorrection() stored the path as a
   * literal key. If removed, chat corrections on entity cards do nothing.
   */
  function writeEntityDiffs(rawData, diffs) {
    const result = { written: [], refused: [] };
    if (!rawData) return result;
    for (const d of diffs || []) {
      if (!d || !d.k || d.new === undefined) continue;
      let steps = pathOf(d.k);
      // Blocks prototype keys so an AI reply cannot alter every object on the page.
      if (!steps.length || steps.some(s => /__proto__|constructor|prototype/.test(s))) { result.refused.push(d); continue; }
      if (steps.length === 1 && !(steps[0] in rawData)) {
        const block = ['narrative', 'mechanics'].find(b => rawData[b] && steps[0] in rawData[b]);
        if (block) steps = [block, steps[0]];
      } else if (steps.length === 2 && !(rawData[steps[0]] && steps[1] in rawData[steps[0]]) && steps[1] in rawData) {
        steps = [steps[1]];
      }
      let o = rawData;
      let ok = true;
      for (const step of steps.slice(0, -1)) {
        const m = step.match(/^(\w+)\[(\d+)\]$/);
        if (m) {
          // An array item must already exist: a correction edits it, never invents one.
          o = Array.isArray(o[m[1]]) ? o[m[1]][Number(m[2])] : null;
          if (o == null || typeof o !== 'object') { ok = false; break; }
        } else {
          if (o[step] == null) o[step] = {};
          if (typeof o[step] !== 'object' || Array.isArray(o[step])) { ok = false; break; }
          o = o[step];
        }
      }
      if (!ok) { result.refused.push(d); continue; }
      o[steps[steps.length - 1]] = d.new;
      result.written.push(d);
    }
    return result;
  }

  /**
   * changedWord(oldStr, newStr) → { old, new } or null
   *
   * Finds the one word swapped between two phrases, so "Gold crits" to "Goldie
   * crits" gives Gold to Goldie. More than one change is ambiguous and gives null.
   * Why: the AI returns diffs as phrases but only the word can be spread safely.
   * If removed, phrase corrections no longer reach other cards.
   */
  function changedWord(oldStr, newStr) {
    const words = s => s.match(/[\w'-]+/g) || [];
    const a = words(oldStr);
    const b = words(newStr);
    const inA = new Set(a.map(w => w.toLowerCase()));
    const inB = new Set(b.map(w => w.toLowerCase()));
    const removed = a.filter(w => !inB.has(w.toLowerCase()));
    const added = b.filter(w => !inA.has(w.toLowerCase()));
    return removed.length === 1 && added.length === 1 ? { old: removed[0], new: added[0] } : null;
  }

  /**
   * factFromDiff(diff) → { key, value, flagOnly } or null
   *
   * Decides whether one applied diff is a name correction that may reach other
   * cards. Null means it stays on its own card. flagOnly means the new name holds
   * the old word ("dragon" to "Larkspur Dragon"): replacing would double names
   * already correct, so other cards are flagged for the DM instead of changed.
   *
   * Why: every session 6 corruption began with a diff this treated as a name.
   * If loosened, instructions and command words spread through the whole queue.
   */
  function factFromDiff(d) {
    if (!d || typeof d.old !== 'string' || typeof d.new !== 'string') return null;
    if (!d.old.trim() || !d.new.trim() || d.op != null) return null;
    const bracket = String(d.k ?? '').match(/\[\d+\]\.(\w+)$/);
    if (bracket) {
      if (!ROUND_NAME_FIELDS.has(bracket[1])) return null;
    } else {
      const last = pathOf(d.k ?? '').pop();
      if (CONTENT_FIELDS.has(last) || COMMAND_KEYS.has(d.k) || REFERENCE_FIELDS.has(last) || VOCABULARY_FIELDS.has(last)) return null;
    }
    if (d.old.includes('\n') && d.new.includes('\n')) return null;
    if (SHOUTED_OR_MERGE.test(d.new)) return null;

    let key = d.old.trim();
    let value = d.new.trim();
    if (key.length > 20 || key.includes(' ')) {
      const swap = changedWord(d.old, d.new);
      if (!swap || swap.old.length > 40) return null;
      key = swap.old;
      value = swap.new;
    }
    if (key === value) return null;
    // An instruction can also arrive as a value with a dash ("Goblins — see notes").
    if (COMMAND_AS_NAME.test(value) || /[—–]/.test(value) || LOOKS_LIKE_ID.test(value)) return null;
    if (value.split(/\s+/).length > MAX_NAME_WORDS) return null;
    const caseOnly = key.toLowerCase() === value.toLowerCase();
    const flagOnly = !caseOnly && wholeWord(key, 'i').test(value);
    return { key, value, flagOnly };
  }

  /**
   * applyFact(rawData, fact) → { rawData, diffs, possible }
   *
   * Applies one name correction to a card's record and returns a new copy.
   * An exact-case whole word is replaced in text; other spellings only set
   * possible, so the DM decides. "Gold" to "Goldie" must leave "70 gold" alone.
   * A case-only fix replaces any case, since it cannot change the word. Reference
   * and vocabulary fields are never touched; actor fields change only as a whole.
   *
   * Why: this replaces a case-insensitive replace over every string, which
   * doubled names and rewrote ids. If removed, propagateGroundTruth() cannot
   * apply a fact to other cards.
   */
  function applyFact(rawData, fact) {
    const { key, value, flagOnly } = fact;
    const caseOnly = key.toLowerCase() === value.toLowerCase();
    const replaceRe = wholeWord(key, caseOnly ? 'gi' : 'g');
    const anyCaseRe = new RegExp(escapeRegex(key), 'i');
    const valueRe = new RegExp(escapeRegex(value), 'gi');
    const diffs = [];
    let possible = false;

    const walk = (node, path, field) => {
      if (typeof node === 'string') {
        if (REFERENCE_FIELDS.has(field) || VOCABULARY_FIELDS.has(field) || LOOKS_LIKE_ID.test(node)) return node;
        let text = node;
        if (WHOLE_VALUE_FIELDS.has(field)) {
          if (!flagOnly && text === key) text = value;
        } else if (!flagOnly) {
          text = text.replace(replaceRe, () => value);
        }
        if (text !== node) diffs.push({ k: path, old: key, new: text });
        // The new name is taken out first, so "Bel" is not reported inside a
        // "Belfar" that is already right.
        if (anyCaseRe.test(text.replace(valueRe, ''))) possible = true;
        return text;
      }
      if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`, field));
      if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = walk(v, path ? `${path}.${k}` : k, k);
        return out;
      }
      return node;
    };

    return { rawData: walk(rawData, '', ''), diffs, possible };
  }

  // ── New records: ids, duplicates and descriptions ─────────────────────────

  /**
   * newCascadeId(taken, now) → an id no queue item holds
   *
   * Why: cascades from one AI reply are built in the same millisecond, so a bare
   * timestamp gave them one id, and selecting or approving one acted on the other
   * (#125). If removed, those cards cannot be approved separately.
   */
  function newCascadeId(taken, now) {
    const used = new Set(taken);
    let id = 'd_cascade_' + now;
    for (let n = 1; used.has(id); n++) id = `d_cascade_${now}_${n}`;
    return id;
  }

  /**
   * nameKey(name) → the name reduced for comparing records
   *
   * Lower case, no punctuation, and the last word singular, so "goblin" and
   * "Goblins" or "wolf" and "Wolves" compare equal. Short words are left alone so
   * "Gus" does not become "Gu". If removed, plural duplicates get through (#131).
   */
  function nameKey(name) {
    const words = String(name ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
    const last = words[words.length - 1];
    if (last.endsWith('ves') && last.length > 4) words[words.length - 1] = last.slice(0, -3) + 'f';
    else if (/(ches|shes|xes|sses)$/.test(last)) words[words.length - 1] = last.slice(0, -2);
    else if (last.length > 3 && last.endsWith('s') && !last.endsWith('ss')) words[words.length - 1] = last.slice(0, -1);
    return words.join(' ');
  }

  /**
   * editDistance(a, b, limit) — how many single-letter edits turn a into b.
   * Stops early once the answer must exceed limit, and then returns limit + 1.
   * Why: "Lurkspur" and "Larkspur" share no exact form but are one letter apart.
   * If removed, findDuplicate() cannot warn about a misspelt name.
   */
  function editDistance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      if (Math.min(...next) > limit) return limit + 1;
      row = next;
    }
    return row[b.length];
  }

  /**
   * buildRecordIndex(campaign) → [{ id, legacy_id, type, name, keys }]
   *
   * Every record a new card could duplicate, under its name, title and aliases.
   * Why: quests hold "title", not "name", so the old index never held a quest, and
   * it ignored aliases. If removed, checkDuplicateName() has nothing to search.
   */
  function buildRecordIndex(campaign) {
    const arrays = { npc_directory: 'npc', locations: 'location', bestiary: 'monster', factions: 'faction',
      cohorts: 'cohort', inventory_and_loot: 'item', quest_ledger: 'quest' };
    const index = [];
    for (const [arr, type] of Object.entries(arrays)) {
      for (const e of (campaign && campaign[arr]) || []) {
        const name = e.name || e.title;
        if (!name) continue;
        index.push({ id: e.id, legacy_id: e.legacy_id ?? null, type, name,
          keys: [name, ...(e.aliases || [])].map(nameKey) });
      }
    }
    return index;
  }

  /**
   * findDuplicate(name, type, index) → { id, legacy_id, type, name, strength } or null
   *
   * strength "same": same kind and same name, ignoring case, punctuation and
   * plural, or an alias. The card should not be queued. strength "close": a near
   * spelling, or the same name on another kind. The DM decides, from a warning.
   * Close spelling only applies to names of six letters or more, because short
   * names (Bel, Mal, Gus) are often really different people.
   *
   * Why: session 6 published a second Immovable Rod, "goblin" beside Goblins and
   * "Lurkspur" beside "Larkspur" (#131). If loosened, real new records are hidden.
   */
  function findDuplicate(name, type, index) {
    if (!name || !Array.isArray(index)) return null;
    const key = nameKey(name);
    const withStrength = (r, strength) => ({ id: r.id, legacy_id: r.legacy_id, type: r.type, name: r.name, strength });
    const exact = index.filter(r => r.keys.includes(key));
    const same = exact.find(r => !type || r.type === type);
    if (same) return withStrength(same, 'same');
    if (exact.length) return withStrength(exact[0], 'close');
    if (key.length < 6) return null;
    const near = index.find(r => (!type || r.type === type) && r.keys.some(k => k.length >= 6 && editDistance(k, key, 2) <= 2));
    return near ? withStrength(near, 'close') : null;
  }

  // Wording that addresses the reviewer or the queue rather than describing a thing.
  // "queue" and "cascade" count only in review phrasing, so "a queue of refugees" stays.
  const REVIEW_WORDING = [
    /\bdedup/i, /\bduplicate check\b/i, /\bsearch existing\b/i, /\bif a match is found\b/i,
    /\bcreate an? .{0,40}\b(entry|record)\b/i, /\blink the existing\b/i,
    /\b(added to|add to|in|to) (the )?(review )?queue\b/i, /\bcascade (item|entry)\b/i,
    /\b[a-z]+_(new_)?\d{2,}\b/, /\b[A-Z]{3,} [A-Z]{3,}\b/, /^\s*(CANCEL|DELETE|REMOVE|REJECT|SKIP|IGNORE)\b/,
  ];

  /**
   * cleanDescription(text) → { text, removed }
   *
   * Keeps a description out of the record when it is instructions to the reviewer.
   * Why: session 6 proposed Lake Town with "DEDUP CHECK REQUIRED before creating…"
   * as its description (#126). If removed, that text can reach the campaign log.
   */
  function cleanDescription(text) {
    if (typeof text !== 'string' || !text.trim()) return { text: null, removed: null };
    return REVIEW_WORDING.some(re => re.test(text)) ? { text: null, removed: text } : { text, removed: null };
  }

  // Wording that reports one fight rather than describing a creature.
  const ENCOUNTER_WORDING = /\b(rounds?\s*\d+|this (fight|combat|encounter|battle)|attacked|missed|repositioning|was (killed|slain)|hit the party)\b/i;

  /**
   * reusableDescription(text, partyNames) → { text, evidence }
   *
   * A bestiary entry is reused by every later encounter, so a description naming
   * a PC, a round or an event goes to evidence for the DM and is not saved (#123).
   * PC names must stand alone, so "Ash-grey" does not match a PC called Ash.
   * If removed, text like "one attacked Mal and missed" reaches the bestiary.
   */
  function reusableDescription(text, partyNames) {
    if (typeof text !== 'string' || !text.trim()) return { text: null, evidence: null };
    const namesPc = (partyNames || []).filter(Boolean).some(n =>
      new RegExp('(?<![\\w-])' + escapeRegex(n) + '(?![\\w-])', 'i').test(text));
    return namesPc || ENCOUNTER_WORDING.test(text) ? { text: null, evidence: text } : { text, evidence: null };
  }

  // ── Treasure (#122) ──────────────────────────────────────────────────────

  const COIN_AMOUNT = /\b\d[\d,]*\s*(cp|sp|ep|gp|pp)\b/i;
  const STATED_PRICE = /\bworth\s+\d|\b\d[\d,]*\s*(cp|sp|ep|gp|pp|gold)\b/i;
  const PILE_NAME = /^(art( and gems| objects?)?|gems?|jewels?|treasure( hoard)?|hoard|coins?|currency|gold|silver|copper|platinum|electrum|loot|money)(\s+(pieces?|coins?))?(\s*\(.*\))?$/i;
  const VALUABLE_WORD = /\b(gems?|emeralds?|rub(y|ies)|sapphires?|diamonds?|quartz|pearls?|jade|topaz|opals?|garnets?|amethysts?|jewels?|art|statuettes?|paintings?|tapestr(y|ies))\b/i;
  const ALWAYS_AN_ITEM = /\b(potions?|scrolls?|wands?|rods?|staffs?|rings? of|maps?|letters?|keys?|bag of|sword|dagger|armou?r|shield)\b|\+\d/i;

  /**
   * isCashTreasure(name, description) → true when this is money rather than an item
   *
   * The DM's rule: coins, and any gem, art object or pile with a stated cash value,
   * are narrative. A named or magic item or a quest object is always an item. A gem
   * described by something other than a price ("oddly warm gem") stays for the DM
   * to confirm. Why: session 6 proposed "1,400 cp" and "Art and Gems (9…)" as items
   * (#122). If removed, every stated amount in a hoard becomes an inventory entry.
   */
  function isCashTreasure(name, description) {
    const n = String(name ?? '').trim();
    const d = String(description ?? '');
    if (!n) return false;
    if (ALWAYS_AN_ITEM.test(n)) return false;
    if (COIN_AMOUNT.test(n) || PILE_NAME.test(n) || STATED_PRICE.test(n)) return true;
    return VALUABLE_WORD.test(n) && STATED_PRICE.test(d);
  }

  // ── Combat status (#127) ─────────────────────────────────────────────────

  // The schema's combat_outcome values (the data file's _field_type_reference).
  const OUTCOMES = ['victory', 'defeat', 'retreat', 'pyrrhic', 'interrupted', 'paused'];

  /**
   * mergeCombatStatus(current, reading, round) → the card's new state
   *
   * Pages can be interpreted in any order, so the reading from the highest round
   * wins, and a value the DM picked is never replaced by a later reading. A value
   * outside the schema's list is ignored. Why: a combat's outcome and location were
   * never set by intake, and null was published unseen (#127). If removed, the last
   * page interpreted would decide the outcome, even if it is an earlier page.
   */
  function mergeCombatStatus(current, reading, round) {
    const out = Object.assign({ outcome: null, evidence: null, location: null, round: null, outcomeChosen: false, locationChosen: false }, current);
    if (!reading) return out;
    const later = out.round == null || round == null || round >= out.round;
    if (!later) return out;
    if (OUTCOMES.includes(reading.outcome) && !out.outcomeChosen) {
      out.outcome = reading.outcome;
      out.evidence = reading.evidence ?? null;
    }
    if (typeof reading.location === 'string' && reading.location.trim() && !out.locationChosen) out.location = reading.location.trim();
    if (round != null) out.round = round;
    return out;
  }

  const api = { classifyDiffs, writeEntityDiffs, factFromDiff, applyFact, pathOf, newCascadeId, nameKey,
    buildRecordIndex, findDuplicate, cleanDescription, reusableDescription, isCashTreasure, OUTCOMES, mergeCombatStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChronicleCorrections = api;
})(typeof window !== 'undefined' ? window : globalThis);
