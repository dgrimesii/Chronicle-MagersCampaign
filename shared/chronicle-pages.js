/**
 * shared/chronicle-pages.js
 *
 * Entity pages, judgment events and the session header: the rest of step 4
 * of the session page (issue #105).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * After the round grid, the DM reviews what the session changed about each
 * entity it touched. The redesign (docs/intake-redesign.md, "Identity first"
 * and "Where your review goes") gives each entity or event a page with its
 * new passages and a proposed change to its text, built from those passages
 * and shown against what exists. Judgment calls (a character moment, a
 * significant relationship, a death, a change of allegiance, who holds an
 * item) are flagged for the DM to approve or drop, never written silently.
 * The session header's title and summary are drafted from the passages,
 * by the big draft and again on demand by the header's own Draft button
 * (#74, a smaller call: headerPrompt / parseHeader).
 *
 * One AI call drafts all of it for the session (ChronicleAI.draftPages);
 * the prompt, the reply check and the publish items it produces live here,
 * without DOM or network, so tests/entity-pages.test.js runs the code the
 * page runs.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChroniclePages (and module.exports under Node):
 *   TEXT_FIELDS                    — the narrative text fields a page may
 *                                    propose changes to, per array
 *   MOMENT_TYPES, RELATIONSHIP_TYPES, DISPOSITIONS — the schema's vocabularies
 *   touchedPages(ctx)              — one page per entity or event the session
 *                                    touched, with its passages and current text
 *   draftPrompt(ctx) / parseDraft(text) / validateDraft(draft, pages, ctx)
 *                                  — the AI call that proposes text changes,
 *                                    judgment events and the header
 *   textItems(pages, decisions)    — accepted text changes as publish items
 *   judgmentItems(judgments, ctx)  — approved judgment events as publish items
 *   headerPrompt(ctx) / parseHeader(text) — the header's own draft call (#74)
 *   headerReplaceItem(rec, header) — the MOD that replaces a placeholder's
 *                                    recorded title / summary when the DM asks
 *   headerForPublish(header, replace) — the header item without the fields
 *                                    that MOD replaces
 *
 * No dependencies. No DOM, storage or network access.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * The session page could not show entity pages, judgment events or a
 * drafted header, and publish (#106) would get no text changes from them.
 */

