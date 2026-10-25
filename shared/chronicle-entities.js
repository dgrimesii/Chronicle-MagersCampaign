/**
 * shared/chronicle-entities.js
 *
 * Entity identification, step 3 of the session page (issue #100).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * In the old intake a misread name ("Bel" for Belfar) was copied into every
 * round, relationship and summary it touched, and the DM had to find and fix
 * each copy. The redesign (docs/intake-redesign.md, "Identity first") settles
 * what every name in the notes refers to once, before any fact is built:
 * each mention becomes an occurrence, occurrences with the same words become
 * one row, and the DM acknowledges or corrects the row. Facts and passages
 * (#101, #102) will point at occurrences, so one correction here moves every
 * fact that came from those words.
 *
 * The logic lives here, not in admin/session.html, so it has no DOM and
 * tests/entity-identification.test.js runs the same code the page runs. It
 * replaces Delta Review's name index and duplicate check (#56) and folds in
 * cohorts (#62) for the session page; Delta Review keeps its own copy until
 * phase 5 retires it (the DM's choice on #100).
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChronicleEntities (and module.exports under Node):
 *   KINDS                         — the mention kinds and the arrays each maps to
 *   norm(s)                       — the name normalisation every comparison uses
 *   buildIndex(campaign)          — every entity with its names and aliases
 *   entityListForPrompt(index)    — the candidate list the AI matches against
 *   mentionPrompt({entityList, pageLabel}) / parseMentions(text)
 *                                 — the step 2 AI prompt for one page, and
 *                                   the check on its reply
 *   buildRows(pages, index)       — AI mentions → occurrences → review rows
 *   sortRows(rows)                — new and inexact first, exact matches last
 *   newEntities(rows)             — the entities this session's answers create
 *   acknowledge / linkToExisting / separateAsNew / split / markSubType / reopen
 *                                 — the DM's actions; each changes one row,
 *                                   and so every occurrence in it
 *   bulkAcknowledgeExact(rows)    — acknowledges every pending exact match
 *   allSettled(rows)              — true when no row is pending
 *   resolveOccurrences(rows, index) — each occurrence's entity, roster group,
 *                                   or needs-assignment
 *   flags(rows, index)            — likely merges: acting twice in a round,
 *                                   two places at once, conflicting allegiance
 *   toQueueItems(rows, index)     — the publish items the answers produce
 *                                   (new entities, aliases, notes, roster groups)
 *
 * It depends on shared/chronicle-ids.js (window.ChronicleIds, or require under
 * Node) for new ids. No DOM, storage or network access.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * The session page's Identify step would have nothing to build its list
 * with, and nothing would turn the DM's answers into publish items.
 */

