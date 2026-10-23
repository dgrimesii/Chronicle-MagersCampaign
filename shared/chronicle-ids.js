/**
 * shared/chronicle-ids.js
 *
 * Opaque campaign IDs, and the legacy typed IDs they replaced (issue #95).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Chronicle used typed sequential IDs such as npc_014. Storyteller's hosting
 * plan (constraint C15) requires IDs that are opaque, non-sequential and say
 * nothing about type, and Chronicle adopts the same kind for consistency
 * across the platform. The DM chose UUID version 4 on issue #95: Postgres
 * generates them natively, and two stores built independently cannot clash
 * when they are merged.
 *
 * Every entity keeps its old typed ID as `legacy_id`. The AI prompts, the
 * DM's session numbers ("session_008") and years of notes still speak legacy
 * IDs, so anything that accepts an ID from outside the data must turn a
 * legacy ID into the real one. This module is the one place that knows how.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChronicleIds (and module.exports under Node):
 *   ENTITY_ARRAYS          — the root arrays whose objects carry an opaque id
 *   newId()                — a fresh UUID v4
 *   isOpaqueId(s)          — whether s is a UUID
 *   isLegacyId(s)          — whether s looks like a typed ID (npc_014)
 *   forEachEntity(c, fn)   — every object that carries an opaque id
 *   buildLegacyIndex(c)    — Map of legacy_id → id
 *   translateRefs(v, idx)  — a copy of v with every legacy ID replaced
 *   findEntity(c, id)      — the entity with that id or legacy_id
 *
 * It has no dependencies and touches no page state, so it loads in any order
 * relative to the other shared modules and runs unchanged under Node for the
 * migration script and the tests.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * scripts/migrate-opaque-ids.js could not assign or check IDs. Delta Review's
 * publish would write the AI's legacy IDs (pc_001) into data that now uses
 * UUIDs, leaving references that resolve to nothing, and would give new
 * entities typed sequential IDs again. The narrative module could not match
 * a legacy actor ID to its party member.
 */

(function(root) {
  'use strict';

  // The root arrays whose objects are campaign entities and get an opaque id.
  // prompt_improvement_log and deferred_gaps are deliberately absent: they are
  // workflow records, never referenced by an entity, so they keep their
  // pil_/gap_ IDs. Quest objectives are nested, so forEachEntity adds them.
  const ENTITY_ARRAYS = [
    'party', 'session_logs', 'npc_directory', 'bestiary', 'world_lore',
    'inventory_and_loot', 'locations', 'quest_ledger', 'combat_encounters',
    'character_moments', 'entity_relationships', 'factions', 'cohorts',
  ];

  // A typed ID as Chronicle wrote them before #95: a known type prefix, an
  // underscore and a number. Anchored at both ends so prose that merely
  // mentions an ID ("Killed by pc_006") never matches.
  const LEGACY_ID = /^(pc|npc|loc|qst|item|cbt|mon|lore|session|moment|obj|rel|fac|coh)_\d+$/;

  // UUID in the 8-4-4-4-12 hyphenated form. Any version is accepted, so an ID
  // allocated later by Postgres or another tool still counts as opaque.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * newId() — a fresh lowercase UUID v4.
   *
   * Why: the one place IDs are minted, so a move to store-allocated IDs
   * (Postgres, rebuild phase 7) changes only this function. Uses the Web
   * Crypto API, present in every current browser on https or localhost and in
   * Node 19+. If it were removed, new entities would have no id at all.
   */
  function newId() {
    return root.crypto.randomUUID();
  }

  /** isOpaqueId(s) — true when s is a UUID string. */
  function isOpaqueId(s) {
    return typeof s === 'string' && UUID.test(s);
  }

  /** isLegacyId(s) — true when s is a typed sequential ID such as npc_014. */
  function isLegacyId(s) {
    return typeof s === 'string' && LEGACY_ID.test(s);
  }

  /**
   * forEachEntity(campaign, fn) — calls fn(obj, arrayName) for every object
   * that carries an opaque id: each entry of ENTITY_ARRAYS, plus each quest
   * objective (arrayName 'quest_ledger.objectives').
   *
   * Why: the migration, the legacy index and the reference check must all
   * agree on which objects own an id. If one of them walked a different set,
   * a reference could be checked against an index that never saw its target.
   */
  function forEachEntity(campaign, fn) {
    for (const arr of ENTITY_ARRAYS) {
      for (const obj of campaign?.[arr] || []) {
        fn(obj, arr);
        // Objectives have their own obj_ IDs and are linked from elsewhere,
        // so they are entities in their own right, nested inside a quest.
        if (arr === 'quest_ledger') {
          for (const o of obj.mechanics?.objectives || []) fn(o, 'quest_ledger.objectives');
        }
      }
    }
  }

  /**
   * buildLegacyIndex(campaign) → Map of legacy_id → id.
   *
   * Why: every lookup of an outside ID goes through this map. Built fresh
   * from the data each time rather than cached, so it can never disagree with
   * the campaign it came from.
   */
  function buildLegacyIndex(campaign) {
    const index = new Map();
    forEachEntity(campaign, obj => {
      if (obj.legacy_id && obj.id) index.set(obj.legacy_id, obj.id);
    });
    return index;
  }

  /**
   * translateRefs(value, index) → a deep copy of value in which every string
   * that exactly equals a legacy ID in index is replaced by its opaque id.
   *
   * Why: incoming data (AI output, the DM's session number) names entities
   * by legacy ID. Translating whole objects, rather than a list of known
   * reference fields, also catches fields added later. Only exact matches
   * change: prose that mentions an ID keeps it, and legacy_id fields are
   * skipped so an entity's own record of its old ID survives.
   */
  function translateRefs(value, index) {
    if (typeof value === 'string') return index.has(value) ? index.get(value) : value;
    if (Array.isArray(value)) return value.map(v => translateRefs(v, index));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = k === 'legacy_id' ? v : translateRefs(v, index);
      }
      return out;
    }
    return value;
  }

  /**
   * findEntity(campaign, idOrLegacy) → { entity, array } or null.
   *
   * Why: pages and modules receive IDs from links, prompts and old notes.
   * Accepting either form here means a legacy ID keeps resolving, as #95
   * requires, without every caller building its own index.
   */
  function findEntity(campaign, idOrLegacy) {
    let found = null;
    forEachEntity(campaign, (obj, array) => {
      if (!found && (obj.id === idOrLegacy || obj.legacy_id === idOrLegacy)) found = { entity: obj, array };
    });
    return found;
  }

  const api = {
    ENTITY_ARRAYS, LEGACY_ID, UUID,
    newId, isOpaqueId, isLegacyId, forEachEntity, buildLegacyIndex, translateRefs, findEntity,
  };

  // Browser pages read window.ChronicleIds; Node (migration script, tests)
  // requires the file. One source serves both so they cannot drift.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChronicleIds = api;
})(typeof window !== 'undefined' ? window : globalThis);
