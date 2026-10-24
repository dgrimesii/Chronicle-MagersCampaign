/**
 * shared/chronicle-publish.js
 *
 * Applies one session's confirmed review results to the campaign (issue #92).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Publish used to live inside admin/delta-review.html as applyDeltasToCampaign().
 * It wrote the AI's flat round entries ({act, res, val}) straight into the data,
 * which the viewers' flattenSlot() cannot read; it published the intake session
 * stub with its fields under the wrong names, so the date and summary came out
 * blank; and it appended a new session instead of filling the session_006 /
 * session_007 placeholders. Because the function sat inside the page, the tests
 * ran against a copy of it, and the copy had drifted.
 *
 * Moving the logic here means the page and the tests run the same code, and
 * every later phase of the intake rebuild (repo publish #97, the new session
 * page) builds on one function that writes correct data.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChroniclePublish (and module.exports under Node):
 *   applySession(campaign, approved, options) → { campaign, notes }
 *     campaign — the campaign JSON publish builds on. Never mutated.
 *     approved — the DM's approved queue items (NEW, MOD, ROUND, RELATIONSHIP;
 *                RAW and anything else is ignored). Never mutated. A MOD may
 *                carry _alias_append, _note_append or _roster_group_append
 *                from the session page's entity identification (#100), or
 *                _passage_append from its narrative passages (#102); those
 *                add to the object instead of replacing fields.
 *     options  — { deferredGaps, promptLog, spellNames, now }, all optional:
 *                deferredGaps — integrity gaps the DM deferred (gap_NNN records)
 *                promptLog    — prompt-improvement entries captured at intake
 *                spellNames   — every spell the party knows (pc-abilities.json),
 *                               so "Fire Bolt" is recorded as Magic · Fire Bolt
 *                now          — a Date, for the publish timestamps (tests fix it)
 *     Returns the updated campaign and a list of notes: plain sentences about
 *     anything publish had to decide or could not place, for the DM to read.
 *   deriveFields(campaign)          — recomputes the derived fields in place
 *   STANDARD_ACTIONS                — the twelve standard action names
 *   sessionChoices(campaign)        — the sessions the session page offers at
 *                                     upload: placeholders first, then the next
 *                                     new session ID (issue #99)
 *   sessionHeader(legacyId, date)   — the queue item that carries the chosen
 *                                     session ID and date to applySession (#99)
 *
 * It depends on shared/chronicle-ids.js (window.ChronicleIds, or require under
 * Node) and nothing else: no DOM, no sessionStorage, no network. Load it after
 * chronicle-ids.js.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * Delta Review's Publish button would have nothing to apply the queue with,
 * and tests/delta-apply.test.js would have nothing to test.
 */