(function(root) {
  'use strict';

  /**
   * TEXT_FIELDS — the prose fields a page may change, per array. Only
   * narrative text the notes can inform: never a generated field
   * (flavor_text, chronicle_entry) and never a PC's own character text,
   * which belongs to the player.
   */
  const TEXT_FIELDS = {
    npc_directory:      ['description', 'personality', 'role_in_story', 'significance'],
    bestiary:           ['description', 'encounter_notes'],
    locations:          ['description', 'significance'],
    inventory_and_loot: ['description', 'significance', 'condition'],
    world_lore:         ['content', 'implications'],
    quest_ledger:       ['motivation'],
    combat_encounters:  ['setup', 'turning_point', 'finale', 'aftermath'],
    character_moments:  ['description', 'significance'],
    factions:           ['description'],
    cohorts:            ['description'],
  };

  // The schema's own vocabularies (data/magers-campaign.json
  // _field_type_reference, and CLAUDE.md for relationship types).
  const MOMENT_TYPES = ['clutch_save', 'combat_highlight', 'character_revelation', 'backstory_revelation',
    'relationship_moment', 'sacrifice', 'comedy', 'tragedy'];
  const RELATIONSHIP_TYPES = ['combat_antagonist', 'allied', 'quest_connection', 'location_inhabitant',
    'social_contact', 'witnessed', 'unknown'];
  const DISPOSITIONS = ['friendly', 'neutral', 'unfriendly', 'hostile', 'unknown', 'deceased'];
  const JUDGMENT_KINDS = ['moment', 'relationship', 'death', 'revival', 'allegiance', 'holder'];

  const clone = v => JSON.parse(JSON.stringify(v));

  /**
   * touchedPages(ctx) → [{ id, array, name, isNew, passages, text }]
   *
   * ctx = { campaign, refs, passages, combats, newEntities: Map, nameOf }.
   * One page per entity this session touched: every settled occurrence's
   * entity (a roster group counts as its combat), every combat the facts
   * name, and the session itself. A PC gets a page only when a passage is
   * about them; their character text is not proposed. text holds the current
   * value of each TEXT_FIELDS field ('' for a new entity), so a proposal can
   * be shown against what exists. passages are this session's passages that
   * attach to the entity, with their speaker.
   */
  function touchedPages(ctx) {
    const pages = new Map();
    const find = id => {
      for (const arr of Object.keys(TEXT_FIELDS).concat('party')) {
        const e = (ctx.campaign[arr] || []).find(x => x.id === id);
        if (e) return { e, arr };
      }
      return null;
    };
    const add = id => {
      if (!id || pages.has(id)) return pages.get(id);
      const found = find(id);
      const made = ctx.newEntities && ctx.newEntities.get(id);
      if (!found && !made) return null;
      const array = found ? found.arr : made.array;
      const text = {};
      for (const f of TEXT_FIELDS[array] || []) {
        const v = found && found.e.narrative ? found.e.narrative[f] : null;
        text[f] = typeof v === 'string' ? v : '';
      }
      const page = { id, array, name: ctx.nameOf ? ctx.nameOf(id) : (found ? (found.e.name || found.e.title) : made.name), isNew: !found, passages: [], text };
      pages.set(id, page);
      return page;
    };
    for (const r of ctx.refs || []) {
      const m = /^roster:([^:]+):/.exec(r.entityId || '');
      const id = m ? m[1] : r.entityId;
      const arr = find(id)?.arr;
      if (arr !== 'party') add(id);
    }
    for (const c of ctx.combats || []) add(c);
    (ctx.passages || []).forEach((p, i) => {
      const target = p.targetId;
      if (!target) return;
      const page = add(target);
      if (page) page.passages.push(Object.assign({ index: i }, p));
    });
    return [...pages.values()];
  }

  /**
   * draftPrompt(ctx) → the system prompt for the session's draft.
   *
   * ctx = { sessionLabel, pages, facts (short text: one line per round),
   *         sessionPassages, header: { title, summary } recorded, names }
   *
   * Asks for three things, each with rules from the design:
   *   changes   — for an entity page, a rewrite of a text field that folds in
   *               what this session's passages add, keeping what is recorded;
   *               no fact the passages and facts do not contain; an NPC's
   *               words stay attributed ("Rufus claims…")
   *   judgments — character moments and significant relationships freely;
   *               a death or revival only when the notes state it (0 HP or
   *               downed is never death); an allegiance change when stated or
   *               implied by a change of role; an item's holder only when stated
   *   header    — a title and a summary of the session from its passages
   */
  function draftPrompt(ctx) {
    const pageText = ctx.pages.map(p => {
      const fields = Object.entries(p.text).map(([f, v]) => `    ${f}: ${v ? JSON.stringify(v) : '(empty)'}`).join('\n');
      const ps = p.passages.map(x => `    - [${x.speakerLabel || x.speaker}] ${x.text}`).join('\n');
      return `${p.id} | ${p.array} | ${p.name}${p.isNew ? ' (new this session)' : ''}\n  current text:\n${fields || '    (no text fields)'}\n  passages this session:\n${ps || '    (none)'}`;
    }).join('\n\n');
    return `You help a Dungeon Master update a D&D campaign record after a session. You propose; the DM approves every change. Facts in the record are ground truth.

SESSION: ${ctx.sessionLabel}
RECORDED HEADER: title ${ctx.header && ctx.header.title ? JSON.stringify(ctx.header.title) : '(none)'}, summary ${ctx.header && ctx.header.summary ? JSON.stringify(ctx.header.summary) : '(none)'}

WHAT HAPPENED (facts, one line per round):
${ctx.facts || '(no combat)'}

SESSION-LEVEL PASSAGES:
${(ctx.sessionPassages || []).map(x => `- [${x.speakerLabel || x.speaker}] ${x.text}`).join('\n') || '(none)'}

ENTITY PAGES (id | array | name, current text fields, this session's passages):
${pageText || '(none)'}

TASKS:
1. "changes": for an entity page whose passages add something to a text field, propose the field's new full text: keep what is recorded, fold in what the passages add, in the same voice. Only fields listed for that page. Add no fact the passages or facts do not contain. Words an NPC said are testimony: keep them attributed ("Rufus claims the dragons keep a pact"), never stated as fact. Skip fields with nothing new. Each: {"id","field","text","reason"}.
2. "judgments": events the DM must approve. Each has "kind", "source" (the passage or fact it rests on, quoted) and:
   - "moment": a significant character moment. {"type": one of ${MOMENT_TYPES.join(', ')}, "character_ids": [ids], "description", "combat": combat id or null, "round": n or null}
   - "relationship": a significant relationship formed or changed. {"from_id", "to_id", "relationship_type": one of ${RELATIONSHIP_TYPES.join(', ')}, "note"}
   - "death" / "revival": only when the notes say so in words (killed, died, dead, brought back). A creature dropped to 0 HP or "downed" is NOT dead. {"id", "cause", "combat": combat id or null}
   - "allegiance": an NPC's disposition changes, when stated or plainly implied by a change of role (a captive becoming a guide). {"id", "disposition": one of ${DISPOSITIONS.join(', ')}, "note"}
   - "holder": who holds an item, only when the notes state it. {"id" (the item), "holder_id" (an entity id, or "party")}
   Use only ids from the pages above or the names list. Propose freely for moments and relationships; be strict for the others.
   Write each judgment flat, with exactly these field names, for example:
   {"kind":"moment","type":"clutch_save","character_ids":["<id>"],"description":"…","combat":null,"round":null,"source":"…"}
   {"kind":"relationship","from_id":"<id>","to_id":"<id>","relationship_type":"social_contact","note":"…","source":"…"}
3. "header": {"title": a short evocative title for the session, "summary": two to four sentences from the passages and facts}. If the recorded header has a title or summary, return it unchanged unless the session clearly says more.

NAMES YOU MAY USE (id = name): ${ctx.names || ''}

Respond with JSON only: {"changes":[],"judgments":[],"header":{"title":"","summary":""}}`;
  }

  /**
   * parseDraft(text) → { changes, judgments, header } with every part present.
   * Throws on a reply without that JSON object.
   */
  function parseDraft(text) {
    const s = String(text || '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    let body = fenced ? fenced[1] : s;
    const a = body.indexOf('{'), b = body.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('The AI reply had no JSON in it.');
    let parsed;
    try { parsed = JSON.parse(body.slice(a, b + 1)); } catch (e) { throw new Error('The AI reply was not valid JSON: ' + e.message); }
    if (!parsed || typeof parsed !== 'object') throw new Error('The AI reply was not an object.');
    return {
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      judgments: Array.isArray(parsed.judgments) ? parsed.judgments : [],
      header: parsed.header && typeof parsed.header === 'object'
        ? { title: String(parsed.header.title || ''), summary: String(parsed.header.summary || '') } : { title: '', summary: '' },
    };
  }

  /**
   * validateDraft(draft, pages, ctx) → { changes, judgments, dropped }
   *
   * Keeps only what can be written: a change to a listed field of a page,
   * with text that differs from what is recorded; a judgment whose kind,
   * vocabulary and ids are valid. Anything else is dropped with a reason,
   * shown to the DM, rather than failing the whole draft. ctx.knownIds is a
   * Set of every id the session may name (pages, PCs, combats); a holder
   * may also be "party".
   */
  function validateDraft(draft, pages, ctx) {
    const byId = new Map(pages.map(p => [p.id, p]));
    const known = (ctx && ctx.knownIds) || new Set(pages.map(p => p.id));
    const dropped = [];
    const changes = [];
    for (const c of draft.changes) {
      const p = byId.get(c.id);
      if (!p) { dropped.push(`A text change for "${c.id}", which has no page.`); continue; }
      if (!(TEXT_FIELDS[p.array] || []).includes(c.field)) { dropped.push(`A change to ${p.name}'s "${c.field}", which is not a text field it has.`); continue; }
      const text = String(c.text || '').trim();
      if (!text || text === p.text[c.field]) continue; // nothing new
      changes.push({ id: c.id, field: c.field, text, reason: String(c.reason || ''), before: p.text[c.field] || '' });
    }
    const judgments = [];
    for (const raw of draft.judgments) {
      const j = normaliseJudgment(raw);
      const why = invalidJudgment(j, known);
      // The fields the AI sent are named, so a dropped proposal can be
      // understood (and the prompt fixed) rather than vanishing.
      if (why) dropped.push(why + ' (sent: ' + Object.keys(raw || {}).join(', ') + ')');
      else judgments.push(Object.assign({}, j, { source: String(j.source || '') }));
    }
    return { changes, judgments, dropped };
  }

  /**
   * normaliseJudgment(raw) → the judgment with the field names this module
   * reads. The first real run (session 6) sent every character moment with
   * its type under another name, and all six were dropped; the names an AI
   * plausibly uses are accepted: moment_type / subtype for type, characters /
   * pcs / ids for character_ids (a single id becomes a list), entity_id /
   * target_id for id, from / to for from_id / to_id, holder for holder_id.
   */
  function normaliseJudgment(raw) {
    const j = Object.assign({}, raw || {});
    j.kind = j.kind || j.type_of_event || j.category;
    if (j.kind === 'moment') {
      j.type = j.type || j.moment_type || j.subtype;
      let ids = j.character_ids || j.characters || j.pcs || j.ids || j.character_id;
      if (typeof ids === 'string') ids = [ids];
      j.character_ids = ids;
      j.description = j.description || j.text || j.summary;
    }
    j.id = j.id || j.entity_id || j.target_id;
    j.from_id = j.from_id || j.from;
    j.to_id = j.to_id || j.to;
    j.holder_id = j.holder_id || j.holder;
    return j;
  }

  // invalidJudgment(j, known) → why the judgment cannot be written, or null.
  function invalidJudgment(j, known) {
    const has = id => known.has(id);
    switch (j && j.kind) {
      case 'moment':
        if (!MOMENT_TYPES.includes(j.type)) return `A character moment of unknown type "${j.type}".`;
        if (!Array.isArray(j.character_ids) || !j.character_ids.length || !j.character_ids.every(has)) return `A character moment naming a character the session does not have (${(j.character_ids || []).filter(x => !has(x)).join(', ') || 'none named'}).`;
        if (!j.description) return 'A character moment with no description.';
        return null;
      case 'relationship':
        if (!has(j.from_id) || !has(j.to_id)) return `A relationship naming an entity the session does not have (${!has(j.from_id) ? j.from_id : j.to_id}).`;
        if (!RELATIONSHIP_TYPES.includes(j.relationship_type)) return `A relationship of unknown type "${j.relationship_type}".`;
        return null;
      case 'death': case 'revival':
        if (!has(j.id)) return `A ${j.kind} of an entity the session does not have.`;
        // 0 HP is never death: a death resting only on "downed" or "0 HP" is refused.
        if (j.kind === 'death' && /\b(down(ed)?|0 ?hp|zero hit points|unconscious)\b/i.test(j.source || '') && !/\b(kill(ed)?|dies|died|dead|slain)\b/i.test(j.source || '')) return 'A death resting only on "downed" or 0 HP, which is never death.';
        return null;
      case 'allegiance':
        if (!has(j.id)) return 'An allegiance change for an entity the session does not have.';
        if (!DISPOSITIONS.includes(j.disposition)) return `An allegiance change to unknown disposition "${j.disposition}".`;
        return null;
      case 'holder':
        if (!has(j.id)) return 'A holder for an item the session does not have.';
        if (j.holder_id !== 'party' && !has(j.holder_id)) return 'A holder the session does not have.';
        return null;
      default:
        return `A judgment of unknown kind "${j && j.kind}".`;
    }
  }

  /**
   * textItems(pages, accepted) → MOD items with _set, one per accepted change.
   * accepted = [{ id, field, text }] (the DM's final text, edited or not).
   * A field is set on its own path (narrative.<field>), so accepting a new
   * description changes nothing else on the entity.
   */
  function textItems(pages, accepted) {
    const byId = new Map(pages.map(p => [p.id, p]));
    const items = [];
    for (const c of accepted) {
      const p = byId.get(c.id);
      if (!p) continue;
      items.push({ id: 'text_' + c.id + '_' + c.field, type: 'MOD', array: p.array, status: 'approved', targetId: c.id,
        title: `${p.name}: ${c.field}`, rawData: { id: c.id, _set: { ['narrative.' + c.field]: c.text } } });
    }
    return items;
  }

  /**
   * judgmentItems(approved, ctx) → publish items for approved judgments.
   * ctx = { sessionRef (session_NNN), arrayOf(id), newId() }.
   *   moment       → NEW character_moments entry, origin_session the session
   *   relationship → RELATIONSHIP, significance significant_event
   *   death        → MOD _set mechanics.status_event {type death…} and
   *                  mechanics.disposition deceased (NPCs)
   *   revival      → MOD _set mechanics.status_event {type revival…}
   *   allegiance   → MOD _set mechanics.disposition, plus a passage recording
   *                  the change on the NPC (the design: an event on the NPC
   *                  with its passage, which the disposition follows)
   *   holder       → MOD _set mechanics.current_holder
   */
  function judgmentItems(approved, ctx) {
    const items = [];
    const mod = (id, title, set, extra) => items.push(Object.assign({ id: 'judg_' + items.length, type: 'MOD', array: ctx.arrayOf(id), status: 'approved', targetId: id, title,
      rawData: Object.assign({ id, _set: set }, extra || {}) }));
    for (const j of approved) {
      if (j.kind === 'moment') {
        const id = ctx.newId();
        items.push({ id: 'judg_' + items.length, type: 'NEW', array: 'character_moments', status: 'approved', title: 'Character moment: ' + j.type,
          rawData: { _object_type: 'character_moment', id, type: j.type,
            mechanics: { character_ids: clone(j.character_ids), parent_event_id: j.combat || null, origin_session: ctx.sessionRef, round_ref: j.round ?? null, mechanical_action: j.source || null },
            narrative: { description: j.description, significance: j.significance || null }, notes: null } });
      } else if (j.kind === 'relationship') {
        items.push({ id: 'judg_' + items.length, type: 'RELATIONSHIP', array: 'entity_relationships', status: 'approved', title: 'Relationship',
          rawData: { from_id: j.from_id, from_type: ctx.arrayOf(j.from_id) || 'unknown', to_id: j.to_id, to_type: ctx.arrayOf(j.to_id) || 'unknown',
            relationship_type: j.relationship_type, significance: 'significant_event', established_session: ctx.sessionRef, ground_truth_notes: j.note || j.source || '' } });
      } else if (j.kind === 'death') {
        const set = { 'mechanics.status_event': { type: 'death', session: ctx.sessionRef, combat: j.combat || null, cause: j.cause || null } };
        if (ctx.arrayOf(j.id) === 'npc_directory') set['mechanics.disposition'] = 'deceased';
        mod(j.id, 'Death', set);
      } else if (j.kind === 'revival') {
        mod(j.id, 'Revival', { 'mechanics.status_event': { type: 'revival', session: ctx.sessionRef, combat: j.combat || null, cause: j.cause || null } });
      } else if (j.kind === 'allegiance') {
        mod(j.id, 'Allegiance', { 'mechanics.disposition': j.disposition },
          j.note ? { _passage_append: [{ text: j.note, session_id: ctx.sessionRef, speaker: 'dm', page: null }] } : null);
      } else if (j.kind === 'holder') {
        mod(j.id, 'Holder', { 'mechanics.current_holder': j.holder_id });
      }
    }
    return items;
  }

  /**
   * headerPrompt(ctx) → the system prompt for the session header's own
   * draft (#74): a title and a summary, nothing else.
   *
   * ctx = { sessionLabel ("session_008, played 2026-04-16"), roster (the
   *         party's names), passages: [{ text, speakerLabel }] (every
   *         passage of the session, wherever it sits), combats: [{ name,
   *         rounds, outcome }], facts (one line per round) }
   *
   * Why a separate call when the big draft (draftPrompt) also returns a
   * header: the DM asks for a header on its own, after moving passages or
   * correcting rounds, without redrafting every entity page and losing the
   * decisions made on them. Why only passages and confirmed data: the
   * header is the session's record, so it may say nothing the notes and the
   * DM's corrections do not.
   */
  function headerPrompt(ctx) {
    const combats = (ctx.combats || []).map(c =>
      `- ${c.name}: ${c.rounds} round${c.rounds === 1 ? '' : 's'}${c.outcome ? ', outcome ' + c.outcome : ''}`).join('\n');
    const passages = (ctx.passages || []).map(p => `- [${p.speakerLabel || p.speaker || 'DM'}] ${p.text}`).join('\n');
    return `You write the title and summary of one D&D session for a Dungeon Master's campaign record. The DM edits what you write before it is saved.

SESSION: ${ctx.sessionLabel}
PARTY: ${ctx.roster || '(not given)'}

COMBATS THIS SESSION:
${combats || '(none)'}

WHAT HAPPENED IN COMBAT (confirmed, one line per round):
${ctx.facts || '(no combat)'}

PASSAGES (the session's narrative; [DM] is fact, a named speaker is that NPC's claim):
${passages || '(none)'}

WRITE:
- "title": 5 to 10 words, flavourful but factual: name what actually happened, not a mood.
- "summary": 2 to 4 sentences, past tense, naming the PCs by name, covering the session in order.
RULES:
- Use only what the passages and combats above say. Add no event, name, motive or outcome they do not contain.
- An NPC's words are their claim: "Rufus warned that…", never stated as fact.
- A creature at 0 HP or "downed" is not dead unless the passages or combat lines say it was killed.

Respond with JSON only: {"title":"","summary":""}`;
  }

  /**
   * parseHeader(text) → { title, summary, warnings }
   *
   * Reads the header draft's JSON. Throws when the reply has no JSON or
   * leaves either field empty, so the page shows an error and keeps the
   * fields as they were (#74) rather than filling one and blanking the
   * other. A title outside 5–10 words or a summary outside 2–4 sentences is
   * kept but warned about: the DM is editing it anyway, and refusing a
   * usable draft over one word would only cost another call.
   */
  function parseHeader(text) {
    const str = String(text || '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(str);
    const body = fenced ? fenced[1] : str;
    const a = body.indexOf('{'), b = body.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('The AI reply had no JSON in it.');
    let parsed;
    try { parsed = JSON.parse(body.slice(a, b + 1)); } catch (e) { throw new Error('The AI reply was not valid JSON: ' + e.message); }
    const title = String((parsed && parsed.title) || '').trim();
    const summary = String((parsed && parsed.summary) || '').trim();
    if (!title || !summary) throw new Error('The AI reply left the ' + (!title ? 'title' : 'summary') + ' empty.');
    const warnings = [];
    const words = title.split(/\s+/).length;
    if (words < 5 || words > 10) warnings.push(`The title has ${words} words; the aim is 5 to 10.`);
    // Sentences end at . ! or ? followed by a space or the end; good enough
    // for a warning, which is all this count drives.
    const sentences = (summary.match(/[.!?]+(\s|$)/g) || []).length || 1;
    if (sentences < 2 || sentences > 4) warnings.push(`The summary has ${sentences} sentence${sentences === 1 ? '' : 's'}; the aim is 2 to 4.`);
    return { title, summary, warnings };
  }

  /**
   * headerReplaceItem(rec, header) → a MOD publish item, or null.
   *
   * rec is the recorded session (a placeholder such as session_006) and
   * header { title, summary, replaceTitle, replaceSummary } what the DM has
   * on the page. Publish fills a placeholder's title and summary only when
   * they are empty and keeps the recorded ones otherwise (fillSession), so
   * the DM's own header is never overwritten by a stub. When the DM ticks
   * "replace" for a field whose text differs, this MOD sets that one field
   * (title, narrative.summary) with _set. Null when there is nothing to
   * replace, so an untouched placeholder publishes exactly as before.
   */
  function headerReplaceItem(rec, header) {
    if (!rec || !header) return null;
    const set = {};
    const recSummary = (rec.narrative && rec.narrative.summary) || '';
    if (header.replaceTitle && header.title && header.title !== (rec.title || '')) set.title = header.title;
    if (header.replaceSummary && header.summary && header.summary !== recSummary) set['narrative.summary'] = header.summary;
    if (!Object.keys(set).length) return null;
    return { id: 'header_replace_' + rec.id, type: 'MOD', array: 'session_logs', status: 'approved', targetId: rec.id,
      title: (rec.legacy_id || 'Session') + ': replace the recorded ' + Object.keys(set).map(k => k === 'title' ? 'title' : 'summary').join(' and '),
      rawData: { id: rec.id, _set: set } };
  }

  /**
   * headerForPublish(header, replace) → the session header item to publish.
   *
   * With no replace item it is the header itself. With one, it is a copy
   * without the fields the replace item sets (title, summary), because
   * publish fills a placeholder first and would otherwise report "kept the
   * recorded title" for a title the MOD then replaces: a note that says the
   * opposite of what happened (seen on session 6, #74). The page's own
   * header is not changed, so the fields still show the DM's text.
   */
  function headerForPublish(header, replace) {
    if (!header || !replace) return header;
    const set = replace.rawData._set || {};
    const out = Object.assign({}, header, { rawData: Object.assign({}, header.rawData) });
    if ('title' in set) delete out.rawData.title;
    if ('narrative.summary' in set) {
      delete out.rawData.summary;
      if (out.rawData.narrative) { out.rawData.narrative = Object.assign({}, out.rawData.narrative); delete out.rawData.narrative.summary; }
    }
    return out;
  }

  const api = { TEXT_FIELDS, MOMENT_TYPES, RELATIONSHIP_TYPES, DISPOSITIONS, JUDGMENT_KINDS,
    touchedPages, draftPrompt, parseDraft, validateDraft, textItems, judgmentItems,
    headerPrompt, parseHeader, headerReplaceItem, headerForPublish };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChroniclePages = api;
})(typeof window !== 'undefined' ? window : globalThis);
