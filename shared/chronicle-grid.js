/**
 * shared/chronicle-grid.js
 *
 * The round grid of the session page's step 4 (issue #103): split
 * assignment, the initiative order, and the grid of turns that the DM fixes
 * by moving things directly, with no AI call.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The old Delta Review fixed misaligned rounds through an AI sidebar that
 * reordered and added slots (#86), the least reliable part of the tool. The
 * redesign (docs/intake-redesign.md, "Step 4: Reviewing a combat") reviews a
 * combat in two passes that follow the data: confirm the initiative order
 * once, then scan a grid with one row per slot and one column per round. A
 * turn points at a row, so fixing the order fixes every round, and every
 * correction is a direct move.
 *
 * Every move lives here, as a function that changes the grid model and
 * nothing else, so tests/round-grid.test.js runs the code the page runs. The
 * page only draws the model and calls these functions.
 *
 * THE MODEL
 * ---------
 * grid = {
 *   combat, name,
 *   rows:      [{ key, entityId, label, from, to }]  party rows, in initiative order
 *   enemyRows: [{ key, entityId, label, isNew }]     one per roster group; key is the
 *                                                    group's actor_id
 *   rounds:    [{ n, pages, override, events: [{ text, page }],
 *                 cells: { rowKey: cell }, enemy: { enemyKey: cell } }]
 *   held:      [{ round, asWritten, source_line, reason }]  facts held back
 * }
 * cell = { activities, source_lines, notes, aiNotes, noteOrder, special_events }
 * An activity is the 5.0.0 shape with targets already resolved: an outcome's
 * target_id is an entity id or a roster actor_id, or null with target_text.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChronicleGrid (and module.exports under Node):
 *   splitAssignments(refs, merged)       — occurrences a Split left to assign,
 *                                          with the AI's proposal and reason
 *   assignWhere(list, filter, entityId)  — assign in bulk by spelling, page or combat
 *   buildGrid(combatFacts, ctx)          — the grid for one combat of #101's merged facts
 *   proposeOrder(...)                    — the order: the recorded one when the
 *                                          combat continues, else the notes' order
 *   the moves: moveRow, setJoinLeave, setOverride, moveTurn, moveActivity,
 *   moveOutcome, setEconomy, editActivity, editOutcome, addActivity, addOutcome,
 *   removeActivity, removeOutcome, eventToActivity, applySuggestedMove
 *   toTurnSchema(grid, sessionRef)       — 5.0.0 rounds for the checks (#104) and
 *                                          publish (#106), plus the roster groups
 *                                          to add and the facts held back
 *   mapFlags(grid, flags)                — #104's flags placed on grid cells
 *   attachSelfCheck(grid, notes, refs)   — #101's AI self-check notes beside their cells
 *   replaceRound(grid, n, combatFacts, ctx) — a re-extracted round put back
 *
 * No DOM, storage or network access.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * The session page could not show or correct combats, and publish (#106)
 * would have no turn-schema rounds to write.
 */