(function(root) {
  'use strict';

  // chronicle-ids.js is required directly under Node; in the browser it is a
  // page script loaded before this one. Looked up at call time, not load time,
  // so the order the two script tags happen to run in cannot leave it unset.
  const NodeIds = (typeof module !== 'undefined' && module.exports) ? require('./chronicle-ids.js') : null;
  function Ids() {
    const ids = NodeIds || root.ChronicleIds;
    if (!ids) throw new Error('ChroniclePublish needs shared/chronicle-ids.js loaded first');
    return ids;
  }

  // ── Vocabulary (from the data file's own _field_type_reference) ───────────

  // The twelve standard actions of the 2024 rules. For the action economy an
  // activity's name must be one of these (or Death Save / No Action); the
  // spell or weapon goes in detail. Same list as scripts/migrate-turn-schema.js.
  const STANDARD_ACTIONS = ['Attack', 'Dash', 'Disengage', 'Dodge', 'Help', 'Hide',
    'Influence', 'Magic', 'Ready', 'Search', 'Study', 'Utilize'];

  // The AI's action_type values mapped to the 5.0.0 economy enum. The AI says
  // "free_action"; the schema says "free". A missing action_type means the AI
  // could not tell, and the turn's main action is by far the common case, so
  // it is recorded as the action (and counted in the notes).
  const ECONOMY = {
    action: 'action', bonus_action: 'bonus_action', reaction: 'reaction',
    free_action: 'free', free: 'free', movement: 'movement',
    legendary_action: 'legendary_action', legendary_resistance: 'legendary_resistance',
  };

  // slot_result enum. Anything else the AI writes is normalised below.
  const RESULTS = ['hit', 'miss', 'crit', 'save', 'success', 'failure', 'death', 'neutral', 'unclear'];

  // A turn a condition prevented. The design records these as
  // "No Action: <reason>" (migrate-turn-schema.js turned "Stable" into
  // "No Action: Stable"), never as an activity named after the condition.
  const PREVENTED = /^(stable|stabili[sz]ed|unconscious|incapacitated|paral[yi][sz]ed|stunned|petrified|asleep|downed)$/i;

  // The roster label publish uses when an enemy line names no group it can
  // match. Recording it as unidentified, and saying so in the notes, is
  // honest; guessing a group would put the action on the wrong creature.
  const UNIDENTIFIED = 'Unidentified enemies';

  // ── Small helpers ──────────────────────────────────────────────────────────

  // norm(s) — a name reduced for matching: lowercase, punctuation dropped,
  // spaces collapsed. "Goli," and "goli" match; nothing fuzzier than that,
  // because a loose match would quietly attach a target to the wrong entity.
  function norm(s) {
    return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // variants(s) — norm(s) plus its singular forms, so the notes' "goblin"
  // matches the roster's "Goblins" and "wolf"/"wolves" both match "Wolves".
  function variants(s) {
    const n = norm(s);
    const out = new Set([n]);
    if (n.length > 3 && n.endsWith('s')) out.add(n.slice(0, -1));
    if (n.length > 4 && n.endsWith('es')) out.add(n.slice(0, -2));
    if (n.endsWith('ves')) out.add(n.slice(0, -3) + 'f');
    return [...out].filter(Boolean);
  }

  const isEmpty = v => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const clone   = v => JSON.parse(JSON.stringify(v));

  // pushUnique(arr, v) — append v unless already present; keeps the stored
  // order and adds new values at the end, so a recompute never reshuffles
  // what the DM sees.
  function pushUnique(arr, v) {
    if (v != null && !arr.includes(v)) arr.push(v);
  }

  // num(v) — a stated number, or null. The AI sometimes returns "9" as a
  // string; a value that is not a number at all is not invented into one.
  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ── Notes back to the DM ──────────────────────────────────────────────────

  // makeNotes() — a de-duplicated list of sentences. Publish records each
  // decision it made on the DM's behalf (an assumed Attack, a merged round, a
  // kept placeholder date) once, however many rounds it applied to.
  function makeNotes() {
    const list = [];
    const seen = new Set();
    return {
      add(msg) { if (!seen.has(msg)) { seen.add(msg); list.push(msg); } },
      list,
    };
  }

  // ── Name index for targets ────────────────────────────────────────────────

  /**
   * buildNameIndex(campaign) → { party, npcs, bestiary }, each a Map of
   * normalised name → id.
   *
   * Why: the AI writes targets as the notes do ("Del", "goblin"), never as
   * ids (its prompt forbids ids). Publish resolves each to the entity it
   * names so a round's target_id points at an entity, as the turn schema
   * requires. A party member is indexed by name and nickname.
   */
  function buildNameIndex(campaign) {
    const party = new Map(), npcs = new Map(), bestiary = new Map();
    for (const p of campaign.party || []) {
      for (const n of [p.name, p.nickname]) if (n) party.set(norm(n), p.id);
    }
    for (const n of campaign.npc_directory || []) if (n.name) npcs.set(norm(n.name), n.id);
    for (const b of campaign.bestiary || []) {
      for (const v of variants(b.name)) if (v && !bestiary.has(v)) bestiary.set(v, b.id);
    }
    return { party, npcs, bestiary };
  }

  // rosterOf(combat) — the combat's enemies_roster, created empty when a
  // combat (a new one, or a hand-written one) has none, so groups can be
  // added and the reference check can read it.
  function rosterOf(combat) {
    if (!combat.mechanics) combat.mechanics = {};
    if (!Array.isArray(combat.mechanics.enemies_roster)) combat.mechanics.enemies_roster = [];
    return combat.mechanics.enemies_roster;
  }

  // findRosterGroup(combat, label) — the roster group a written label names,
  // matching singular and plural forms. null when there is none.
  function findRosterGroup(combat, label) {
    const want = new Set(variants(label));
    return rosterOf(combat).find(g => variants(g.actor_id).some(v => want.has(v))) || null;
  }

  /**
   * addRosterGroup(combat, label, ctx) → the new group.
   *
   * Why: an enemy line can name a group the roster does not have yet, most
   * often in a combat created this session (its roster starts empty) or a
   * creature that joins mid-fight. The group is recorded exactly as the notes
   * labelled it, pointing at the bestiary entry with that name when there is
   * one, in the shape every existing roster group has.
   */
  function addRosterGroup(combat, label, ctx) {
    const monRef = variants(label).map(v => ctx.names.bestiary.get(v)).find(Boolean) ?? null;
    const group = { actor_id: label, type: 'group', mon_ref: monRef, count: null, count_remaining: null, notes: null };
    rosterOf(combat).push(group);
    ctx.notes.add(`${combat.name || 'A combat'}: added enemy group "${label}" to its roster` +
      (monRef ? '.' : ' (no bestiary entry matched; check it).'));
    return group;
  }

  /**
   * resolveTargets(text, actorId, combat, ctx) → [{ target_id, target_text? }]
   *
   * Turns one written target into outcome target fields, following the rule
   * the DM set on #93: target_id is an entity id or a roster label, or null;
   * text that names no entity is kept as written in target_text; nothing is
   * invented. A slash-joined target ("Del/Goli") becomes one entry per target.
   * Order of matching: an id already in the data, "self", this combat's
   * roster, the party, NPCs, then a bestiary creature fought here as a group.
   */
  function resolveTargets(text, actorId, combat, ctx) {
    if (text == null || String(text).trim() === '') return [{ target_id: null }];
    return String(text).split('/').map(s => s.trim()).filter(Boolean).map(t => {
      if (ctx.knownIds.has(t)) return { target_id: t };
      if (/^(self|himself|herself|themselves|themself)$/i.test(t)) return { target_id: actorId ?? null };
      const g = findRosterGroup(combat, t);
      if (g) return { target_id: g.actor_id };
      const key = norm(t);
      const id = ctx.names.party.get(key) ?? ctx.names.npcs.get(key);
      if (id) return { target_id: id };
      // "goblin" when the roster calls the group "Goblin Warband": the
      // creature is known, so point at the first group of that creature.
      const mon = variants(t).map(v => ctx.names.bestiary.get(v)).find(Boolean);
      const byMon = mon && rosterOf(combat).find(gr => gr.mon_ref === mon);
      if (byMon) return { target_id: byMon.actor_id };
      return { target_id: null, target_text: t };
    });
  }

  // ── Activity names ─────────────────────────────────────────────────────────

  /**
   * nameAndDetail(act, economy, ctx) → { name, detail? }
   *
   * Splits the AI's literal action text into the 5.0.0 activity name and
   * optional detail. For the action economy the name must be a standard
   * action, Death Save or No Action, and the spell or weapon goes in detail
   * (Magic · Fire Bolt, Attack · Shortbow); for other economies the design
   * names the feature or spell itself (Flurry of Blows, Healing Word).
   *
   * The AI gives no spell/attack type, so a spell is recognised by name from
   * the party's spell lists (options.spellNames). Anything else is assumed to
   * be a weapon or attack, the same assumption migrate-turn-schema.js makes
   * for untyped actions, and the assumption is reported once per name so the
   * DM can see it. Changing these rules changes every published round.
   */
  function nameAndDetail(act, economy, ctx) {
    const raw = String(act ?? '').trim();
    if (economy !== 'action') {
      if (!raw) ctx.notes.add('An activity with no name was recorded as "Unknown".');
      return { name: raw || 'Unknown' };
    }
    if (!raw || /^(unclear|unknown|\?+)$/i.test(raw)) {
      // Kept as written: an unreadable action is a fact about the notes,
      // and naming it "Attack" would assert something nobody recorded.
      ctx.notes.add('An unreadable action was recorded as "Unclear"; correct it from the notes.');
      return { name: 'Unclear' };
    }
    if (/^death\s*save/i.test(raw)) return { name: 'Death Save' };
    if (/^(no action|none)$/i.test(raw)) return { name: 'No Action' };
    const reason = raw.match(/^no action\s*[:\-–]\s*(.+)$/i);
    if (reason) return { name: 'No Action: ' + reason[1].trim() };
    if (PREVENTED.test(raw)) return { name: 'No Action: ' + raw };
    const ready = raw.match(/^ready\s*[:\-–]?\s+(.+)$/i);
    if (ready) return { name: 'Ready', detail: ready[1].trim() };
    const std = STANDARD_ACTIONS.find(a => a.toLowerCase() === raw.toLowerCase());
    if (std) return { name: std };
    if (/^\d*\s*attacks?$/i.test(raw)) return { name: 'Attack' };
    // "True Strike (Scimitar)", "Acid Splash (2 targets) [?]": the spell is
    // the text before any bracket. The full text stays as the detail.
    const base = raw.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    if (ctx.spells.has(norm(base))) return { name: 'Magic', detail: raw };
    ctx.notes.add(`"${raw}" is not a known spell or standard action; recorded as Attack · ${raw}.`);
    return { name: 'Attack', detail: raw };
  }

  /**
   * normResult(res, name, ctx) → a slot_result value, or null.
   *
   * The AI's result words are mostly the schema's, with two exceptions. For a
   * saving-throw spell it writes "fail" when the target failed its save, which
   * means the spell took effect: recorded as hit, the counterpart of "save".
   * For a death save the design uses success/failure, so hit/miss/fail are
   * relabelled. An unknown word becomes "unclear" rather than a guess.
   */
  function normResult(res, name, ctx) {
    if (res == null || res === '') return null;
    let r = String(res).toLowerCase().trim();
    if (name === 'Death Save') {
      if (r === 'hit' || r === 'pass' || r === 'passed') return 'success';
      if (r === 'miss' || r === 'fail' || r === 'failed') return 'failure';
    }
    if (r === 'fail' || r === 'failed') r = 'hit';
    if (r === 'critical') r = 'crit';
    if (!RESULTS.includes(r)) {
      ctx.notes.add(`Result "${res}" is not a recorded result word; recorded as unclear.`);
      return 'unclear';
    }
    return r;
  }

  /**
   * outcomesFor(e, name, actorId, combat, ctx) → outcome[]
   *
   * One flat AI entry is one roll. It becomes one outcome per target, or none
   * when no roll was made (a neutral result with no value, such as Dash), as
   * the design says: "an activity with no roll has no outcomes". The AI's
   * target_effects become the outcome's effect when they are a down or a kill
   * (the only two effects the schema has); other conditions (prone, stunned)
   * are kept in the outcome's notes so they are not lost.
   */
  function outcomesFor(e, name, actorId, combat, ctx) {
    const res = normResult(e.res, name, ctx);
    const val = num(e.val);
    if (e.val != null && e.val !== '' && val == null) {
      ctx.notes.add(`Value "${e.val}" is not a number; recorded as no value.`);
    }
    if ((res == null || res === 'neutral') && val == null) return [];
    const effects = Array.isArray(e.target_effects) ? e.target_effects.map(x => String(x).toLowerCase()) : [];
    const effect = effects.includes('killed') ? 'killed' : effects.includes('downed') ? 'downed' : null;
    const other = effects.filter(x => x !== 'killed' && x !== 'downed');
    const targets = resolveTargets(e.target, actorId, combat, ctx);
    return targets.map(t => {
      // One damage roll that hit several named targets is one number, but it
      // cannot be split per target, so only a single target keeps it.
      const o = { res, val: targets.length > 1 ? null : val, ...t };
      if (effect) o.effect = effect;
      const notes = [e.notes, other.length ? other.join(', ') : null].filter(Boolean).join('; ');
      if (notes) o.notes = notes;
      return o;
    });
  }

  // ── Rounds ─────────────────────────────────────────────────────────────────

  // A flat entry from the AI (or an inline edit of one): one roll, with the
  // slot, actor and action text on every entry. Accepts the AI's own field
  // names (slot, actor_id, action, result, value) as well as the abbreviated
  // ones chronicle-ai.js normalises them to (s, a, act, res, val).
  function isFlatEntry(e) {
    return e && !Array.isArray(e.activities) && (e.act != null || typeof e.action === 'string');
  }
  function flatFields(e) {
    return {
      s: e.s ?? e.slot ?? null,
      a: e.a ?? e.actor_id ?? null,
      act: e.act ?? (typeof e.action === 'string' ? e.action : null),
      res: e.res ?? e.result ?? null,
      val: e.val ?? e.value ?? null,
      notes: e.notes ?? null,
      action_type: e.action_type ?? null,
      target: e.target ?? null,
      target_effects: e.target_effects ?? [],
      val_type: e.val_type ?? null,
    };
  }

  /**
   * convertSlots(list, combat, ctx, where) → 5.0.0 slot[]
   *
   * The AI writes one entry per roll: Del's two unarmed strikes and her
   * Flurry of Blows arrive as four entries on slot 1. A turn in 5.0.0 is one
   * slot holding activities, each with its outcomes, so entries are grouped:
   * by slot and actor into one slot, then consecutive entries with the same
   * economy and the same action text into one activity (one outcome each).
   * A slot already in 5.0.0 shape (activities[]) is kept as it is. Any other
   * shape is left out and reported, because writing it would put a turn the
   * viewers cannot read into the data.
   */
  function convertSlots(list, combat, ctx, where) {
    const slots = [];
    const byKey = new Map();
    // Slots built here from flat entries. Only these are tidied at the end;
    // a slot that arrived in 5.0.0 shape is written exactly as it came.
    const built = new Set();
    let untyped = 0;
    for (const raw of list || []) {
      if (raw && Array.isArray(raw.activities)) { slots.push(clone(raw)); continue; }
      if (!isFlatEntry(raw)) {
        ctx.notes.add(`${where}: a slot in an unrecognised shape was left out.`);
        continue;
      }
      const e = flatFields(raw);
      const key = e.s + '|' + e.a;
      let slot = byKey.get(key);
      if (!slot) {
        slot = { s: e.s, a: e.a, activities: [], notes: null };
        byKey.set(key, slot);
        built.add(slot);
        slots.push(slot);
      }
      if (e.action_type == null) untyped++;
      const economy = ECONOMY[e.action_type] ?? 'action';
      if (e.action_type != null && !ECONOMY[e.action_type]) {
        ctx.notes.add(`Action type "${e.action_type}" is not an action economy; recorded as the action.`);
      }
      const nd = nameAndDetail(e.act, economy, ctx);
      const outcomes = outcomesFor(e, nd.name, slot.a, combat, ctx);
      const last = slot.activities[slot.activities.length - 1];
      // _src remembers the action text the activity was built from, so the
      // next roll of the same action joins it. Removed before writing.
      if (last && last.economy === economy && last._src === String(e.act ?? '')) {
        last.outcomes.push(...outcomes);
        if (!outcomes.length && e.notes) last._notes.push(e.notes);
        continue;
      }
      const activity = { economy, name: nd.name };
      if (nd.detail) activity.detail = nd.detail;
      if (e.val_type) activity.val_type = e.val_type;
      activity.outcomes = outcomes;
      Object.defineProperty(activity, '_src', { value: String(e.act ?? ''), enumerable: false });
      Object.defineProperty(activity, '_notes', { value: (!outcomes.length && e.notes) ? [e.notes] : [], enumerable: false });
      slot.activities.push(activity);
    }
    for (const slot of built) {
      for (const act of slot.activities) finishActivity(act);
    }
    if (untyped) ctx.notes.add(`${untyped} action${untyped === 1 ? '' : 's'} had no action type from the AI; recorded as the turn's action.`);
    return slots.sort((x, y) => (x.s ?? 0) - (y.s ?? 0));
  }

  /**
   * finishActivity(act) — tidies one built activity for writing.
   *
   * Notes from rolls that produced no outcome sit on the activity. When the
   * activity has exactly one outcome, that outcome's note moves up to the
   * activity: the viewers show an activity's notes, not an outcome's, and the
   * migrated rounds keep a single roll's note on the activity the same way.
   * With several outcomes each roll keeps its own note (per-roll, like "Nat 1").
   */
  function finishActivity(act) {
    const notes = [...(act._notes || [])];
    if (act.outcomes.length === 1 && act.outcomes[0].notes) {
      notes.push(act.outcomes[0].notes);
      delete act.outcomes[0].notes;
    }
    if (notes.length) act.notes = [...new Set(notes)].join('; ');
  }

  /**
   * convertEnemies(list, combat, ctx, where) → 5.0.0 enemy_turn[]
   *
   * The AI returns enemy actions as free text, { desc: "Goblins: hit Del for
   * 7", impact: "Del downed" }, with no group id. The turn schema needs one
   * turn per roster group per round. The group is found from a "Label: …"
   * prefix, or from the text starting with a roster label, or — when the
   * combat has only one group — that group. A label the roster lacks is
   * added to it (addRosterGroup); a line with no usable label goes to an
   * "Unidentified enemies" group and is reported, rather than being pinned
   * on a guessed creature. The action text is kept as the activity's name,
   * since the AI gives it no structure to split (#101 changes the extraction).
   * impact becomes a special event. A turn already in 5.0.0 shape is merged
   * as it is.
   */
  function convertEnemies(list, combat, ctx, where) {
    const turns = [];
    const turnFor = actorId => {
      let t = turns.find(x => x.actor_id === actorId);
      if (!t) { t = { actor_id: actorId, activities: [], special_events: [], notes: null }; turns.push(t); }
      return t;
    };
    for (const raw of list || []) {
      if (raw && Array.isArray(raw.activities)) {
        const t = turnFor(raw.actor_id);
        t.activities.push(...clone(raw.activities));
        t.special_events.push(...clone(raw.special_events || []));
        if (raw.notes) t.notes = t.notes ? t.notes + '; ' + raw.notes : raw.notes;
        continue;
      }
      const desc = String(raw?.desc ?? raw?.description ?? '').trim();
      const impact = raw?.impact ? String(raw.impact).trim() : '';
      if (!desc && !impact) {
        ctx.notes.add(`${where}: an enemy entry in an unrecognised shape was left out.`);
        continue;
      }
      let group = null;
      let text = desc;
      const labelled = desc.match(/^([^:]{1,40}):\s*([\s\S]*)$/);
      if (labelled) {
        const label = labelled[1].trim();
        text = labelled[2].trim();
        group = findRosterGroup(combat, label) || addRosterGroup(combat, label, ctx);
      } else {
        // "Goblins hit Mal twice": the text opens with a roster label.
        const words = norm(desc);
        const roster = [...rosterOf(combat)].sort((x, y) => y.actor_id.length - x.actor_id.length);
        group = roster.find(g => variants(g.actor_id).some(v => words === v || words.startsWith(v + ' '))) || null;
        if (!group && rosterOf(combat).length === 1) group = rosterOf(combat)[0];
        if (!group) {
          group = findRosterGroup(combat, UNIDENTIFIED) || addRosterGroup(combat, UNIDENTIFIED, ctx);
          ctx.notes.add(`${where}: enemy line "${desc}" names no known group; recorded under "${UNIDENTIFIED}".`);
        }
      }
      const t = turnFor(group.actor_id);
      if (text) t.activities.push({ economy: 'action', name: text, outcomes: [] });
      if (impact) t.special_events.push({ type: 'other', description: impact });
    }
    return turns;
  }

  /**
   * convertRound(raw, combat, ctx) → a 5.0.0 round { n, sid, slots, enemy_turns }
   *
   * Accepts the round shapes Delta Review queues: the AI proposal shape
   * (rawData.session_id, flat slots, enemy_turns of {desc, impact}), the older
   * demo shape (round_number, initiative_slots, enemy_actions), or a round
   * already in 5.0.0 shape. The session reference is written as sid, the
   * field every recorded round and both viewers use; publish used to write
   * session_id, which nothing reads, so published rounds lost their session.
   */
  function convertRound(raw, combat, ctx) {
    const n = num(raw.n ?? raw.round_number);
    const where = `${combat.name || 'Combat'} round ${n ?? '?'}`;
    const round = {
      n,
      sid: resolveSid(raw.sid ?? raw.session_id ?? null, where, ctx),
      slots: convertSlots(raw.slots ?? raw.initiative_slots ?? [], combat, ctx, where),
      enemy_turns: convertEnemies(raw.enemy_turns ?? raw.enemy ?? raw.enemy_actions ?? [], combat, ctx, where),
    };
    // passages[] is the one optional round field 5.0.0 defines (#100–#102).
    if (Array.isArray(raw.passages)) round.passages = clone(raw.passages);
    return round;
  }

  /**
   * resolveSid(text, where, ctx) → a session id, or null.
   *
   * A round's sid must be a session's id: every combat's sessions list is
   * built from it. Queue items do not always carry one. An integrity gap
   * fill passes the gap's session hint, which is either the literal
   * "incoming session" (a gap in this session's own rounds) or a comma-
   * joined list of the combat's sessions (and "unknown" when there is none).
   *   - a known session id is kept;
   *   - "incoming session", or no value, means this publish's own session
   *     when the publish has exactly one;
   *   - a list holding exactly one known session id means that session;
   *   - anything else is written as null and reported, rather than writing
   *     text that is not an id into the data.
   */
  function resolveSid(text, where, ctx) {
    if (text != null && ctx.knownIds.has(text)) return text;
    const t = text == null ? '' : String(text).trim();
    if ((t === '' || /^incoming session$/i.test(t)) && ctx.publishSessions.length === 1) return ctx.publishSessions[0];
    const parts = t.split(',').map(s => s.trim()).filter(s => ctx.knownIds.has(s));
    if (parts.length === 1) return parts[0];
    ctx.notes.add(`${where}: no session could be identified${t ? ` from "${t}"` : ''}; its session was left blank.`);
    return null;
  }

  /**
   * mergeRound(existing, incoming, combat, ctx) — folds incoming into existing.
   *
   * Why: a round that continues across a page break arrives as two rounds
   * with the same number. Publish used to replace the first with the second,
   * losing half the round. Now each party slot's activities, and each enemy
   * group's activities and events, are added to the recorded round; an
   * activity identical to one already there is not added twice, so
   * publishing the same round again changes nothing.
   */
  function mergeRound(existing, incoming, combat, ctx) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // The round keeps the session it started in. A round recorded with no
    // sid gains the incoming one only when there is one, so merging never
    // adds an empty field to a round that did not have it.
    if (existing.sid == null && incoming.sid != null) existing.sid = incoming.sid;
    existing.slots = existing.slots || [];
    for (const slot of incoming.slots) {
      const mine = existing.slots.find(x => x.s === slot.s && x.a === slot.a);
      if (!mine) { existing.slots.push(slot); continue; }
      mine.activities = mine.activities || [];
      for (const act of slot.activities) if (!mine.activities.some(x => same(x, act))) mine.activities.push(act);
      if (slot.notes && slot.notes !== mine.notes) mine.notes = mine.notes ? mine.notes + '; ' + slot.notes : slot.notes;
    }
    existing.slots.sort((x, y) => (x.s ?? 0) - (y.s ?? 0));
    existing.enemy_turns = existing.enemy_turns || [];
    for (const et of incoming.enemy_turns) {
      const mine = existing.enemy_turns.find(x => x.actor_id === et.actor_id);
      if (!mine) { existing.enemy_turns.push(et); continue; }
      for (const act of et.activities) if (!mine.activities.some(x => same(x, act))) mine.activities.push(act);
      mine.special_events = mine.special_events || [];
      for (const ev of et.special_events) if (!mine.special_events.some(x => same(x, ev))) mine.special_events.push(ev);
    }
    if (Array.isArray(incoming.passages)) existing.passages = [...(existing.passages || []), ...incoming.passages];
    ctx.notes.add(`${combat.name || 'A combat'} round ${incoming.n}: merged with the round already recorded (a round split across pages, or published twice).`);
  }

  // ── Sessions and combats ──────────────────────────────────────────────────

  /**
   * blankSession(id, legacy) — a session with every field the schema gives
   * one, in the order the recorded sessions use. Starting from the full
   * shape means the viewers and the narrative module find every path they
   * read (narrative.key_moments, mechanics.npcs_met) on a new session.
   *
   * There is no mechanics.player_absences (removed by schema 5.0.1, #112): a
   * player's absence is a session note, narrative.absence_notes, which is
   * optional and so is not created empty; the session header carries it
   * when the notes record one, and fillSession adds it.
   */
  function blankSession(id, legacy) {
    const s = { _object_type: 'session', id };
    if (legacy) s.legacy_id = legacy;
    return Object.assign(s, {
      title: null,
      date: null,
      mechanics: { combats: [], level_ups: [], items_found: [], npcs_met: [], npcs_lost: [],
        quests_opened: [], quests_closed: [], locations_visited: [] },
      narrative: { summary: null, tone: null, key_moments: [], opening_scene: null, closing_scene: null,
        chronicle_entry: null, chronicle_entry_generated_at: null, chronicle_entry_model: null,
        chronicle_entry_version: 0, narrative_beats: [], human_guidance: null, generation_warnings: [] },
      mechanical_notes: [],
      notes: null,
    });
  }

  /**
   * sessionFields(raw) → the stub's values under the schema's field names.
   *
   * The intake stub writes session_id, session_date and a root-level summary;
   * the schema (and both viewers) read id, date and narrative.summary. This
   * is why published sessions came out with no date or summary. Both spellings
   * are read here, so a stub from either the old intake or the rebuild works.
   */
  function sessionFields(raw) {
    const narrative = Object.assign({}, raw.narrative || {});
    if (raw.summary != null && narrative.summary == null) narrative.summary = raw.summary;
    return {
      title: raw.title,
      date: raw.date ?? raw.session_date,
      mechanics: raw.mechanics || {},
      narrative,
      mechanical_notes: raw.mechanical_notes,
      notes: raw.notes,
    };
  }

  /**
   * fillSession(target, raw, ctx) — writes the stub's values into a session.
   *
   * A field is filled only when the session has no value for it; a list
   * gains the values it lacks. Nothing recorded is overwritten. Why: the
   * placeholders session_006 and session_007 already hold the DM's title,
   * date and summary, while intake's stub defaults its date to the day of
   * intake, not the day of play. Overwriting would replace the real date. A
   * value the stub had that differs from the recorded one is reported, so a
   * deliberate change can still be made (by a MOD) instead of being lost.
   */
  function fillSession(target, raw, ctx) {
    const f = sessionFields(raw);
    const label = target.legacy_id || target.title || 'the session';
    const fill = (obj, key, value, path) => {
      if (isEmpty(value)) return;
      if (Array.isArray(obj[key]) && Array.isArray(value)) {
        for (const v of value) if (!obj[key].some(x => JSON.stringify(x) === JSON.stringify(v))) obj[key].push(v);
      } else if (isEmpty(obj[key])) {
        obj[key] = clone(value);
      } else if (JSON.stringify(obj[key]) !== JSON.stringify(value)) {
        ctx.notes.add(`${label}: kept the recorded ${path} (${JSON.stringify(obj[key])}); the review had ${JSON.stringify(value)}.`);
      }
    };
    fill(target, 'title', f.title, 'title');
    fill(target, 'date', f.date, 'date');
    if (!target.mechanics) target.mechanics = {};
    for (const [k, v] of Object.entries(f.mechanics)) fill(target.mechanics, k, v, 'mechanics.' + k);
    if (!target.narrative) target.narrative = {};
    for (const [k, v] of Object.entries(f.narrative)) fill(target.narrative, k, v, 'narrative.' + k);
    fill(target, 'mechanical_notes', f.mechanical_notes, 'mechanical notes');
    fill(target, 'notes', f.notes, 'notes');
    const known = new Set(['id', 'session_id', 'legacy_id', '_object_type', 'title', 'date', 'session_date',
      'summary', 'mechanics', 'narrative', 'mechanical_notes', 'notes']);
    const dropped = Object.keys(raw).filter(k => !known.has(k));
    if (dropped.length) ctx.notes.add(`${label}: session fields not in the schema were not written: ${dropped.join(', ')}.`);
  }

  /**
   * blankCombat(raw, assigned) — a new combat with every field the recorded
   * combats have, then the queued values on top. The interpret stub carries
   * only outcome, location, sessions and total_rounds_logged; without the
   * rest (enemies_roster above all) enemy turns would have no roster to name
   * and the reference check could not read the combat.
   */
  function blankCombat(raw, assigned) {
    const c = { _object_type: 'combat', id: assigned.id };
    if (assigned.legacy) c.legacy_id = assigned.legacy;
    Object.assign(c, {
      name: raw.name ?? null,
      mechanics: Object.assign({ outcome: null, location: null, sessions: [], total_rounds_logged: 0,
        enemies_roster: [], pcs_downed: [], enemies_eliminated: [], status_effects_applied: [] }, raw.mechanics || {}),
      initiative: Object.assign({ entries: [] }, raw.initiative || {}),
      narrative: Object.assign({ setup: null, turning_point: null, atmosphere: [], current_status: null,
        finale: null, aftermath: null }, raw.narrative || {}),
      rounds: [],
      notes: raw.notes ?? null,
    });
    return c;
  }

  /**
   * withId(rawData, assigned) → a copy of rawData whose id is the assigned
   * UUID, with legacy_id next to it when one is kept. id and legacy_id go
   * first, after _object_type, as in the migrated data (issue #95).
   */
  function withId(rawData, assigned) {
    const { _object_type, id, legacy_id, ...rest } = rawData;
    const out = {};
    if (_object_type !== undefined) out._object_type = _object_type;
    out.id = assigned.id;
    if (assigned.legacy) out.legacy_id = assigned.legacy;
    return Object.assign(out, rest);
  }

  // ── Derived fields ─────────────────────────────────────────────────────────

  /**
   * deriveFields(campaign) — recomputes the derived fields, in place.
   *
   * The design lists these as computed at publish, never edited by hand:
   *   - each combat's sessions (from its rounds' sid) and total_rounds_logged
   *     (its number of rounds)
   *   - combat participation: each session's combats, each location's
   *     combat_history, each bestiary entry's combat_appearances (from the
   *     roster groups that point at it)
   *   - each session's locations_visited, kept in step with each location's
   *     sessions_visited, and including the location of every combat fought
   *     that session
   *   - each session's npcs_met (the NPCs whose first_appeared is that session)
   *
   * Values are added, never removed. Today's data was entered by hand, and
   * several of these facts (an NPC met outside combat, a place passed
   * through) are not yet recorded anywhere the computation can see; until
   * passages and entity mentions arrive (#100–#102), removing a value the
   * computation cannot reproduce would delete real data. Run on the current
   * file, this reproduces every stored value and adds one missing link
   * (Lake Town's sessions_visited gains session_006, which the session
   * already listed). A field an entity does not have is only created when
   * there is something to put in it. Idempotent: a second run changes nothing.
   */
  function deriveFields(campaign) {
    const combats   = campaign.combat_encounters || [];
    const sessions  = campaign.session_logs || [];
    const locations = campaign.locations || [];
    const bestiary  = campaign.bestiary || [];
    const npcs      = campaign.npc_directory || [];

    // listOn(obj, key, values) — obj[key] gains values (in order, no repeats).
    // The field is created only when there is a value to add.
    const listOn = (obj, key, values) => {
      const vals = values.filter(v => v != null);
      if (!Array.isArray(obj[key])) {
        if (!vals.length) return;
        obj[key] = [];
      }
      for (const v of vals) pushUnique(obj[key], v);
    };

    for (const c of combats) {
      c.mechanics = c.mechanics || {};
      const rounds = c.rounds || [];
      listOn(c.mechanics, 'sessions', rounds.map(r => r.sid));
      if ('total_rounds_logged' in c.mechanics || rounds.length) c.mechanics.total_rounds_logged = rounds.length;
    }

    // Session ↔ combat: a combat belongs to every session it lists.
    for (const s of sessions) {
      s.mechanics = s.mechanics || {};
      listOn(s.mechanics, 'combats', combats.filter(c => (c.mechanics.sessions || []).includes(s.id)).map(c => c.id));
    }

    // Session ↔ location: the union of both sides' records and each combat's
    // place, so a visit recorded on either side shows on both.
    const visits = [];
    for (const s of sessions) for (const l of s.mechanics?.locations_visited || []) visits.push([s.id, l]);
    for (const l of locations) for (const s of l.mechanics?.sessions_visited || []) visits.push([s, l.id]);
    for (const c of combats) {
      if (!c.mechanics.location) continue;
      for (const s of c.mechanics.sessions || []) visits.push([s, c.mechanics.location]);
    }
    for (const s of sessions) listOn(s.mechanics, 'locations_visited', visits.filter(v => v[0] === s.id).map(v => v[1]));
    for (const l of locations) {
      l.mechanics = l.mechanics || {};
      listOn(l.mechanics, 'sessions_visited', visits.filter(v => v[1] === l.id).map(v => v[0]));
      listOn(l.mechanics, 'combat_history', combats.filter(c => c.mechanics.location === l.id).map(c => c.id));
    }

    for (const b of bestiary) {
      b.mechanics = b.mechanics || {};
      listOn(b.mechanics, 'combat_appearances',
        combats.filter(c => (c.mechanics.enemies_roster || []).some(g => g.mon_ref === b.id)).map(c => c.id));
    }

    for (const s of sessions) {
      listOn(s.mechanics, 'npcs_met', npcs.filter(n => n.mechanics?.first_appeared === s.id).map(n => n.id));
    }
  }

  /**
   * knownSpells(campaign, spellNames) → Set of normalised spell names.
   *
   * Two sources: the party's spell lists (pc-abilities.json, passed in) and
   * every spell already recorded in the campaign as a Magic activity's detail.
   * Why both: the harvested lists are incomplete. Atticus's has no Cure
   * Wounds or Entangle, yet both are recorded in the Goblin Ambush. A spell
   * the party has cast before is therefore recognised even when the harvest
   * missed it, and a new spell is recognised when the harvest has it.
   */
  function knownSpells(campaign, spellNames) {
    const set = new Set([...(spellNames || [])].map(norm));
    const strip = d => norm(String(d).replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' '));
    for (const c of campaign.combat_encounters || []) {
      for (const r of c.rounds || []) {
        for (const t of [...(r.slots || []), ...(r.enemy_turns || [])]) {
          for (const a of t.activities || []) if (a.name === 'Magic' && a.detail) set.add(strip(a.detail));
        }
      }
    }
    set.delete('');
    return set;
  }

  // ── The publish ────────────────────────────────────────────────────────────

  /**
   * applySession(campaign, approved, options) → { campaign, notes }
   *
   * Applies one session's approved queue items. Steps, in order:
   *   1. IDs (issue #95). Intake and the AI name entities by legacy ID and give
   *      new ones placeholders (cbt_007, session_008). Every NEW entity gets
   *      its UUID first, so anything that refers to it in the same publish —
   *      in whatever order the queue holds — is translated to that UUID.
   *   2. NEW items, then everything else, so a round queued before its new
   *      combat still finds it. A session whose id already exists (the
   *      placeholders) is filled, never appended a second time.
   *   3. Derived fields, recomputed across the whole campaign.
   *   4. Deferred gaps, prompt-log entries and the publish timestamps.
   */
  function applySession(campaign, approved, options) {
    const ids = Ids();
    const opts = options || {};
    const notes = makeNotes();
    const out = clone(campaign);
    const now = opts.now instanceof Date ? opts.now : new Date();

    // Step 1 — assign ids. given is the id the queue item carries: rawData.id,
    // or for the intake session stub its session_id.
    const idIndex = ids.buildLegacyIndex(out);
    const assigned = new Map();
    const givenId = d => d.rawData?.id ?? (d.array === 'session_logs' ? d.rawData?.session_id : undefined);
    const isSessionDelta = d => d.array === 'session_logs' && d.rawData && d.rawData.narrative_text == null;
    for (const d of approved) {
      if (d.type !== 'NEW' || !d.rawData || !out[d.array]) continue;
      if (d.array === 'session_logs' && !isSessionDelta(d)) continue;
      const given = givenId(d);
      // An id that already names an entity (a session placeholder, or a
      // duplicate), or one an earlier NEW item in this publish already
      // claimed, is not given a new UUID.
      if (given && (idIndex.has(given) || out[d.array].some(e => e.id === given))) continue;
      const fresh = ids.newId();
      if (given) idIndex.set(given, fresh);
      // Only a session keeps its placeholder, as legacy_id: session_NNN is
      // the number the DM gave it at intake. Every other placeholder was
      // counted up by the page, which #95 retired.
      const legacy = d.array === 'session_logs' && ids.isLegacyId(given) ? given : null;
      assigned.set(d, { id: fresh, legacy });
    }
    const tr = v => ids.translateRefs(v, idIndex);

    // Everything targets resolve against. Rebuilt after step 2's NEW items,
    // so a target naming an NPC created this session resolves too.
    const ctx = {
      notes,
      spells: knownSpells(out, opts.spellNames),
      names: null,
      knownIds: null,
      // The sessions this publish created or filled. A round with no usable
      // session reference belongs to this publish's session when there is
      // exactly one (resolveSid).
      publishSessions: [],
    };
    const refreshNames = () => {
      ctx.names = buildNameIndex(out);
      ctx.knownIds = new Set();
      ids.forEachEntity(out, e => { if (e.id) ctx.knownIds.add(e.id); });
    };

    const newOnes = approved.filter(d => d.type === 'NEW');
    const rest    = approved.filter(d => d.type !== 'NEW');
    const pendingRounds = []; // rounds inside NEW combats, converted after names exist

    // Step 2a — NEW items.
    for (const d of newOnes) {
      const arr = d.array;
      if (!arr || !out[arr] || !d.rawData) continue;
      const rawData = tr(d.rawData);
      if (arr === 'session_logs') {
        if (!isSessionDelta(d)) {
          // Intake's "Narrative notes" item is the DM's free text for the
          // whole session, queued under session_logs but not a session. It
          // used to be pushed as a session with no id. Nothing writes it yet;
          // the intake rebuild keeps it as passages (#100–#102).
          notes.add('The narrative notes item is not saved by publish; it is reference text for the review.');
          continue;
        }
        const a = assigned.get(d);
        const id = a ? a.id : (rawData.id ?? rawData.session_id);
        let target = out.session_logs.find(s => s.id === id);
        if (!target) {
          target = blankSession(a ? a.id : ids.newId(), a ? a.legacy : null);
          out.session_logs.push(target);
        } else if (!a) {
          notes.add(`${target.legacy_id || target.title}: filled the existing session instead of adding a second one.`);
        }
        fillSession(target, rawData, ctx);
        pushUnique(ctx.publishSessions, target.id);
        continue;
      }
      const a = assigned.get(d);
      if (!a) {
        // Its id names an entity that already exists: skipped, as before.
        notes.add(`${d.title || arr}: already in the campaign; the NEW item was skipped.`);
        continue;
      }
      if (arr === 'combat_encounters') {
        const combat = blankCombat(rawData, a);
        out.combat_encounters.push(combat);
        for (const r of rawData.rounds || []) pendingRounds.push({ combat, raw: r });
        continue;
      }
      out[arr].push(withId(rawData, a));
    }

    refreshNames();
    const insertRound = (combat, raw) => {
      const round = convertRound(raw, combat, ctx);
      combat.rounds = combat.rounds || [];
      const existing = combat.rounds.find(r => r.n === round.n);
      if (existing) mergeRound(existing, round, combat, ctx);
      else { combat.rounds.push(round); combat.rounds.sort((x, y) => (x.n ?? 0) - (y.n ?? 0)); }
    };
    for (const p of pendingRounds) insertRound(p.combat, p.raw);

    // Step 2b — everything else, in queue order.
    for (const d of rest) {
      const arr = d.array;
      if (!arr || !out[arr]) continue;
      const rawData  = d.rawData ? tr(d.rawData) : d.rawData;
      const targetId = tr(d.targetId);
      const combatId = tr(d.combatId);

      if (d.type === 'ROUND') {
        const combat = (out.combat_encounters || []).find(c => c.id === combatId);
        if (!combat) {
          notes.add(`Round ${rawData?.n ?? '?'} for combat ${d.combatName || d.combatId}: no such combat; the round was not written.`);
          continue;
        }
        if (rawData) insertRound(combat, rawData);

      } else if (d.type === 'MOD') {
        applyMod(out, arr, rawData, targetId, notes);

      } else if (d.type === 'RELATIONSHIP') {
        applyRelationship(out, rawData, ids);
      }
    }

    // Cohorts promoted to a faction this publish were queued pointing at
    // 'fac_TBD', because the faction had no id yet. It has one now; the
    // faction cascade copies the cohort's name, so match by name.
    if (Array.isArray(out.cohorts) && Array.isArray(out.factions)) {
      for (const coh of out.cohorts) {
        if (coh.mechanics?.promoted_to !== 'fac_TBD') continue;
        const f = out.factions.find(x => (x.name || '').toLowerCase() === (coh.name || '').toLowerCase());
        if (f?.id) coh.mechanics.promoted_to = f.id;
      }
    }

    // Step 3 — derived fields.
    deriveFields(out);

    // Step 4a — deferred integrity gaps: workflow records kept with the data
    // so the future campaign scanner can list them. A gap already present
    // (a re-publish after a failure) is not added twice. A gap names its
    // session by the DM's session_NNN, so it is translated (#95).
    const gaps = opts.deferredGaps || [];
    if (gaps.length) {
      if (!Array.isArray(out.deferred_gaps)) out.deferred_gaps = [];
      for (const g of gaps) {
        if (!out.deferred_gaps.some(x => x.id === g.id)) out.deferred_gaps.push(tr(g));
      }
    }

    // Step 4b — prompt-improvement entries logged at intake (issue #29) get
    // their pil_NNN ids here, counted from the array length (workflow records
    // keep typed ids). The caller clears its copy only after the publish
    // succeeds, so a failed write does not lose them.
    const pil = opts.promptLog || [];
    if (pil.length) {
      if (!Array.isArray(out.prompt_improvement_log)) out.prompt_improvement_log = [];
      let next = out.prompt_improvement_log.length + 1;
      for (const entry of pil) {
        out.prompt_improvement_log.push(Object.assign({ id: 'pil_' + String(next).padStart(3, '0') }, tr(entry)));
        next++;
      }
    }

    // Step 4c — timestamps. meta.last_updated is the date CLAUDE.md asks every
    // change to the data to set; _last_published and _delta_count are the
    // publish metadata the page has always written.
    if (out.meta && typeof out.meta === 'object') out.meta.last_updated = now.toISOString().slice(0, 10);
    out._last_published = now.toISOString();
    out._delta_count = (out._delta_count || 0) + approved.length;

    return { campaign: out, notes: notes.list };
  }

  /**
   * applyMod(out, arr, rawData, targetId, notes) — patches an existing entity.
   *
   * Unchanged from the page's version apart from reporting a miss:
   *   - quest progress append (_progress_append): finds the quest by title
   *     (exact, then partial) and appends to mechanics.progress_log, so the
   *     rest of the quest is untouched (issue #90)
   *   - cohort session append (_cohort_session_append): adds the session to
   *     mechanics.associated_sessions once
   *   - otherwise: Object.assign of the given fields onto the entity found by id
   */
  function applyMod(out, arr, rawData, targetId, notes) {
    if (!rawData) return;
    const id = rawData.id || targetId;
    let idx = out[arr].findIndex(e => e.id === id);
    if (idx === -1 && arr === 'quest_ledger' && rawData._progress_append) {
      const hint = (rawData.quest_hint || '').toLowerCase().trim();
      if (hint) {
        idx = out[arr].findIndex(q => (q.title || '').toLowerCase() === hint);
        if (idx === -1) idx = out[arr].findIndex(q => (q.title || '').toLowerCase().includes(hint));
      }
      if (idx === -1) {
        notes.add(`Quest progress for "${rawData.quest_hint}": no quest matched; the entry was not written.`);
        return;
      }
    }
    if (idx === -1) {
      notes.add(`A change to ${arr} entity ${id}: no such entity; not written.`);
      return;
    }
    const target = out[arr][idx];
    if (rawData._progress_append) {
      target.mechanics = target.mechanics || {};
      if (!Array.isArray(target.mechanics.progress_log)) target.mechanics.progress_log = [];
      target.mechanics.progress_log.push(rawData._progress_append);
    } else if (rawData._cohort_session_append) {
      const sid = rawData._cohort_session_append.sessionId;
      if (!sid) return;
      target.mechanics = target.mechanics || {};
      if (!Array.isArray(target.mechanics.associated_sessions)) target.mechanics.associated_sessions = [];
      pushUnique(target.mechanics.associated_sessions, sid);
    } else if (Array.isArray(rawData._passage_append)) {
      // Narrative passages from the session page (#102). Each is
      // { text, session_id, speaker, page } and goes on exactly one object,
      // the most specific thing it describes. A passage already there (same
      // text from the same session) is not added again, so a repeat publish
      // after a failure does not double it.
      if (!Array.isArray(target.passages)) target.passages = [];
      for (const p of rawData._passage_append) {
        if (!p || !p.text) continue;
        if (target.passages.some(x => x.text === p.text && x.session_id === p.session_id)) continue;
        target.passages.push(clone(p));
      }
    } else if (rawData._alias_append || rawData._note_append || rawData._roster_group_append) {
      // Entity identification (#100) adds to an entity without replacing it:
      // a Link to existing saves the words as an alias, Separate as new notes
      // the look-alike, and Mark as sub-type adds a roster group. A whole-
      // object MOD would overwrite the lists these append to.
      appendIdentification(target, rawData, notes);
    } else {
      Object.assign(target, rawData);
    }
  }

  /**
   * appendIdentification(target, rawData, notes) — the three appends the
   * session page's entity identification produces (issue #100).
   *
   *   _alias_append        [string]  added to target.aliases, skipping any
   *                                  that equal the name or an existing alias
   *                                  (case and punctuation ignored), so a
   *                                  repeated publish adds nothing twice
   *   _note_append         string    added to target.notes on a new line,
   *                                  unless the same line is already there
   *   _roster_group_append object    added to a combat's enemies_roster,
   *                                  unless a group with that actor_id exists
   *
   * Why aliases are checked against the name: Bulk acknowledge trusts an
   * exact name or alias, so a duplicate would be harmless but noisy, and an
   * alias equal to the name would be meaningless.
   */
  function appendIdentification(target, rawData, notes) {
    const key = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const label = target.name || target.title || target.legacy_id || target.id;
    if (Array.isArray(rawData._alias_append)) {
      const taken = new Set([key(target.name), key(target.title), key(target.nickname), ...(target.aliases || []).map(key)].filter(Boolean));
      const add = rawData._alias_append.filter(a => a && !taken.has(key(a)) && taken.add(key(a)));
      if (add.length) target.aliases = (target.aliases || []).concat(add);
    }
    if (typeof rawData._note_append === 'string' && rawData._note_append.trim()) {
      const line = rawData._note_append.trim();
      if (typeof target.notes === 'string' && target.notes.trim()) {
        if (!target.notes.split('\n').some(l => l.trim() === line)) target.notes = target.notes + '\n' + line;
      } else if (target.notes == null || target.notes === '') {
        target.notes = line;
      } else {
        // notes holds structured data on a few older entities; leave it intact.
        notes.add(`${label}: notes is not text, so the note "${line}" was not added.`);
      }
    }
    const g = rawData._roster_group_append;
    if (g && g.actor_id) {
      target.mechanics = target.mechanics || {};
      if (!Array.isArray(target.mechanics.enemies_roster)) target.mechanics.enemies_roster = [];
      if (target.mechanics.enemies_roster.some(x => x.actor_id === g.actor_id)) {
        notes.add(`${label}: already has a roster group "${g.actor_id}"; it was not added again.`);
      } else {
        target.mechanics.enemies_roster.push(clone(g));
      }
    }
  }

  /**
   * applyRelationship(out, rd, ids) — writes one approved relationship.
   *
   * Unchanged from the page's two-tier model (issue #43): a significant
   * event is always a new entry; a participation edge between the same two
   * entities is updated rather than duplicated. New ids are UUIDs (#95).
   */
  function applyRelationship(out, rd, ids) {
    rd = rd || {};
    if (!Array.isArray(out.entity_relationships)) out.entity_relationships = [];
    const sig = rd.significance || 'participation';
    const entry = (id, significance) => ({
      id,
      from_id: rd.from_id || '',
      from_type: rd.from_type || 'unknown',
      to_id: rd.to_id || '',
      to_type: rd.to_type || 'unknown',
      relationship_type: rd.relationship_type || 'unknown',
      significance,
      established_session: rd.established_session || '',
      last_updated_session: rd.established_session || '',
      status: 'active',
      narrative: { ground_truth_notes: rd.ground_truth_notes || '', edge_prose: null, regeneration_flagged: false },
    });
    if (sig === 'significant_event') {
      out.entity_relationships.push(entry(ids.newId(), 'significant_event'));
      return;
    }
    const existing = out.entity_relationships.find(r =>
      r.from_id === rd.from_id && r.to_id === rd.to_id && r.significance === 'participation');
    if (existing) {
      // Only the moving parts change: the edge keeps when it was established
      // and its prose, which is flagged for regeneration.
      existing.last_updated_session = rd.established_session || '';
      if (existing.narrative) existing.narrative.regeneration_flagged = true;
    } else {
      out.entity_relationships.push(entry(ids.newId(), 'participation'));
    }
  }

  // ── Session header (issue #99) ─────────────────────────────────────────────
  // The session page picks the session ID and date at upload. These two
  // helpers live here, beside applySession, because they are its contract:
  // sessionChoices offers exactly the sessions applySession fills in place
  // (the placeholders) or creates (the next ID), and sessionHeader builds the
  // item applySession reads the ID and date from. Kept out of the page so
  // tests/session-header.test.js runs the same code the page runs.

  // A placeholder session's notes start with this word; the DM wrote it on
  // session_006 and session_007 when entering them by hand.
  const PLACEHOLDER_NOTE = /^\s*PLACEHOLDER\b/i;

  /**
   * sessionChoices(campaign) → [{ legacyId, title, date, placeholder }]
   *
   * The placeholder sessions, in the data's order, then one entry for the
   * next new session (placeholder false, title and date null). The next ID is
   * one past the highest session_NNN legacy ID, padded to three digits.
   *
   * Why: before #99 intake read a session ID field that did not exist on the
   * page, so every session was filed as session_006. Offering the placeholders
   * first means a backlog session fills its placeholder instead of being added
   * a second time. Recorded sessions that are not placeholders are not offered;
   * picking one would only add to a session that is already complete.
   */
  function sessionChoices(campaign) {
    const sessions = (campaign && campaign.session_logs) || [];
    const choices = sessions
      .filter(s => typeof s.notes === 'string' && PLACEHOLDER_NOTE.test(s.notes))
      .map(s => ({ legacyId: s.legacy_id || s.id, title: s.title ?? null, date: s.date ?? null, placeholder: true }));
    // Legacy IDs are frozen (#95), so the next session number comes only from
    // legacy_id; a session added since without one does not move the count.
    let max = 0;
    for (const s of sessions) {
      const m = /^session_(\d+)$/.exec(s.legacy_id || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    choices.push({ legacyId: 'session_' + String(max + 1).padStart(3, '0'), title: null, date: null, placeholder: false });
    return choices;
  }

  /**
   * sessionHeader(legacyId, date) → a NEW session_logs queue item
   *
   * Carries the session ID and date chosen at upload to applySession. It uses
   * session_id (which applySession reads as the given id, so a placeholder is
   * found and filled, and a new session keeps session_NNN as legacy_id) and
   * date (the schema's own name; sessionFields still reads intake's old
   * session_date). Later steps add the title and summary to rawData.
   *
   * A placeholder's recorded date is never overwritten (fillSession); a
   * different date here is reported in publish's notes instead.
   *
   * Throws on an ID that is not session_NNN or a date that is not YYYY-MM-DD,
   * so a missing pick fails here, not as a session dated the day of intake.
   */
  function sessionHeader(legacyId, date) {
    if (!/^session_\d+$/.test(legacyId || '')) throw new Error('Pick a session ID (session_NNN) before continuing.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Pick the date the session was played before continuing.');
    return { id: 'session_header', type: 'NEW', array: 'session_logs', status: 'approved',
      rawData: { session_id: legacyId, date } };
  }

  const api = { applySession, deriveFields, STANDARD_ACTIONS, sessionChoices, sessionHeader };

  // Browser pages read window.ChroniclePublish; Node (tests) requires the
  // file. One source serves both, so the tests run the code the page runs.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChroniclePublish = api;
})(typeof window !== 'undefined' ? window : globalThis);