(function(root) {
  'use strict';

  // chronicle-ids.js is required under Node and is a page script in the
  // browser; looked up at call time so script order cannot leave it unset.
  const NodeIds = (typeof module !== 'undefined' && module.exports) ? require('./chronicle-ids.js') : null;
  function Ids() {
    const ids = NodeIds || root.ChronicleIds;
    if (!ids) throw new Error('ChronicleEntities needs shared/chronicle-ids.js loaded first');
    return ids;
  }

  /**
   * KINDS — what the AI may call a mention, the group the list shows it under
   * (the design's five: person or creature, place, thing, event, knowledge),
   * the arrays a match may come from, and the array a new one is created in.
   *
   * `create: null` means a new entity of that kind cannot be made here: a PC
   * the notes name but the party does not have is a misreading, so the DM
   * must link it to a party member.
   *
   * `label` is what step 3 shows and offers when the DM corrects a row's
   * kind (setKind, #114). The group alone ("Person or creature") hid
   * whether the read called a mention an NPC or a creature, which decides
   * where it is created and whether it takes a party slot or an enemy row.
   */
  const KINDS = {
    pc:       { group: 'Person or creature', label: 'Player character', arrays: ['party'],                   create: null },
    npc:      { group: 'Person or creature', label: 'NPC',              arrays: ['npc_directory', 'party'],  create: 'npc_directory' },
    creature: { group: 'Person or creature', label: 'Creature',         arrays: ['enemies_roster', 'bestiary', 'cohorts'], create: 'bestiary' },
    faction:  { group: 'Person or creature', label: 'Faction',          arrays: ['factions', 'cohorts'],     create: 'factions' },
    cohort:   { group: 'Person or creature', label: 'Cohort',           arrays: ['cohorts', 'factions'],     create: 'cohorts' },
    place:    { group: 'Place',              label: 'Place',            arrays: ['locations'],               create: 'locations' },
    thing:    { group: 'Thing',              label: 'Thing',            arrays: ['inventory_and_loot'],      create: 'inventory_and_loot' },
    combat:   { group: 'Event',              label: 'Combat',           arrays: ['combat_encounters'],       create: 'combat_encounters' },
    quest:    { group: 'Event',              label: 'Quest',            arrays: ['quest_ledger'],            create: 'quest_ledger' },
    moment:   { group: 'Event',              label: 'Character moment', arrays: ['character_moments'],       create: 'character_moments' },
    lore:     { group: 'Knowledge',          label: 'Lore',             arrays: ['world_lore'],              create: 'world_lore' },
  };

  // _object_type for an entity created in each array, as the data writes it.
  const OBJECT_TYPE = {
    npc_directory: 'npc', bestiary: 'monster', factions: 'faction', cohorts: 'cohort',
    locations: 'location', inventory_and_loot: 'item', combat_encounters: 'combat',
    quest_ledger: 'quest', character_moments: 'character_moment', world_lore: 'lore',
  };

  // Arrays whose display name is `title` rather than `name`.
  const TITLE_ARRAYS = new Set(['quest_ledger', 'world_lore']);

  // A combat whose outcome is one of these can still be continued by a page.
  const OPEN_OUTCOMES = new Set(['paused', 'ongoing', 'in_progress', null, undefined, '']);

  /**
   * norm(s) — lowercase, punctuation removed, spaces collapsed.
   * The same rule Delta Review's duplicate check used (#56), so "The Hooded
   * Figure" and "the hooded figure." are one name. Deliberately no plural or
   * edit-distance folding: an exact match is what Bulk acknowledge trusts,
   * so near-misses must stay row-by-row.
   */
  function norm(s) {
    return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // nameOf(entity, array) → the label the DM knows the entity by.
  function nameOf(e, array) {
    if (TITLE_ARRAYS.has(array)) return e.title || e.name || '';
    if (array === 'character_moments') {
      // Moments have no name; their type and first words of the action serve.
      const what = e.narrative?.title || e.mechanics?.mechanical_action || '';
      return `${e.type || 'moment'}: ${what.slice(0, 60)}`;
    }
    return e.name || e.title || '';
  }

  /**
   * buildIndex(campaign) → { entities: Map id → entry, byName: Map norm → [entry] }
   *
   * entry = { id, legacyId, array, name, names: [every exact name], open }
   * A PC's nickname counts as a name ("Del"), because the notes use it more
   * than the full name. Moments are listed for the AI but have no exact
   * names, since their label is made up here, not written in the notes.
   * `open` marks a combat that a page may continue (#100: "a page that
   * continues the Goblin Ambush matches cbt_005").
   */
  function buildIndex(campaign) {
    const entities = new Map();
    const byName = new Map();
    const arrays = new Set(Object.values(KINDS).flatMap(k => k.arrays));
    for (const array of arrays) {
      for (const e of (campaign && campaign[array]) || []) {
        if (!e || !e.id) continue;
        const names = [];
        if (array !== 'character_moments') {
          names.push(nameOf(e, array));
          if (array === 'party' && e.nickname) names.push(e.nickname);
          for (const a of Array.isArray(e.aliases) ? e.aliases : []) names.push(a);
        }
        const entry = {
          id: e.id, legacyId: e.legacy_id || null, array, name: nameOf(e, array),
          names: names.filter(Boolean),
          open: array === 'combat_encounters' && OPEN_OUTCOMES.has(e.mechanics?.outcome),
        };
        add(entry);
        // An open combat's roster groups ("Goblins", "Goblin Slingers") are
        // what a continuing page's creatures refer to, but they are not
        // entities and have no id. They get a made-up id here, roster:<combat
        // id>:<actor_id>, used only inside the session page; it is never
        // written to the data. resolveOccurrences turns it back into the
        // combat and group.
        if (entry.open) {
          for (const g of e.mechanics?.enemies_roster || []) {
            if (!g || !g.actor_id) continue;
            add({ id: 'roster:' + e.id + ':' + g.actor_id, legacyId: null, array: 'enemies_roster',
              name: g.actor_id, names: [g.actor_id], open: false,
              combatId: e.id, combatName: entry.name, monRef: g.mon_ref || null, role: g.role || null });
          }
        }
      }
    }
    return { entities, byName };

    function add(entry) {
      entities.set(entry.id, entry);
      for (const n of entry.names) {
        const k = norm(n);
        if (!k) continue;
        if (!byName.has(k)) byName.set(k, []);
        if (!byName.get(k).includes(entry)) byName.get(k).push(entry);
      }
    }
  }

  /**
   * entityListForPrompt(index) → text, one line per entity: `id | array | name (aliases)`.
   * The AI proposes a candidate only from this list, by id, so a candidate
   * is always something that exists. Open combats are marked so the AI can
   * match "the ambush continues" to the paused fight.
   */
  function entityListForPrompt(index) {
    const lines = [];
    for (const e of index.entities.values()) {
      const extra = e.names.slice(1);
      const where = e.array === 'enemies_roster' ? ` (enemy group in ${e.combatName}${e.role ? ', role ' + e.role : ''})` : '';
      lines.push(`${e.id} | ${e.array} | ${e.name}${extra.length ? ' (also: ' + extra.join(', ') + ')' : ''}${where}${e.open ? ' [OPEN COMBAT]' : ''}`);
    }
    return lines.join('\n');
  }

  // exactMatch(asWritten, kind, index) → the one entity whose name or alias
  // equals the words, among the arrays the kind allows; null if none or if
  // two entities share the name (ambiguous, so the DM must choose).
  // One exception: "Goblins" names both the bestiary entry and the paused
  // combat's roster group of that creature. In a continuing fight the words
  // mean the group, so a single roster group wins over the creature it
  // points at. Two roster groups with the name stay ambiguous.
  function exactMatch(asWritten, kind, index) {
    const allowed = (KINDS[kind] || KINDS.npc).arrays;
    const hits = (index.byName.get(norm(asWritten)) || []).filter(e => allowed.includes(e.array));
    if (hits.length === 1) return hits[0];
    const groups = hits.filter(e => e.array === 'enemies_roster');
    if (groups.length === 1 && hits.every(e => e === groups[0] || e.id === groups[0].monRef)) return groups[0];
    return null;
  }

  /**
   * buildRows(pages, index) → rows
   *
   * pages — [{ page, mentions: [AI mention] }] in reading order. A mention is
   *   { kind, as_written, context, round, candidate_id, candidate_reason,
   *     scene, location, allegiance, turn_round, combat_ref }; only kind and
   *   as_written are required.
   *
   * Every mention becomes an occurrence with its own id (occ_<page>_<n>),
   * keeping the words exactly as written: a split in step 4 falls back on
   * the spelling, so a name is never normalised away. Occurrences with the
   * same kind and the same normalised words form one row; that is what lets
   * one action fix every occurrence at once.
   *
   * Each row's match is decided here, not by the AI:
   *   exact   — the words equal one entity's name or alias (Bulk acknowledge)
   *   inexact — no exact match, but the AI proposed an existing entity
   *   new     — neither
   * The AI's confidence plays no part, as the design requires.
   */
  function buildRows(pages, index) {
    const rows = new Map();
    for (const p of pages || []) {
      (p.mentions || []).forEach((m, n) => {
        if (!m || !m.as_written) return;
        const kind = KINDS[m.kind] ? m.kind : 'npc';
        const occ = {
          id: `occ_${p.page}_${n + 1}`,
          page: p.page,
          asWritten: String(m.as_written),
          context: m.context || '',
          round: num(m.round),
          scene: num(m.scene),
          location: m.location || null,
          allegiance: ['ally', 'enemy', 'neutral'].includes(m.allegiance) ? m.allegiance : null,
          turnRound: num(m.turn_round),
          combatRef: m.combat_ref || null,
          candidateId: m.candidate_id || null,
          candidateReason: m.candidate_reason || '',
        };
        const key = kind + '|' + norm(occ.asWritten);
        if (!rows.has(key)) rows.set(key, { key, kind, asWritten: occ.asWritten, occurrences: [] });
        rows.get(key).occurrences.push(occ);
      });
    }
    for (const row of rows.values()) matchRow(row, index);
    return sortRows([...rows.values()]);
  }

  /**
   * matchRow(row, index) — decides one row's match from its kind and words,
   * and leaves it pending. Used by buildRows and, when the DM corrects a
   * row's kind, by setKind, so a corrected row is matched by exactly the
   * rules the read used:
   *   exact   — the words equal one entity's name or alias among the arrays
   *             the kind allows
   *   inexact — the AI's most frequent candidate across the occurrences,
   *             kept only if it is in an allowed array
   *   new     — neither
   */
  function matchRow(row, index) {
    const exact = exactMatch(row.asWritten, row.kind, index);
    const cand = mostCommon(row.occurrences.map(o => o.candidateId).filter(Boolean));
    const candEntry = cand && index.entities.get(cand);
    const allowed = KINDS[row.kind].arrays;
    delete row.reason;
    if (exact) {
      row.matchType = 'exact';
      row.matchId = exact.id;
    } else if (candEntry && allowed.includes(candEntry.array)) {
      row.matchType = 'inexact';
      row.matchId = candEntry.id;
      row.reason = row.occurrences.find(o => o.candidateId === cand)?.candidateReason || '';
    } else {
      row.matchType = 'new';
      row.matchId = null;
    }
    row.status = 'pending';
    row.resolution = null;
  }

  /**
   * setKind(rows, row, kind, index) → the rows, sorted again.
   *
   * The DM corrects the kind the read gave a row (#114): "Vespon" read as an
   * NPC is a creature. The row is matched again for the new kind (matchRow),
   * so its match, its Acknowledge (which creates in the kind's array) and
   * its Link list all follow the correction. Without it the only way to
   * settle such a row was to create an NPC, which then took a party slot in
   * the grid and gave the party a wrong "allied" relationship (#17, F2).
   *
   * Only a pending row: a settled row's answer was made for its old kind,
   * so the DM reopens it first. If another row already holds the same words
   * as the new kind, the two are one mention and are merged: the other row
   * gains these occurrences and keeps its own answer if it has one (a
   * pending one is matched again with every occurrence's candidate).
   */
  function setKind(rows, row, kind, index) {
    if (!KINDS[kind]) throw new Error(`"${kind}" is not a kind.`);
    if (row.status === 'settled') throw new Error('Reopen the row (Change) before correcting its kind: its answer was made for the old kind.');
    if (row.kind === kind) return rows;
    const key = kind + '|' + norm(row.asWritten);
    const other = rows.find(r => r !== row && r.key === key);
    if (other) {
      const byPage = (a, b) => String(a.page).localeCompare(String(b.page), undefined, { numeric: true }) || a.id.localeCompare(b.id, undefined, { numeric: true });
      other.occurrences = other.occurrences.concat(row.occurrences).sort(byPage);
      if (other.status !== 'settled') matchRow(other, index);
      return sortRows(rows.filter(r => r !== row));
    }
    row.kind = kind;
    row.key = key;
    matchRow(row, index);
    return sortRows(rows);
  }

  function num(v) {
    const n = Number(v);
    return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
  }

  function mostCommon(list) {
    const counts = new Map();
    for (const v of list) counts.set(v, (counts.get(v) || 0) + 1);
    let best = null, n = 0;
    for (const [v, c] of counts) if (c > n) { best = v; n = c; }
    return best;
  }

  /**
   * sortRows(rows) → rows, new first, then inexact, then exact; within each,
   * first appearance in the notes. Exact matches go last because they are the
   * ones the DM can bulk-acknowledge; the rows that need reading come first.
   */
  function sortRows(rows) {
    const rank = { new: 0, inexact: 1, exact: 2 };
    const first = r => r.occurrences[0] ? r.occurrences[0].id : '';
    return rows.slice().sort((a, b) => (rank[a.matchType] - rank[b.matchType]) ||
      String(a.occurrences[0]?.page).localeCompare(String(b.occurrences[0]?.page), undefined, { numeric: true }) ||
      first(a).localeCompare(first(b), undefined, { numeric: true }));
  }

  // ── The DM's actions ──────────────────────────────────────────────────────
  // Each takes a row and returns nothing; it sets row.status and
  // row.resolution. The page redraws from the rows. Every action covers all
  // of the row's occurrences, which is what stops one misreading spreading.

  /**
   * acknowledge(row, name?) — the match (or the new entity) is right.
   * A new row creates an entity named `name` (default: the words as written)
   * with a fresh UUID. An inexact match saves the words as an alias, as a
   * Link does, so the same spelling is an exact match next session.
   * A PC kind with no match cannot be acknowledged (see KINDS).
   */
  function acknowledge(row, name) {
    if (row.matchType === 'new') {
      const array = KINDS[row.kind].create;
      if (!array) throw new Error(`"${row.asWritten}" names no party member. Link it to one instead.`);
      row.resolution = { action: 'new', entityId: Ids().newId(), array, name: (name || row.asWritten).trim() };
    } else {
      row.resolution = { action: 'acknowledge', entityId: row.matchId, alias: row.matchType === 'inexact' ? row.asWritten : null };
    }
    row.status = 'settled';
  }

  /**
   * newEntities(rows) → Map id → { id, name, array, rowKey }: the entities
   * this session's answers create (Acknowledge on a New row, Separate, and
   * the new parts of a Split). They are not in the index until publish, but
   * other rows must be able to link to them: one fight's dragons arrive as
   * "dragon", "Dragons", "Larkspur Drag" and "#2 Dragon" (seen on real
   * session 6 pages), and only one row should create the entity.
   */
  function newEntities(rows) {
    const out = new Map();
    for (const r of rows || []) {
      const res = r.resolution;
      if (!res) continue;
      if (res.action === 'new' || res.action === 'separate') out.set(res.entityId, { id: res.entityId, name: res.name, array: res.array, rowKey: r.key });
      if (res.action === 'split') for (const p of res.parts) if (!p.existing) out.set(p.entityId, { id: p.entityId, name: p.name, array: p.array, rowKey: r.key });
    }
    return out;
  }

  /**
   * linkToExisting(row, entityId, index, rows, opts) — the words name an
   * entity already in the campaign (a typo, abbreviation or nickname), or one
   * another row of this session creates. Saves the words as an alias on it,
   * unless they already are one of its names or opts.saveAlias is false.
   * For a new entity the alias is written with it at publish (toQueueItems).
   *
   * Why saving can be turned off: some words are right for this page but
   * would be wrong as a name for ever. On real session 6 pages "#1", "#2"
   * (two dragons) and "Combat Ended" all linked correctly, but as aliases
   * they would make any later "#1" an exact match for that dragon.
   */
  function linkToExisting(row, entityId, index, rows, opts) {
    const save = !opts || opts.saveAlias !== false;
    const e = index.entities.get(entityId);
    if (e) {
      const known = e.names.some(n => norm(n) === norm(row.asWritten));
      row.resolution = { action: 'link', entityId, alias: known || !save ? null : row.asWritten };
    } else {
      const made = newEntities(rows).get(entityId);
      if (!made || made.rowKey === row.key) throw new Error('Pick an existing entity to link to.');
      row.resolution = { action: 'link', entityId, alias: norm(made.name) === norm(row.asWritten) || !save ? null : row.asWritten, toNew: true };
    }
    row.status = 'settled';
  }

  /**
   * separateAsNew(row, name) — the match is wrong: the words name a different
   * entity that only looks alike. Creates the new entity and records a note
   * on the matched one, so the two are not confused again.
   */
  function separateAsNew(row, name) {
    if (!row.matchId) throw new Error('Only a matched row can be separated; acknowledge a new one instead.');
    const array = KINDS[row.kind].create;
    if (!array) throw new Error('A party member cannot be separated into a new entity.');
    row.resolution = { action: 'separate', entityId: Ids().newId(), array, name: (name || row.asWritten).trim(), notConfusedWith: row.matchId };
    row.status = 'settled';
  }

  /**
   * split(row, parts) — the row is really two or more entities in this
   * session. parts = [{ name } | { linkId }]: a new entity by name, or an
   * existing one. Only decides what exists; every occurrence is left
   * "needs assignment" for step 4 (#103), where each sits in its full round.
   */
  function split(row, parts, index) {
    const array = KINDS[row.kind].create;
    const made = (parts || []).map(p => {
      if (p.linkId) {
        if (!index.entities.get(p.linkId)) throw new Error('A split part links to an entity that does not exist.');
        return { entityId: p.linkId, existing: true, name: index.entities.get(p.linkId).name };
      }
      if (!array) throw new Error('A party member cannot be split into new entities.');
      if (!p.name || !p.name.trim()) throw new Error('Name each part of the split.');
      return { entityId: Ids().newId(), existing: false, array, name: p.name.trim() };
    });
    if (made.length < 2) throw new Error('A split needs at least two entities.');
    row.resolution = { action: 'split', parts: made };
    row.status = 'settled';
  }

  /**
   * markSubType(row, opts, index, rows) — the same creature in a different
   * role in one combat (goblins with slings). Adds a roster group to that
   * combat, labelled `label`, with `role`, pointing at the creature's bestiary
   * entry, so the bestiary keeps one entry (#94). opts = { combatId,
   * creatureId, label, role }.
   *
   * The combat and the creature may be ones the campaign already has, or ones
   * another row of this step 3 creates (#119): in a fight that starts in the
   * session under review, the Goblin Ambush and the Goblins are both new, and
   * refusing them lost the slinger role (#17, F7). rows is needed to see those
   * new entities; without it only campaign entities are accepted. The row
   * itself cannot supply either: a sub-type row creates nothing.
   *
   * toNew marks an answer that leans on a new entity, so reopen() reopens it
   * when the row that created that entity is reopened, as it does for a link.
   */
  function markSubType(row, opts, index, rows) {
    const o = opts || {};
    const made = newEntities((rows || []).filter(r => r !== row));
    // An entity of the right array, from the campaign or made in this step 3.
    const find = (id, array) => {
      const e = index.entities.get(id) || made.get(id);
      return e && e.array === array ? e : null;
    };
    const combat = find(o.combatId, 'combat_encounters');
    const creature = find(o.creatureId, 'bestiary');
    if (!combat) throw new Error('Pick the combat the sub-type fights in.');
    if (!creature) throw new Error('Pick the creature it is a sub-type of.');
    if (!o.label || !o.label.trim() || !o.role || !o.role.trim()) throw new Error('Give the group a label and a role.');
    row.resolution = { action: 'subtype', combatId: combat.id, creatureId: creature.id, label: o.label.trim(), role: o.role.trim() };
    if (made.has(combat.id) || made.has(creature.id)) row.resolution.toNew = true;
    row.status = 'settled';
  }

  /**
   * addRow(rows, opts, index) → the rows with one more, sorted again.
   *
   * An entity the notes name but the mention read missed (#115): in #17 the
   * read missed "ROUS", the rats and the Quarry ROUS Problem, so the quest's
   * start could not be captured, and step 3 only offered the rows the read
   * produced. opts = { kind, words, pages }:
   *   kind  — one of KINDS
   *   words — the name as the notes write it (what the facts read is shown)
   *   pages — every page of the session; the row gets one occurrence on each
   *           (occ_<page>_dm<n>), so every page's facts read lists it and
   *           can name it as an actor, a target, a quest or a passage's
   *           subject. Occurrence ids never collide with the read's
   *           (occ_<page>_<number>).
   * The row is matched like a read row (matchRow), so words that name an
   * existing entity match it, and it is settled with the usual actions. It
   * is marked added, so the page can say so and offer Remove. The same
   * words already a row of that kind are refused: settle that row instead.
   */
  function addRow(rows, opts, index) {
    const o = opts || {};
    const kind = o.kind;
    const words = String(o.words || '').trim();
    if (!KINDS[kind]) throw new Error('Pick what kind of entity it is.');
    if (!words) throw new Error('Type the name as the notes write it.');
    if (!Array.isArray(o.pages) || !o.pages.length) throw new Error('There are no pages to add it to.');
    const key = kind + '|' + norm(words);
    if (rows.some(r => r.key === key)) throw new Error(`"${words}" is already a ${KINDS[kind].label} row: settle that one.`);
    // The next number above every added occurrence still in use, so a new
    // id never collides with one a row holds. A removed row's number may be
    // used again: nothing can still point at it, because any change in
    // step 3 makes the facts be read again (identityKey).
    const used = rows.flatMap(r => r.occurrences.map(x => /_dm(\d+)$/.exec(x.id))).filter(Boolean).map(m => Number(m[1]));
    const n = (used.length ? Math.max(...used) : 0) + 1;
    const row = { key, kind, asWritten: words, added: true, occurrences: o.pages.map(page => ({
      id: `occ_${page}_dm${n}`, page, asWritten: words,
      // Worded so the facts read cannot mistake it for a line of the notes
      // (the first real run copied it as a source line, #115).
      context: 'Added by the DM (no line of its own): the notes name it but the first read missed it',
      round: null, scene: null, location: null, allegiance: null, turnRound: null, combatRef: null,
      candidateId: null, candidateReason: '' })) };
    matchRow(row, index);
    return sortRows(rows.concat(row));
  }

  /**
   * removeAddedRow(rows, row) → the rows without it (#115). Only a row the
   * DM added, and only while it is unsettled: a settled one may have
   * created an entity other rows link to, so it is reopened first.
   */
  function removeAddedRow(rows, row) {
    if (!row.added) throw new Error('Only a row you added can be removed; mark a read row Not an entity instead.');
    if (row.status === 'settled') throw new Error('Reopen the row (Change) before removing it.');
    return rows.filter(r => r !== row);
  }

  /**
   * dismiss(row) — the words are not an entity (#113): Tavern, Shop and Main
   * St. in a place's description, Dwarves, Gnomes and Humans in what an NPC
   * said. The row is settled with no entity, so it makes no publish item
   * (toQueueItems, newEntities and flags all pass it by) and the words stay
   * only in the passage they came from.
   *
   * Why: every row had to become an entity or link to one, so words like
   * these could only be acknowledged as new entities, and publish created
   * junk bestiary entries (#17, F1). A dismissed occurrence a fact still
   * names is not guessed at: as a target its words are kept as target_text,
   * as an actor its facts are held back (the round grid), and a passage
   * attached to it goes on the session (ChronicleFacts.passageItems).
   * Change (reopen) undoes it like any other answer.
   */
  function dismiss(row) {
    row.resolution = { action: 'dismiss' };
    row.status = 'settled';
  }

  /**
   * reopen(row, rows) → keys of every row reopened.
   * Undoes the row's answer so it can be settled again. If the row created
   * an entity that other rows link to, those rows are reopened too: their
   * link would otherwise point at an entity that no longer exists.
   */
  function reopen(row, rows) {
    const made = new Set([...newEntities([row]).keys()]);
    row.status = 'pending';
    row.resolution = null;
    const reopened = [row.key];
    // A link names its new entity in entityId; a sub-type (#119) may lean on
    // a new combat, a new creature or both. Either way the answer no longer
    // makes sense once the entity it points at is gone, so it reopens too.
    const leansOnMade = res => res?.toNew && [res.entityId, res.combatId, res.creatureId].some(id => id && made.has(id));
    for (const r of rows || []) {
      if (r !== row && leansOnMade(r.resolution)) reopened.push(...reopen(r, rows));
    }
    return reopened;
  }

  // bulkAcknowledgeExact(rows) → how many were acknowledged. Only pending
  // exact matches qualify; a row the DM already answered is left alone.
  function bulkAcknowledgeExact(rows) {
    let n = 0;
    for (const r of rows) if (r.status === 'pending' && r.matchType === 'exact') { acknowledge(r); n++; }
    return n;
  }

  function allSettled(rows) {
    return rows.length > 0 && rows.every(r => r.status === 'settled');
  }

  /**
   * resolveOccurrences(rows, index) → Map occurrence id → { entityId } or
   * { needsAssignment: [entityId…] } (a split) or { roster: {combatId, label} }
   * (a sub-type, whose occurrences are the new roster group).
   * This is the table facts and passages (#101, #102) will read: they point
   * at an occurrence, and this says what it means now.
   */
  function resolveOccurrences(rows, index) {
    const out = new Map();
    for (const r of rows) {
      const res = r.resolution;
      for (const o of r.occurrences) {
        if (!res) out.set(o.id, { pending: true });
        // Not an entity (#113): settled, but nothing for a fact to point at.
        else if (res.action === 'dismiss') out.set(o.id, { dismissed: true });
        else if (res.action === 'split') out.set(o.id, { needsAssignment: res.parts.map(p => p.entityId) });
        else if (res.action === 'subtype') out.set(o.id, { roster: { combatId: res.combatId, label: res.label }, entityId: res.creatureId });
        else {
          // A roster group's made-up id is turned back into its combat and
          // label, with the creature it points at, like a sub-type.
          const g = index && index.entities.get(res.entityId);
          if (g && g.array === 'enemies_roster') out.set(o.id, { roster: { combatId: g.combatId, label: g.name }, entityId: g.monRef });
          else out.set(o.id, { entityId: res.entityId });
        }
      }
    }
    return out;
  }

  /**
   * flags(rows, index) → [{ type, entityId, name, detail, occurrenceIds }]
   *
   * The automatic checks for one entity that is really two (design: "When
   * one entity is really two"):
   *   acts-twice    — the same entity takes its own turn twice in one round
   *                   of one combat. Groups (bestiary, cohorts, factions) are
   *                   left out: a roster group can have several members.
   *   two-places    — the same entity at two different locations in one scene
   *   allegiance    — the same entity described as ally and enemy in one scene
   * Uses each row's current answer, so a flag clears once the DM splits or
   * relinks the row. A split row's occurrences are skipped: they are being
   * assigned in step 4 anyway.
   */
  function flags(rows, index) {
    const made = newEntities(rows);
    const byEntity = new Map();
    for (const r of rows) {
      const res = r.resolution;
      const id = res ? (res.action === 'split' ? null : res.action === 'subtype' ? res.combatId + ':' + res.label : res.entityId) : r.matchId;
      if (!id) continue;
      const name = res?.name || res?.label || index.entities.get(id)?.name || made.get(id)?.name || r.asWritten;
      // A sub-type is a roster group, so it counts as a group for acts-twice.
      const array = res?.action === 'subtype' ? 'enemies_roster' : (res?.array || index.entities.get(id)?.array || made.get(id)?.array);
      if (!byEntity.has(id)) byEntity.set(id, { name, array, occ: [] });
      byEntity.get(id).occ.push(...r.occurrences);
    }
    const out = [];
    const isGroup = a => ['bestiary', 'cohorts', 'factions', 'enemies_roster'].includes(a);
    for (const [id, { name, array, occ }] of byEntity) {
      const groups = (keyFn, valFn) => {
        const m = new Map();
        for (const o of occ) {
          const k = keyFn(o), v = valFn(o);
          if (k == null || v == null) continue;
          if (!m.has(k)) m.set(k, new Map());
          const vals = m.get(k);
          if (!vals.has(v)) vals.set(v, []);
          vals.get(v).push(o.id);
        }
        return m;
      };
      if (!isGroup(array)) {
        // Two occurrences acting in the same round of the same combat, on
        // their own turn. Keyed by combat and round; counted by occurrence.
        const acts = new Map();
        for (const o of occ) {
          if (o.turnRound == null) continue;
          const k = norm(o.combatRef || '') + '#' + o.turnRound;
          if (!acts.has(k)) acts.set(k, []);
          acts.get(k).push(o.id);
        }
        for (const [k, ids] of acts) if (ids.length > 1) {
          out.push({ type: 'acts-twice', entityId: id, name, detail: `takes a turn ${ids.length} times in round ${k.split('#')[1]}`, occurrenceIds: ids });
        }
      }
      for (const [scene, vals] of groups(o => o.scene == null ? null : o.page + '/' + o.scene, o => o.location ? norm(o.location) : null)) {
        if (vals.size > 1) out.push({ type: 'two-places', entityId: id, name,
          detail: `is at ${[...vals.keys()].join(' and ')} in the same scene (page ${scene.split('/')[0]})`, occurrenceIds: [...vals.values()].flat() });
      }
      for (const [scene, vals] of groups(o => o.scene == null ? null : o.page + '/' + o.scene, o => o.allegiance)) {
        if (vals.has('ally') && vals.has('enemy')) out.push({ type: 'allegiance', entityId: id, name,
          detail: `is described as both ally and enemy in one scene (page ${scene.split('/')[0]})`, occurrenceIds: [...vals.get('ally'), ...vals.get('enemy')] });
      }
    }
    return out;
  }

  /**
   * toQueueItems(rows, index, sessionLegacyId) → approved queue items for
   * ChroniclePublish.applySession.
   *
   *   new / separate / split parts → NEW entity with the fresh UUID, its name,
   *                                  and the words as an alias when they differ
   *   acknowledge (inexact) / link → MOD _alias_append on the entity
   *   separate                     → MOD _note_append on the look-alike
   *   subtype                      → MOD _roster_group_append on the combat,
   *                                  or the group in the NEW combat's roster
   *                                  when this step 3 creates the combat (#119)
   * Exact acknowledgements write nothing: the data already says it.
   * One alias item per entity, so two spellings linked to Belfar add both.
   */
  function toQueueItems(rows, index, sessionLegacyId) {
    const items = [];
    const aliases = new Map(); // entityId → Set of aliases
    const addAlias = (id, a) => {
      if (!a) return;
      if (!aliases.has(id)) aliases.set(id, []);
      if (!aliases.get(id).some(x => norm(x) === norm(a))) aliases.get(id).push(a);
    };
    const created = new Map(); // id → its NEW item's rawData, for aliases linked to it
    const subtypes = []; // sub-type answers, written after every NEW item (#119)
    const newEntity = (array, id, name, asWritten) => {
      const rawData = { _object_type: OBJECT_TYPE[array], id };
      created.set(id, rawData);
      rawData[TITLE_ARRAYS.has(array) ? 'title' : 'name'] = name;
      if (asWritten && norm(asWritten) !== norm(name)) rawData.aliases = [asWritten];
      if (array !== 'combat_encounters') Object.assign(rawData, { mechanics: {}, narrative: {}, notes: null });
      // The session it first appears in, in the field its array uses, so
      // publish can derive npcs_met and the party's relationships from it
      // (#106). The session is named by its session_NNN; publish translates
      // it. Other arrays have no first-appearance field.
      const FIRST = { npc_directory: 'first_appeared', quest_ledger: 'origin_session', world_lore: 'first_established' };
      if (FIRST[array] && sessionLegacyId) rawData.mechanics[FIRST[array]] = sessionLegacyId;
      items.push({ id: 'ident_new_' + id, type: 'NEW', array, status: 'approved', title: `New ${OBJECT_TYPE[array]}: ${name}`, rawData });
    };
    for (const r of rows) {
      const res = r.resolution;
      if (!res) continue;
      if (res.action === 'new') newEntity(res.array, res.entityId, res.name, r.asWritten);
      else if (res.action === 'acknowledge' || res.action === 'link') addAlias(res.entityId, res.alias);
      else if (res.action === 'separate') {
        newEntity(res.array, res.entityId, res.name, r.asWritten);
        const other = index.entities.get(res.notConfusedWith);
        if (other) items.push({ id: 'ident_note_' + other.id + '_' + res.entityId, type: 'MOD', array: other.array, status: 'approved',
          targetId: other.id, title: `Note on ${other.name}`,
          rawData: { id: other.id, _note_append: `Not to be confused with ${res.name}${sessionLegacyId ? ', first noted in ' + sessionLegacyId : ''}.` } });
      } else if (res.action === 'split') {
        for (const p of res.parts) if (!p.existing) newEntity(p.array, p.entityId, p.name, null);
      } else if (res.action === 'subtype') {
        subtypes.push(res);
      }
    }
    // Sub-types go last, once every NEW item exists: the combat a sub-type
    // fights in may be created by a row sorted after it (#119).
    for (const res of subtypes) {
      const group = { actor_id: res.label, type: 'group', mon_ref: res.creatureId, count: null, count_remaining: null, notes: null, role: res.role };
      const freshCombat = created.get(res.combatId);
      if (freshCombat) {
        // A combat this step 3 creates gets the group in its NEW item's
        // roster, so the combat is written whole in one item rather than
        // created and then changed by a MOD that must find it.
        freshCombat.mechanics = freshCombat.mechanics || {};
        const roster = freshCombat.mechanics.enemies_roster = freshCombat.mechanics.enemies_roster || [];
        if (!roster.some(g => g.actor_id === group.actor_id)) roster.push(group);
        continue;
      }
      items.push({ id: 'ident_roster_' + res.combatId + '_' + norm(res.label), type: 'MOD', array: 'combat_encounters', status: 'approved',
        targetId: res.combatId, title: `Roster group ${res.label}`,
        rawData: { id: res.combatId, _roster_group_append: group } });
    }
    for (const [id, list] of aliases) {
      // Words linked to an entity this session creates go on its NEW item.
      const fresh = created.get(id);
      if (fresh) {
        const name = norm(fresh.name || fresh.title);
        for (const a of list) {
          if (norm(a) === name || (fresh.aliases || []).some(x => norm(x) === norm(a))) continue;
          fresh.aliases = (fresh.aliases || []).concat(a);
        }
        continue;
      }
      const e = index.entities.get(id);
      // Roster groups have no aliases field to hold one (#93 put aliases on
      // entities only), so a spelling linked to a group is not saved.
      if (!e || e.array === 'enemies_roster') continue;
      items.push({ id: 'ident_alias_' + id, type: 'MOD', array: e.array, status: 'approved', targetId: id,
        title: `Aliases for ${e.name}`, rawData: { id, _alias_append: list } });
    }
    return items;
  }

  // ── The AI pass (step 2) ──────────────────────────────────────────────────
  // The prompt and the parser live here, beside buildRows, because they are
  // its contract: the fields the prompt asks for are the fields buildRows
  // and flags read. chronicle-ai.js only sends the request (it needs a key
  // and a network, so the tests cannot run it).

  /**
   * mentionPrompt({ entityList, pageLabel }) → system prompt for one page.
   *
   * Asks for every mention, each time it occurs, with the words exactly as
   * written. The AI may propose a candidate only by id from entityList; it
   * never decides whether a row is an exact match (buildRows does). Spells,
   * abilities, dice and real people (the players, the DM) are excluded: they
   * are not campaign entities.
   */
  function mentionPrompt({ entityList, pageLabel }) {
    return `You read one page of a Dungeon Master's handwritten session notes for a D&D campaign and list every mention of a campaign entity on it. You do not summarise or record what happened; that is a later step.

PAGE: ${pageLabel}

WHAT COUNTS AS AN ENTITY (the "kind" field):
- pc: a player character. The notes usually use a short form (for example "Asp", "Mal", "Gold").
- npc: a named or described non-player person ("the wizard", "Ched").
- creature: a monster or animal, singly or as a group ("Goblins", "dragon", "#2 Dragon", "Slinger").
- faction: an organisation. cohort: a recurring group of people or creatures tied to a place or quest.
- place: a location. thing: a notable object or treasure the party finds or handles (not a PC's ordinary weapon).
- combat: a fight as a whole ("the ambush", "Combat Ended" refers to the current combat). quest: a mission or goal.
- moment: a significant character moment. lore: a piece of knowledge, history or rumour.
NOT entities: spells, class features and abilities (Witch Bolt, True Strike, Flurry of Blows), conditions, dice, damage numbers, and real people (players, the DM, "played by ...").

RULES:
1. One mention per occurrence: every time an entity appears, including once per round line it appears in.
2. as_written: only the words that name the entity, exactly as they appear, keeping misspellings, abbreviations, numbering and plurals ("Mail", "Larkspur Drag", "#1"). Never correct or expand them, and leave out words around the name that say what happened ("Goblins" from "Goblins Flee", "Goblin" from "Dead Goblin").
3. context: the full line of the notes the mention is on, as written.
4. round: the round number when the mention is inside a "Round N" block, else null.
5. turn_round: the round number when this mention is the one taking its own turn on that line (the name the line starts with, or the group whose turn it is), else null. A target or an opportunity attack against someone is not their turn.
6. combat_ref: the combat the line belongs to, as the id of an OPEN COMBAT from the list when the page continues one, else a short name as written, else null.
7. scene: 1 for the first scene on the page, counting up each time the situation or place clearly changes. location: the place the mention is at, as written, only when the notes say it; else null.
8. allegiance: "ally", "enemy" or "neutral" only when the notes state it or the mention is plainly fighting on one side; else null.
9. candidate_id: the id of the existing entity this mention most likely refers to, copied exactly from the list below, or null. Never invent an id. candidate_reason: a few words on why ("PC nickname", "continues the paused ambush").
10. Read the whole page, including words written in margins or above other words.

EXISTING ENTITIES (id | array | name (other names) [OPEN COMBAT]):
${entityList}

Respond with JSON only, no prose:
{"mentions":[{"kind":"pc","as_written":"Asp","context":"Asp - Healing Hands","round":4,"turn_round":4,"combat_ref":null,"scene":1,"location":null,"allegiance":"ally","candidate_id":null,"candidate_reason":""}]}`;
  }

  /**
   * parseMentions(text) → { mentions: [...] }
   *
   * Takes the JSON object out of the AI's reply (it may be fenced in ```json
   * or have words around it) and checks its shape. Throws with a plain
   * message on anything else, so the page shows an error for that page and
   * never proceeds with a guessed or partial list.
   */
  function parseMentions(text) {
    const s = String(text || '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    let body = fenced ? fenced[1] : s;
    const start = body.indexOf('{'), end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The AI reply had no JSON in it.');
    body = body.slice(start, end + 1);
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { throw new Error('The AI reply was not valid JSON: ' + e.message); }
    if (!parsed || !Array.isArray(parsed.mentions)) throw new Error('The AI reply has no "mentions" list.');
    const bad = parsed.mentions.filter(m => !m || typeof m.as_written !== 'string' || !m.as_written.trim());
    if (bad.length) throw new Error(`${bad.length} mention(s) in the AI reply have no as_written words.`);
    return parsed;
  }

  const api = {
    KINDS, norm, buildIndex, entityListForPrompt, mentionPrompt, parseMentions, buildRows, sortRows,
    newEntities, acknowledge, linkToExisting, separateAsNew, split, markSubType, reopen, setKind, dismiss, addRow, removeAddedRow,
    bulkAcknowledgeExact, allSettled, resolveOccurrences, flags, toQueueItems,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChronicleEntities = api;
})(typeof window !== 'undefined' ? window : globalThis);