(function(root) {
  'use strict';

  const clone = v => JSON.parse(JSON.stringify(v));
  const emptyCell = () => ({ activities: [], source_lines: [], notes: [], aiNotes: [], noteOrder: null, special_events: [] });

  // ── Split assignment ──────────────────────────────────────────────────────

  /**
   * splitAssignments(refs, merged) → [{ occ, asWritten, context, page,
   *   candidates, proposed, reason, assigned }]
   *
   * Every occurrence step 3's Split left "to be assigned", with the AI's
   * proposal from the facts call (#101 asks for one) and its reason. The DM
   * confirms these before the grid is built, because a turn's row depends on
   * who took it. `assigned` starts as the proposal; the DM can change it or
   * clear it (null), and an unassigned occurrence holds back only its own facts.
   */
  function splitAssignments(refs, merged) {
    const proposals = new Map((merged.assignments || []).map(a => [a.occ, a]));
    return refs.filter(r => r.candidates && r.candidates.length).map(r => {
      const p = proposals.get(r.occ);
      const choice = p && r.candidates.find(c => c.name.toLowerCase() === String(p.choice || '').toLowerCase());
      return { occ: r.occ, asWritten: r.asWritten, context: r.context, page: pageOf(r.occ), candidates: r.candidates,
        proposed: choice ? choice.id : null, reason: (p && p.reason) || '', assigned: choice ? choice.id : null };
    });
  }

  // pageOf('occ_2_5') → 2; occurrence ids carry their page (#100).
  function pageOf(occ) {
    const m = /^occ_(.+)_\d+$/.exec(occ || '');
    return m ? (isNaN(Number(m[1])) ? m[1] : Number(m[1])) : null;
  }

  /**
   * assignWhere(list, filter, entityId) → how many changed.
   * Bulk assignment, as the design asks: by spelling ({ asWritten }), by page
   * ({ page }) or by combat ({ occs: [...] }, the occurrences a combat uses),
   * then the DM fixes the exceptions one by one.
   */
  function assignWhere(list, filter, entityId) {
    let n = 0;
    for (const a of list) {
      if (filter.asWritten != null && a.asWritten.toLowerCase() !== String(filter.asWritten).toLowerCase()) continue;
      if (filter.page != null && String(a.page) !== String(filter.page)) continue;
      if (filter.occs && !filter.occs.includes(a.occ)) continue;
      if (entityId != null && !a.candidates.some(c => c.id === entityId)) continue;
      a.assigned = entityId;
      n++;
    }
    return n;
  }

  // ── Building the grid ─────────────────────────────────────────────────────

  /**
   * resolver(ctx) → helpers that turn an occurrence id into what the grid
   * stores. ctx = { refs, assignments: Map occ → entityId|null, isParty(id),
   * nameOf(id) }. A roster group's occurrence becomes its actor_id; a split
   * occurrence becomes the entity it was assigned (or nothing yet).
   */
  function resolver(ctx) {
    const byOcc = new Map(ctx.refs.map(r => [r.occ, r]));
    const assigned = ctx.assignments || new Map();
    const resolve = occ => {
      const r = byOcc.get(occ);
      if (!r) return { none: true };
      if (r.candidates) {
        const id = assigned.get(occ);
        return id ? { entityId: id, asWritten: r.asWritten } : { unassigned: true, asWritten: r.asWritten };
      }
      const m = /^roster:[^:]+:(.+)$/.exec(r.entityId || '');
      if (m) return { roster: m[1], asWritten: r.asWritten, monRef: null };
      return r.entityId ? { entityId: r.entityId, asWritten: r.asWritten, group: r.group } : { none: true, asWritten: r.asWritten };
    };
    return { resolve, byOcc };
  }

  // resolveActivity(a, resolve) → a copy with targets resolved (see the model).
  function resolveActivity(a, resolve) {
    const out = { economy: a.economy, name: a.name };
    for (const k of ['detail', 'val_type', 'notes', 'member', 'ready_ref']) if (a[k] != null && a[k] !== '') out[k] = a[k];
    out.outcomes = (a.outcomes || []).map(o => {
      const x = { res: o.res ?? null, val: o.val ?? null, target_id: null };
      if (o.target) {
        const t = resolve(o.target);
        if (t.roster) x.target_id = t.roster;
        else if (t.entityId) x.target_id = t.entityId;
        else x.target_text = (t.asWritten || o.target) + (t.unassigned ? ' (not yet assigned)' : '');
      } else if (o.target_text) x.target_text = o.target_text;
      for (const k of ['detail', 'effect', 'notes']) if (o[k] != null && o[k] !== '') x[k] = o[k];
      return x;
    });
    return out;
  }

  /**
   * buildGrid(combatFacts, ctx) → grid
   *
   * combatFacts: one combat of ChronicleFacts.mergePages (rounds of turns,
   * enemy_turns and events, each turn tagged with its page). ctx adds
   * { name, recordedOrder: [entityId in slot order] | null, rosterLabels:
   * Set of actor_ids already in the combat's roster }.
   *
   * A turn goes to a party row when its actor is a person (party or NPC), to
   * an enemy row when its actor is a creature group. A turn whose actor is
   * still unassigned from a Split is held back, not guessed: it waits in
   * grid.held, and only its own facts wait.
   */
  function buildGrid(combatFacts, ctx) {
    const { resolve } = resolver(ctx);
    const grid = { combat: combatFacts.combat, name: ctx.name || combatFacts.combat, rows: [], enemyRows: [], rounds: [], held: [] };
    const rowSeen = new Map(), enemySeen = new Map(), firstRound = new Map(), listed = [];
    const addRow = (id, label, n) => {
      if (!rowSeen.has(id)) { rowSeen.set(id, { key: id, entityId: id, label, from: null, to: null }); listed.push(id); firstRound.set(id, n); }
    };
    const addEnemy = (key, entityId, label) => {
      if (!enemySeen.has(key)) enemySeen.set(key, { key, entityId, label, isNew: !(ctx.rosterLabels && ctx.rosterLabels.has(key)) });
    };
    for (const r of combatFacts.rounds) {
      const round = { n: r.n, pages: (r.pages || []).slice(), override: null, events: (r.events || []).map(t => ({ text: t, page: r.pages && r.pages[0] })), cells: {}, enemy: {} };
      let order = 0;
      const place = t => {
        const a = resolve(t.actor);
        if (a.unassigned) { grid.held.push({ round: r.n, asWritten: a.asWritten, source_line: t.source_line || '', reason: 'its actor is not yet assigned' }); return; }
        if (a.none) { grid.held.push({ round: r.n, asWritten: a.asWritten || t.actor, source_line: t.source_line || '', reason: 'its actor is not a settled name' }); return; }
        // A creature group (a roster group, or a bestiary, cohort or faction
        // entry) is an enemy row; a person is a party row, whichever list the
        // AI put the turn in.
        const isGroup = !!a.roster || (a.group && !(ctx.isParty && ctx.isParty(a.entityId)));
        let cell;
        if (isGroup) {
          const key = a.roster || (ctx.nameOf ? ctx.nameOf(a.entityId) : a.entityId);
          addEnemy(key, a.roster ? null : a.entityId, key);
          cell = round.enemy[key] || (round.enemy[key] = emptyCell());
          for (const ev of t.special_events || []) cell.special_events.push(clone(ev));
        } else {
          addRow(a.entityId, ctx.nameOf ? ctx.nameOf(a.entityId) : a.entityId, r.n);
          cell = round.cells[a.entityId] || (round.cells[a.entityId] = emptyCell());
          if (cell.noteOrder == null) cell.noteOrder = ++order;
        }
        // Each activity remembers the line it came from (a working field,
        // dropped by toTurnSchema), so moving one activity moves its own line.
        for (const act of t.activities || []) cell.activities.push(Object.assign(resolveActivity(act, resolve), t.source_line ? { source_line: t.source_line, source_page: t.page } : {}));
        if (t.source_line) cell.source_lines.push({ text: t.source_line, page: t.page });
      };
      for (const t of r.turns || []) place(t);
      for (const t of r.enemy_turns || []) place(t);
      grid.rounds.push(round);
    }
    grid.rows = proposeOrder(listed.map(id => rowSeen.get(id)), ctx.recordedOrder, firstRound, grid.rounds[0] && grid.rounds[0].n);
    grid.enemyRows = [...enemySeen.values()];
    return grid;
  }

  /**
   * proposeOrder(rows, recordedOrder, firstRound, startRound) → rows in order
   *
   * When the combat continues one already recorded, its recorded slot order
   * is the best guess: the order rarely changes (18 of 19 rounds in cbt_002).
   * Otherwise the order the notes list the turns in the first round. Anyone
   * who first acts after the first round gets `from` set to that round (the
   * Ogre arriving late), which the DM can change.
   */
  function proposeOrder(rows, recordedOrder, firstRound, startRound) {
    const rank = new Map((recordedOrder || []).map((id, i) => [id, i]));
    const listedIdx = new Map(rows.map((r, i) => [r.key, i]));
    const sorted = rows.slice().sort((a, b) => {
      const ra = rank.has(a.key) ? rank.get(a.key) : Infinity, rb = rank.has(b.key) ? rank.get(b.key) : Infinity;
      return ra !== rb ? ra - rb : listedIdx.get(a.key) - listedIdx.get(b.key);
    });
    for (const r of sorted) {
      const f = firstRound.get(r.key);
      if (startRound != null && f != null && f > startRound) r.from = f;
    }
    return sorted;
  }

  // ── Pass 1: the initiative order ──────────────────────────────────────────

  /** moveRow(grid, from, to) — drag a row of the order; every round follows. */
  function moveRow(grid, from, to) {
    if (from === to || from < 0 || to < 0 || from >= grid.rows.length || to >= grid.rows.length) return;
    const [r] = grid.rows.splice(from, 1);
    grid.rows.splice(to, 0, r);
  }

  /** setJoinLeave(grid, rowKey, from, to) — the rounds an entry joins and leaves (null = start / end). */
  function setJoinLeave(grid, rowKey, from, to) {
    const r = grid.rows.find(x => x.key === rowKey);
    if (!r) throw new Error('No such row.');
    r.from = from == null || from === '' ? null : Number(from);
    r.to = to == null || to === '' ? null : Number(to);
  }

  /**
   * setOverride(grid, n, rowKeys|null) — a round that really differs (a
   * surprise round) gets its own order; null removes the override.
   */
  function setOverride(grid, n, rowKeys) {
    const r = roundOf(grid, n);
    r.override = rowKeys ? rowKeys.slice() : null;
  }

  // orderFor(grid, n) → row keys in slot order for round n.
  function orderFor(grid, n) {
    const r = roundOf(grid, n);
    return r && r.override ? r.override.slice() : grid.rows.map(x => x.key);
  }

  function roundOf(grid, n) {
    const r = grid.rounds.find(x => Number(x.n) === Number(n));
    if (!r) throw new Error(`No round ${n}.`);
    return r;
  }

  // ── Pass 2: moves in the grid ─────────────────────────────────────────────
  // A cell address is { round, row } for a party row or { round, enemy } for
  // an enemy row. An activity adds { ai }, an outcome { ai, oi }.

  function cellAt(grid, at, create) {
    const r = roundOf(grid, at.round);
    const bag = at.enemy != null ? r.enemy : r.cells;
    const key = at.enemy != null ? at.enemy : at.row;
    if (!bag[key] && create) bag[key] = emptyCell();
    return bag[key] || null;
  }

  /**
   * moveTurn(grid, from, to) — move a whole turn to another row or round.
   * If the target cell already has a turn the two swap: "two turns swapped
   * in one round" is fixed by dragging one onto the other.
   */
  function moveTurn(grid, from, to) {
    const a = cellAt(grid, from, false);
    if (!a) throw new Error('There is no turn there to move.');
    const b = cellAt(grid, to, true);
    const tmp = clone(b);
    Object.assign(b, clone(a));
    Object.assign(a, tmp);
    cleanup(grid, from);
  }

  /** moveActivity(grid, from {round,row|enemy,ai}, to {round,row|enemy}) — one activity to another cell. */
  function moveActivity(grid, from, to, extra) {
    const a = cellAt(grid, from, false);
    if (!a || !a.activities[from.ai]) throw new Error('There is no such activity.');
    const [act] = a.activities.splice(from.ai, 1);
    // A reaction moved to the reactor's row keeps a note of the turn it
    // interrupted, so the link is not lost (the schema has no field for it).
    if (extra && extra.interrupted) act.notes = [act.notes, `Interrupted ${extra.interrupted}'s turn`].filter(Boolean).join('; ');
    const b = cellAt(grid, to, true);
    b.activities.push(act);
    // The activity's own source line goes with it, so the source-line check
    // judges it in its new row; the old cell keeps only the lines its
    // remaining activities came from.
    const line = act.source_line ? { text: act.source_line, page: act.source_page } : a.source_lines[0];
    if (line && !b.source_lines.some(l => l.text === line.text)) b.source_lines.push(clone(line));
    if (!a.activities.length) a.source_lines = [];
    else if (act.source_line && !a.activities.some(x => x.source_line === act.source_line)) a.source_lines = a.source_lines.filter(l => l.text !== act.source_line);
    cleanup(grid, from);
  }

  /** moveOutcome(grid, from {…,ai,oi}, to {…,ai}) — one roll to another activity. */
  function moveOutcome(grid, from, to) {
    const a = cellAt(grid, from, false);
    const act = a && a.activities[from.ai];
    if (!act || !act.outcomes[from.oi]) throw new Error('There is no such outcome.');
    const b = cellAt(grid, to, false);
    const target = b && b.activities[to.ai];
    if (!target) throw new Error('Move the outcome onto an activity.');
    target.outcomes.push(act.outcomes.splice(from.oi, 1)[0]);
  }

  /** setEconomy(grid, at {…,ai}, economy) — an activity logged under the wrong economy. */
  function setEconomy(grid, at, economy) {
    const act = activityAt(grid, at);
    act.economy = economy;
  }

  /**
   * editActivity(grid, at, fields) / editOutcome(grid, at, fields) — fix a
   * misread in place: "Iteraling Hinds" → Healing Hands, "Not 1" → "Nat 1".
   * Only the given fields change; an empty string clears an optional field.
   */
  function editActivity(grid, at, fields) {
    const act = activityAt(grid, at);
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'outcomes') continue;
      if (v === '' || v == null) { if (k !== 'name' && k !== 'economy') delete act[k]; }
      else act[k] = v;
    }
  }
  function editOutcome(grid, at, fields) {
    const act = activityAt(grid, at);
    const o = act.outcomes[at.oi];
    if (!o) throw new Error('There is no such outcome.');
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'val') o.val = v === '' || v == null ? null : Number(v);
      else if (v === '' || v == null) { if (k === 'res' || k === 'target_id') o[k] = null; else delete o[k]; }
      else o[k] = v;
    }
    if (o.target_id) delete o.target_text;
  }

  /** addActivity(grid, at, activity) / addOutcome(grid, at, outcome) — something the read missed. */
  function addActivity(grid, at, activity) {
    const c = cellAt(grid, at, true);
    c.activities.push(Object.assign({ economy: 'action', name: 'Attack', outcomes: [] }, clone(activity)));
    return c.activities.length - 1;
  }
  function addOutcome(grid, at, outcome) {
    const act = activityAt(grid, at);
    act.outcomes.push(Object.assign({ res: null, val: null, target_id: null }, clone(outcome || {})));
  }
  function removeActivity(grid, at) {
    const c = cellAt(grid, at, false);
    if (!c || !c.activities[at.ai]) throw new Error('There is no such activity.');
    c.activities.splice(at.ai, 1);
    cleanup(grid, at);
  }
  function removeOutcome(grid, at) {
    const act = activityAt(grid, at);
    act.outcomes.splice(at.oi, 1);
  }

  function activityAt(grid, at) {
    const c = cellAt(grid, at, false);
    const act = c && c.activities[at.ai];
    if (!act) throw new Error('There is no such activity.');
    return act;
  }

  // cleanup — an emptied cell is removed, so an empty turn is not published.
  function cleanup(grid, at) {
    const r = roundOf(grid, at.round);
    const bag = at.enemy != null ? r.enemy : r.cells;
    const key = at.enemy != null ? at.enemy : at.row;
    const c = bag[key];
    if (c && !c.activities.length && !c.special_events.length) delete bag[key];
  }

  /**
   * eventToActivity(grid, round, eventIndex, spec) — turn a misread event
   * into an activity with one outcome per target, keeping the event's text
   * as its source line (#103, decided 23 October: session 6's "Hit - Dragon,
   * Dragon, Oregon" came out as an event, not three attacks).
   * spec = { row | enemy, economy, name, detail?, res?, targets: [{ target_id } | { target_text }] }
   */
  function eventToActivity(grid, round, eventIndex, spec) {
    const r = roundOf(grid, round);
    const ev = r.events[eventIndex];
    if (!ev) throw new Error('There is no such event.');
    if (!spec || (spec.row == null && spec.enemy == null)) throw new Error('Choose the row the attacks belong to.');
    const targets = spec.targets && spec.targets.length ? spec.targets : [{ target_id: null }];
    const at = spec.enemy != null ? { round, enemy: spec.enemy } : { round, row: spec.row };
    const c = cellAt(grid, at, true);
    const act = { economy: spec.economy || 'action', name: spec.name || 'Attack', outcomes: targets.map(t => {
      const o = { res: spec.res || 'hit', val: null, target_id: t.target_id || null };
      if (!o.target_id && t.target_text) o.target_text = t.target_text;
      return o;
    }) };
    if (spec.detail) act.detail = spec.detail;
    act.source_line = ev.text;
    act.source_page = ev.page;
    c.activities.push(act);
    c.source_lines.push({ text: ev.text, page: ev.page });
    r.events.splice(eventIndex, 1);
    return c.activities.length - 1;
  }

  /**
   * applySuggestedMove(grid, flag, to) — the one-click fix a flag offers
   * ("Move to Att"). A source-line flag moves the whole turn (its line names
   * the right owner); an ability or imbalance flag on one activity moves
   * that activity. `to` is the target row's key (the entity id).
   */
  function applySuggestedMove(grid, flag, toRow) {
    const at = flag.at;
    if (!at) throw new Error('This flag is not on a cell.');
    if (flag.check === 'source-line' || at.ai == null) {
      if (at.ai == null && flag.check !== 'source-line') {
        // An imbalance flag names the doubled cell: move its last action.
        const c = cellAt(grid, at, false);
        const i = c ? c.activities.map(a => a.economy).lastIndexOf('action') : -1;
        if (i < 0) throw new Error('Nothing to move.');
        return moveActivity(grid, Object.assign({}, at, { ai: i }), { round: at.round, row: toRow });
      }
      return moveTurn(grid, at, { round: at.round, row: toRow });
    }
    return moveActivity(grid, at, { round: at.round, row: toRow });
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /**
   * toTurnSchema(grid, sessionRef) → { combat, rounds, rosterAdds, held, events }
   *
   * The grid as 5.0.0 rounds: slots numbered by the confirmed order (or the
   * round's override), skipping rows outside their from/to range unless
   * they hold a turn; enemy turns one per group. Each slot carries the
   * working fields the checks read (source_line, note_order); publish (#106)
   * drops them. rosterAdds are the enemy groups the combat's roster lacks (a
   * new creature in this combat), pointing at their bestiary entry.
   */
  // forOutput(activities) → copies without the grid's working fields.
  const forOutput = acts => clone(acts).map(a => { delete a.source_line; delete a.source_page; return a; });

  function toTurnSchema(grid, sessionRef) {
    const rounds = grid.rounds.map(r => {
      const keys = orderFor(grid, r.n);
      const slots = [];
      keys.forEach((key, i) => {
        const c = r.cells[key];
        if (!c || !c.activities.length) return;
        const slot = { s: i + 1, a: key, activities: forOutput(c.activities), notes: c.notes.length ? c.notes.join('; ') : null };
        if (c.source_lines.length) slot.source_line = c.source_lines[0].text;
        if (c.noteOrder != null) slot.note_order = c.noteOrder;
        slots.push(slot);
      });
      // A turn in a row that is no longer in the order (a removed row) is kept
      // at the end rather than dropped.
      let extra = keys.length;
      for (const [key, c] of Object.entries(r.cells)) if (!keys.includes(key) && c.activities.length) {
        slots.push({ s: ++extra, a: key, activities: forOutput(c.activities), notes: null });
      }
      // An enemy cell with nothing in it (the AI listed a group with no
      // actions) is not written as an empty turn.
      const enemy_turns = Object.entries(r.enemy).filter(([, c]) => c.activities.length || c.special_events.length)
        .map(([key, c]) => ({ actor_id: key, activities: forOutput(c.activities),
          special_events: clone(c.special_events), notes: c.notes.length ? c.notes.join('; ') : null }));
      const out = { n: r.n, slots, enemy_turns };
      if (sessionRef) out.sid = sessionRef;
      return out;
    });
    const rosterAdds = grid.enemyRows.filter(e => e.isNew).map(e => ({ actor_id: e.key, type: 'group', mon_ref: e.entityId || null, count: null, count_remaining: null, notes: null }));
    const events = grid.rounds.flatMap(r => r.events.map(e => ({ round: r.n, text: e.text, page: e.page })));
    return { combat: grid.combat, rounds, rosterAdds, held: grid.held.slice(), events };
  }

  /**
   * checkCombat(grid) → a combat object #104's roundChecks can read, and
   * checkOrder(grid) → the order in its { s, a, from, to } shape.
   */
  function checkCombat(grid, roster) {
    const t = toTurnSchema(grid, null);
    return { id: grid.combat, name: grid.name, mechanics: { enemies_roster: (roster || []).concat(t.rosterAdds) }, rounds: t.rounds };
  }
  function checkOrder(grid) {
    return grid.rows.map((r, i) => ({ s: i + 1, a: r.key, from: r.from, to: r.to }));
  }

  /**
   * mapFlags(grid, flags) → flags with `at` (a grid address) added.
   * A flag names a slot number; the grid knows which row holds that slot in
   * that round. An activity index is carried across, so the flag can light
   * the exact line and its suggested move can move that line.
   */
  function mapFlags(grid, flags) {
    return flags.map(f => {
      const c = f.cell || {};
      let at = null;
      if (c.s != null) {
        // toTurnSchema numbers a slot by its row's position in the order, so
        // slot s is the order's s-th row (rows outside the order follow it).
        const r = roundOf(grid, c.round);
        const keys = orderFor(grid, c.round);
        const outside = Object.keys(r.cells).filter(k => !keys.includes(k) && r.cells[k].activities.length);
        const key = keys[c.s - 1] || outside[c.s - 1 - keys.length];
        if (key) at = { round: c.round, row: key };
      } else if (c.actor_id != null) at = { round: c.round, enemy: c.actor_id };
      else if (c.round != null) at = { round: c.round };
      if (at && c.activity != null) at.ai = c.activity;
      return Object.assign({}, f, { at });
    });
  }

  /**
   * attachSelfCheck(grid, notes, refs) → notes that matched no cell.
   * #101's AI self-check notes ("Round 4: 'Iteraling Hinds' on Asp's line
   * (occ_1_1) …") are shown beside the cell they concern: the round number
   * and an occurrence id in the note find the cell. A note naming a round but
   * no cell sits on the round; anything else is returned for a general list.
   */
  function attachSelfCheck(grid, notes, refs) {
    const byOcc = new Map(refs.map(r => [r.occ, r]));
    const loose = [];
    for (const r of grid.rounds) {
      for (const c of Object.values(r.cells)) c.aiNotes = [];
      for (const c of Object.values(r.enemy)) c.aiNotes = [];
      r.aiNotes = [];
    }
    for (const note of notes || []) {
      const m = /round\s+(\d+)/i.exec(note);
      const round = m && grid.rounds.find(r => r.n === Number(m[1]));
      if (!round) { loose.push(note); continue; }
      const occs = note.match(/occ_[A-Za-z0-9]+_\d+/g) || [];
      let placed = false;
      for (const occ of occs) {
        const ref = byOcc.get(occ);
        if (!ref) continue;
        const roster = /^roster:[^:]+:(.+)$/.exec(ref.entityId || '');
        const cell = roster ? round.enemy[roster[1]] : round.cells[ref.entityId];
        if (cell) { cell.aiNotes.push(note); placed = true; break; }
      }
      if (!placed) round.aiNotes.push(note);
    }
    return loose;
  }

  /**
   * replaceRound(grid, n, combatFacts, ctx) — puts back one round that the DM
   * sent to the AI again ("Re-extract this round") with the confirmed order.
   * Only that round's cells and events change; the order, other rounds and
   * every other edit stay.
   */
  function replaceRound(grid, n, combatFacts, ctx) {
    const one = buildGrid({ combat: grid.combat, rounds: combatFacts.rounds.filter(r => Number(r.n) === Number(n)) }, ctx);
    const fresh = one.rounds[0];
    if (!fresh) throw new Error(`The AI's reply had no round ${n}.`);
    const i = grid.rounds.findIndex(r => Number(r.n) === Number(n));
    fresh.override = grid.rounds[i] ? grid.rounds[i].override : null;
    if (i >= 0) grid.rounds[i] = fresh; else grid.rounds.push(fresh);
    for (const row of one.rows) if (!grid.rows.some(x => x.key === row.key)) grid.rows.push(row);
    for (const e of one.enemyRows) if (!grid.enemyRows.some(x => x.key === e.key)) grid.enemyRows.push(e);
    grid.held = grid.held.filter(h => Number(h.round) !== Number(n)).concat(one.held);
  }

  const api = {
    splitAssignments, assignWhere, buildGrid, proposeOrder,
    moveRow, setJoinLeave, setOverride, orderFor,
    moveTurn, moveActivity, moveOutcome, setEconomy, editActivity, editOutcome,
    addActivity, addOutcome, removeActivity, removeOutcome, eventToActivity, applySuggestedMove,
    toTurnSchema, checkCombat, checkOrder, mapFlags, attachSelfCheck, replaceRound,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChronicleGrid = api;
})(typeof window !== 'undefined' ? window : globalThis);
