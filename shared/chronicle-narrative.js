/**
 * chronicle-narrative.js
 * Gemini-based narrative generation module for Chronicle.
 *
 * This module is completely independent of chronicle-ai.js (the Anthropic module).
 * It has no imports from or references to that module.
 *
 * Responsibilities:
 *   - Build sanitised ground-truth payloads for Gemini (no raw slot data or numbers)
 *   - Call the Gemini API to generate chronicle entries, flavor text, edge prose,
 *     and quest progress narratives
 *   - Detect which entities are candidates for cascade generation after a session
 *   - Audit generated text for potential hallucinations (proper noun check)
 *   - Write narrative fields back to a campaign object (guarded — only approved fields)
 *
 * The Inviolable Contract:
 *   Gemini reads ground_truth (immutable facts from the JSON). It writes only to
 *   narrative fields. chronicle_entry and flavor_text are DM-readable output, not
 *   authoritative source. writeNarrativeField() enforces this by throwing on any
 *   attempt to write a factual field.
 *
 * Requires in shared/config.js (gitignored — add manually):
 *   window.CHRONICLE_CONFIG.geminiApiKey   = '';          // Gemini API key
 *   window.CHRONICLE_CONFIG.narrativeModel = 'gemini-2.0-flash'; // optional override
 *
 * Load order when a page needs all shared modules:
 *   <script src="../shared/config.js"></script>
 *   <script src="../shared/chronicle-integrity.js"></script>
 *   <script src="../shared/chronicle-ai.js"></script>
 *   <script src="../shared/chronicle-narrative.js"></script>
 *   <!-- page script here -->
 *
 * If geminiApiKey is absent or empty, all generation functions return pre-baked
 * demo responses via onResult — no error is thrown, UI remains testable.
 */

const ChronicleNarrative = (() => {

  // ─────────────────────────────────────────────────────────
  // Config
  // Gemini uses the API key as a URL query param, not a header —
  // different auth pattern from Anthropic (which uses x-api-key header).
  // ─────────────────────────────────────────────────────────
  const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';
  const DEFAULT_MODEL  = 'gemini-2.0-flash';

  // ─────────────────────────────────────────────────────────
  // Party roster — used for combat summarisation and hallucination audit.
  // Duplicated from chronicle-ai.js PARTY_CONTEXT to keep the two modules
  // independent. If the party changes, update both files.
  // ─────────────────────────────────────────────────────────
  const PARTY_ROSTER = [
    { id: 'pc_001', name: 'Zragar',    nickname: 'Gold', cls: 'Wizard'    },
    { id: 'pc_002', name: 'Malachite', nickname: 'Mal',  cls: 'Barbarian' },
    { id: 'pc_003', name: 'Ashton',    nickname: 'Ash',  cls: 'Warlock'   },
    { id: 'pc_004', name: 'Asphodel',  nickname: 'Del',  cls: 'Monk'      },
    { id: 'pc_005', name: 'Derwin',    nickname: 'Goli', cls: 'Rogue'     },
    { id: 'pc_006', name: 'Atticus',   nickname: 'Att',  cls: 'Druid'     },
  ];

  // ─────────────────────────────────────────────────────────
  // Approved narrative fields.
  // writeNarrativeField() throws if the requested field is not in this set.
  // This is the hard wall preventing generated prose from overwriting
  // factual campaign data (NPC names, quest facts, session summaries, etc.).
  // ─────────────────────────────────────────────────────────
  const APPROVED_FIELDS = new Set([
    'chronicle_entry',
    'chronicle_entry_generated_at',
    'chronicle_entry_model',
    'chronicle_entry_version',
    'generation_warnings',
    'human_guidance',
    'flavor_text',
    'flavor_text_generated_at',
    'flavor_text_model',
    'flavor_text_version',
    'regeneration_flagged',
    'regeneration_flag_reason',
    'edge_prose',
    'edge_prose_generated_at',
    'edge_prose_model',
    'edge_prose_version',
    'progress_narrative',
  ]);

  // ─────────────────────────────────────────────────────────
  // System prompt constant.
  // Fed to Gemini as system_instruction for every generation type.
  // The specific output type (chronicle_entry, flavor_text, etc.) is
  // declared in the user message; this prompt governs all of them.
  // ─────────────────────────────────────────────────────────
  const NARRATIVE_SYSTEM_PROMPT = `ROLE
You are a professional fantasy archivist and novelist working exclusively for the
Magers Campaign. Your output is the official chronicle read by the players.
Every word must feel earned by the events at the table.

INPUT STRUCTURE
  "ground_truth"    — objective facts. Immutable. What actually happened.
  "narrative_beats" — subjective mood notes captured during play. Atmosphere only.
  "human_guidance"  — optional DM direction. Treat this as your brief.
  "cascade_context" — related entities that may appear in prose. Read-only reference.

THE INVIOLABLE LAWS

Law 1 — Conservation of Fact
Do not invent any NPC, location, item, spell, or event.
If it is not in ground_truth, it did not happen.
cascade_context entities may be referenced only if they appear in ground_truth.

Law 2 — Numbers Stay Hidden
Never write damage numbers, HP values, spell slot counts, or dice results.
Death saves: dramatic tension only ("teetering on the edge"), never as counts.

Law 3 — Mechanics Become Story
Spell and ability names may be used when flavourful.
Mechanical classifications (spell levels, damage types, DCs) may not.

Law 4 — The Uncertainty Fence
Items marked [?] or flagged as uncertain must be omitted or written around.
Never resolve an uncertainty in prose.

Law 5 — Relationship Fidelity
Only describe relationships explicitly stated in ground_truth.

Law 6 — No Interior States for Undescribed Entities
Do not describe how an NPC felt, intended, or thought unless ground_truth records it.

Law 7 — Cascade Restraint
When generating flavor text for a cascade entity, limit prose strictly to what
ground_truth records about that entity.

OUTPUT FORMAT
Return a single JSON object, no markdown fences:
{
  "type": "chronicle_entry | flavor_text | progress_narrative | edge_prose",
  "target_id": "<entity id>",
  "text": "<generated prose>",
  "generation_warnings": ["<each omission due to uncertainty or missing data>"]
}

chronicle_entry: 3-5 paragraphs, start in the action, gritty and specific.
flavor_text: 2-3 sentences, present tense, sensory detail from ground_truth only.
progress_narrative: 1-2 sentences connecting factual progress to session tone.
edge_prose: 2 sentences describing the relationship nature from each entity's perspective.
Never use "In the world of...", "The party...", or "The adventurers...".
Use character names and nicknames from ground_truth directly.`;


  // ═════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═════════════════════════════════════════════════════════

  /**
   * _resolveActorName(actorId, campaign)
   * Returns the display name for an actor ID.
   * Checks party roster (uses nickname), then NPC directory, then falls back to raw ID.
   * Used when building combat summaries — keeps actor references human-readable for Gemini.
   */
  function _resolveActorName(actorId, campaign) {
    const pc = PARTY_ROSTER.find(p => p.id === actorId);
    if (pc) return pc.nickname;
    const npc = (campaign.npc_directory || []).find(n => n.id === actorId);
    if (npc) return npc.name;
    return actorId; // unknown actor — return ID as-is
  }

  /**
   * _summariseCombatsForSession(session, campaign)
   * Translates raw combat data for a session into per-actor action lists.
   * Deliberately strips raw slot data — Gemini must not see damage numbers,
   * HP values, or initiative positions (Law 2: Numbers Stay Hidden).
   *
   * v4 slots have { a, action: { name, res } }; includes a v3 shim for
   * slot.act / slot.res in case the function is called with pre-normalised data.
   *
   * Returns an array of combat summary objects:
   *   { id, name, outcome, location, total_rounds, actor_summary: ["Name: action res (R#), ..."] }
   */
  function _summariseCombatsForSession(session, campaign) {
    const combatIds = session.mechanics?.combats || [];
    if (!combatIds.length) return [];

    return combatIds.flatMap(combatId => {
      const combat = (campaign.combat_encounters || []).find(c => c.id === combatId);
      if (!combat) return [];

      // Collect per-actor action descriptions across all rounds.
      // actorActions maps display name → array of "action result (R#)" strings.
      const actorActions = {};
      for (const round of combat.rounds || []) {
        const rn = round.round_number;
        for (const slot of round.slots || []) {
          const displayName = _resolveActorName(slot.a, campaign);
          // v4: action nested inside slot.action; v3 shim: flat slot.act / slot.res
          const actionName = slot.action?.name || slot.act || 'action';
          const result     = slot.action?.res  || slot.res  || 'unclear';
          if (!actorActions[displayName]) actorActions[displayName] = [];
          // Omit damage values entirely — val is never included (Law 2)
          actorActions[displayName].push(`${actionName} ${result} (R${rn})`);
        }
      }

      return [{
        id:           combat.id,
        name:         combat.name,
        outcome:      combat.mechanics?.outcome  || null,
        location:     combat.mechanics?.location || null,
        total_rounds: combat.mechanics?.total_rounds_logged ?? (combat.rounds || []).length,
        // One string per actor; Gemini reads this as narrative context, not data
        actor_summary: Object.entries(actorActions)
          .map(([name, acts]) => `${name}: ${acts.join(', ')}`),
      }];
    });
  }

  /**
   * _buildCascadeContext(cascadeEntityIds, campaign)
   * Looks up each entity ID and returns a minimal descriptor for Gemini.
   * Only name, type, and brief description are included — no mechanics data.
   * If an ID is not found in any array, it is silently omitted.
   */
  function _buildCascadeContext(cascadeEntityIds, campaign) {
    return (cascadeEntityIds || []).flatMap(id => {
      const npc = (campaign.npc_directory || []).find(n => n.id === id);
      if (npc) return [{ id, type: 'npc', name: npc.name, description: npc.narrative?.description || null }];

      const loc = (campaign.locations || []).find(l => l.id === id);
      if (loc) return [{ id, type: 'location', name: loc.name, description: loc.narrative?.description || null }];

      // Party members may appear as cascade context if named in a session
      const pc = PARTY_ROSTER.find(p => p.id === id);
      if (pc) return [{ id, type: 'pc', name: pc.name, nickname: pc.nickname, cls: pc.cls }];

      return []; // ID not found in any known array — omit
    });
  }

  /**
   * _callGemini({ systemPrompt, userPrompt, onResult, onError, onLoading })
   * Core fetch to the Gemini generateContent endpoint.
   *
   * Returns null (without calling any callbacks) if geminiApiKey is absent or empty.
   * Callers check for null and substitute a demo response.
   *
   * On success: calls onResult(rawText) with the first candidate's text part.
   * On error:   calls onError(Error) with a message including the HTTP status detail.
   * onLoading(bool) is optional — called true before fetch, false in finally.
   *
   * responseMimeType: 'application/json' instructs Gemini to return valid JSON
   * without markdown fences. Belt-and-suspenders: _parseNarrativeResponse also
   * strips fences in case the model ignores the MIME type hint.
   */
  async function _callGemini({ systemPrompt, userPrompt, onResult, onError, onLoading }) {
    const apiKey = window.CHRONICLE_CONFIG?.geminiApiKey;
    const model  = window.CHRONICLE_CONFIG?.narrativeModel || DEFAULT_MODEL;

    // No key — return null so caller can use demo fallback without throwing
    if (!apiKey || apiKey.trim() === '') return null;

    const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    onLoading?.(true);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.7,
            // Force JSON output — prevents Gemini from wrapping text in markdown fences
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        // Read the response body before throwing so Gemini's error message is visible
        let detail = response.statusText;
        try {
          const errBody = await response.json();
          detail = errBody?.error?.message || JSON.stringify(errBody);
        } catch (_) { /* body not JSON — keep statusText */ }
        throw new Error(`Gemini HTTP ${response.status}: ${detail}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini: no text in candidates[0].content.parts[0]');

      onResult(text);
    } catch (err) {
      onError(err);
    } finally {
      onLoading?.(false);
    }
  }

  /**
   * _parseNarrativeResponse(raw)
   * Strips accidental markdown fences and parses the Gemini JSON response.
   * responseMimeType should prevent fences, but this guards against model non-compliance.
   * Throws if the parsed object is missing the required "text" field.
   */
  function _parseNarrativeResponse(raw) {
    const clean = raw
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    const parsed = JSON.parse(clean);
    if (!parsed.text) throw new Error('Gemini response missing required "text" field');
    return parsed;
  }


  // ═════════════════════════════════════════════════════════
  // PUBLIC FUNCTIONS
  // ═════════════════════════════════════════════════════════

  /**
   * buildGroundTruthPayload(session, campaign, cascadeEntityIds)
   *
   * Constructs the sanitised read-only input object passed to Gemini.
   * Contains only narrative-relevant facts — not raw initiative slot data,
   * not Drive metadata, not HP or damage numbers.
   * Combat rounds appear as per-actor action summaries (e.g. "Att: Entangle success (R3)").
   *
   * Useful standalone for inspecting what Gemini will receive before generation.
   *
   * @param {object}   session          - Raw session_logs entry from magers-campaign.json
   * @param {object}   campaign         - Full campaign JSON object
   * @param {string[]} cascadeEntityIds - IDs of entities to include as cascade_context
   * @returns {{ ground_truth, narrative_beats, human_guidance, cascade_context }}
   */
  function buildGroundTruthPayload(session, campaign, cascadeEntityIds = []) {
    // Resolve NPC display info for NPCs met or lost this session
    const npcsContext = [
      ...(session.mechanics?.npcs_met  || []),
      ...(session.mechanics?.npcs_lost || []),
    ].flatMap(id => {
      const npc = (campaign.npc_directory || []).find(n => n.id === id);
      if (!npc) return [];
      return [{ id, name: npc.name, disposition: npc.mechanics?.disposition || null }];
    });

    // Resolve location names for locations visited this session
    const locationsContext = (session.mechanics?.locations_visited || []).flatMap(id => {
      const loc = (campaign.locations || []).find(l => l.id === id);
      if (!loc) return [];
      return [{ id, name: loc.name }];
    });

    // Resolve item names found this session
    const itemsContext = (session.mechanics?.items_found || []).flatMap(id => {
      const item = (campaign.inventory_and_loot || []).find(i => i.id === id);
      if (!item) return [];
      return [{ id, name: item.name }];
    });

    // Level-ups: milestone moment, relevant for narrative but no raw stats
    const levelUps = (session.mechanics?.level_ups || []).map(lu => ({
      character_id: lu.character_id,
      new_level:    lu.new_level,
    }));

    const ground_truth = {
      session_id:        session.id,
      title:             session.title,
      date:              session.date,
      summary:           session.narrative?.summary       || null,
      tone:              session.narrative?.tone          || null,
      opening_scene:     session.narrative?.opening_scene || null,
      closing_scene:     session.narrative?.closing_scene || null,
      // key_moments: flatten objects to strings; [?] markers preserved so
      // Gemini applies Law 4 (uncertainty fence) around unconfirmed details
      key_moments:       (session.narrative?.key_moments || []).map(
                           km => typeof km === 'string' ? km : (km.description || '')
                         ),
      npcs_present:      npcsContext,
      locations_visited: locationsContext,
      items_acquired:    itemsContext,
      level_ups:         levelUps,
      // Combats as per-actor summaries — raw slot data never reaches Gemini
      combats:           _summariseCombatsForSession(session, campaign),
      notes:             session.notes || null,
    };

    return {
      ground_truth,
      narrative_beats: session.narrative?.narrative_beats || [],
      human_guidance:  session.narrative?.human_guidance  || null,
      cascade_context: _buildCascadeContext(cascadeEntityIds, campaign),
    };
  }

  /**
   * generateSessionNarrative({ session, campaign, cascadeEntityIds, humanGuidance, onResult, onError, onLoading })
   *
   * Calls Gemini to generate a chronicle_entry for a session.
   * humanGuidance overrides session.narrative.human_guidance at call time
   * without modifying the JSON — useful for one-shot steering.
   *
   * onResult receives the parsed response object { type, target_id, text, generation_warnings }.
   * Returns a demo response via onResult if geminiApiKey is not configured.
   */
  async function generateSessionNarrative({
    session, campaign, cascadeEntityIds = [], humanGuidance = null,
    onResult, onError, onLoading,
  }) {
    const payload = buildGroundTruthPayload(session, campaign, cascadeEntityIds);
    // DM may pass humanGuidance at call time without modifying the JSON
    if (humanGuidance) payload.human_guidance = humanGuidance;

    const userPrompt =
      `Generate a chronicle_entry for session ${session.id}.\n\n` +
      JSON.stringify(payload, null, 2);

    let responded = false;

    const result = await _callGemini({
      systemPrompt: NARRATIVE_SYSTEM_PROMPT,
      userPrompt,
      onLoading: loading => { if (loading || !responded) onLoading?.(loading); },
      onResult: raw => {
        responded = true;
        try   { onResult(_parseNarrativeResponse(raw)); }
        catch (e) { onError(e); }
      },
      onError: e => { responded = true; onError(e); },
    });

    // _callGemini returns null when no API key — serve demo fallback
    if (result === null && !responded) {
      onLoading?.(false);
      onResult(_demoSessionNarrative(session.id));
    }
  }

  /**
   * generateEntityFlavor({ entity, entityType, relatedSessions, humanGuidance, onResult, onError, onLoading })
   *
   * Generates 2-3 sentence flavor text for an NPC or location.
   * entity:          raw NPC or location object from magers-campaign.json
   * entityType:      'npc' | 'location'
   * relatedSessions: array of raw session_logs entries where this entity appeared,
   *                  for context without exposing raw slot data
   *
   * Returns a demo response via onResult if geminiApiKey is not configured.
   */
  async function generateEntityFlavor({
    entity, entityType, relatedSessions = [], humanGuidance = null,
    onResult, onError, onLoading,
  }) {
    // Build entity context: factual fields only, no existing flavor text
    const entityContext = {
      id:   entity.id,
      name: entity.name,
      type: entityType,
      ...(entityType === 'npc' ? {
        disposition:   entity.mechanics?.disposition    || null,
        role:          entity.mechanics?.role           || null,
        description:   entity.narrative?.description    || null,
        personality:   entity.narrative?.personality    || null,
        role_in_story: entity.narrative?.role_in_story  || null,
      } : {
        visibility:    entity.mechanics?.visibility  || null,
        location_type: entity.mechanics?.type        || null,
        description:   entity.narrative?.description || null,
        atmosphere:    entity.narrative?.atmosphere  || [],
        significance:  entity.narrative?.significance || null,
      }),
    };

    const payload = {
      ground_truth: {
        entity: entityContext,
        // Session appearances give narrative context without raw slot data
        session_appearances: relatedSessions.map(s => ({
          session_id: s.id,
          summary:    s.narrative?.summary || null,
          tone:       s.narrative?.tone    || null,
        })),
      },
      narrative_beats: [],
      human_guidance:  humanGuidance || null,
      cascade_context: [],
    };

    const userPrompt =
      `Generate flavor_text for ${entityType} ${entity.id} (${entity.name}).\n\n` +
      JSON.stringify(payload, null, 2);

    let responded = false;

    const result = await _callGemini({
      systemPrompt: NARRATIVE_SYSTEM_PROMPT,
      userPrompt,
      onLoading: loading => { if (loading || !responded) onLoading?.(loading); },
      onResult: raw => {
        responded = true;
        try   { onResult(_parseNarrativeResponse(raw)); }
        catch (e) { onError(e); }
      },
      onError: e => { responded = true; onError(e); },
    });

    if (result === null && !responded) {
      onLoading?.(false);
      onResult(_demoEntityFlavor(entity.id, entity.name, entityType));
    }
  }

  /**
   * generateEdgeProse({ relationship, fromEntity, toEntity, relatedSessions, onResult, onError, onLoading })
   *
   * Generates 2-sentence edge prose describing the relationship between two entities.
   * Output is stored in entity_relationships[].narrative.edge_prose by the caller
   * after calling writeNarrativeField().
   *
   * relationship:    raw entity_relationships[] entry from magers-campaign.json
   * fromEntity:      raw entity object (NPC, location, or party member lookup)
   * toEntity:        raw entity object
   * relatedSessions: sessions where both entities appeared, for context
   *
   * Returns a demo response via onResult if geminiApiKey is not configured.
   */
  async function generateEdgeProse({
    relationship, fromEntity, toEntity, relatedSessions = [],
    onResult, onError, onLoading,
  }) {
    // Normalise field names: schema uses source_id/target_id; fall back to from_id/to_id
    const fromId   = relationship.source_id    || relationship.from_id;
    const toId     = relationship.target_id    || relationship.to_id;
    const fromName = fromEntity?.name || fromId;
    const toName   = toEntity?.name   || toId;

    const payload = {
      ground_truth: {
        relationship: {
          id:                  relationship.id,
          from_id:             fromId,
          from_name:           fromName,
          to_id:               toId,
          to_name:             toName,
          relationship_type:   relationship.relationship_type,
          established_session: relationship.session_id || relationship.established_session,
          notes:               relationship.notes || null,
        },
        session_appearances: relatedSessions.map(s => ({
          session_id: s.id,
          summary:    s.narrative?.summary || null,
        })),
      },
      narrative_beats: [],
      human_guidance:  null,
      cascade_context: [],
    };

    const userPrompt =
      `Generate edge_prose for relationship ${relationship.id} ` +
      `between ${fromName} and ${toName}.\n\n` +
      JSON.stringify(payload, null, 2);

    let responded = false;

    const result = await _callGemini({
      systemPrompt: NARRATIVE_SYSTEM_PROMPT,
      userPrompt,
      onLoading: loading => { if (loading || !responded) onLoading?.(loading); },
      onResult: raw => {
        responded = true;
        try   { onResult(_parseNarrativeResponse(raw)); }
        catch (e) { onError(e); }
      },
      onError: e => { responded = true; onError(e); },
    });

    if (result === null && !responded) {
      onLoading?.(false);
      onResult(_demoEdgeProse(relationship.id, fromName, toName));
    }
  }

  /**
   * detectCascadeCandidates(session, campaign)
   *
   * Returns entities touched by the session that are candidates for narrative generation:
   *   npcs[]          — NPCs met this session with no flavor_text yet
   *   locations[]     — Locations visited this session with no flavor_text yet
   *   relationships[] — entity_relationships[] established this session with no edge_prose yet
   *
   * Used by the narrative UI to offer cascade generation after a session entry is written.
   * flavor_text null check uses != null (catches undefined too) — the field is present on all
   * entities after issue #41, but may be absent on older test fixtures.
   *
   * @returns {{ npcs: Array, locations: Array, relationships: Array }}
   */
  function detectCascadeCandidates(session, campaign) {
    const sessionId = session.id;

    const npcs = (session.mechanics?.npcs_met || []).flatMap(id => {
      const npc = (campaign.npc_directory || []).find(n => n.id === id);
      // Skip if not found or already has flavor text
      if (!npc || npc.narrative?.flavor_text != null) return [];
      return [{ id, name: npc.name, type: 'npc' }];
    });

    const locations = (session.mechanics?.locations_visited || []).flatMap(id => {
      const loc = (campaign.locations || []).find(l => l.id === id);
      if (!loc || loc.narrative?.flavor_text != null) return [];
      return [{ id, name: loc.name, type: 'location' }];
    });

    // Relationships established this session with no edge_prose written yet
    const relationships = (campaign.entity_relationships || [])
      .filter(r =>
        (r.session_id === sessionId || r.established_session === sessionId) &&
        r.narrative?.edge_prose == null
      )
      .map(r => ({ id: r.id, type: 'relationship', relationship_type: r.relationship_type }));

    return { npcs, locations, relationships };
  }

  /**
   * auditForHallucinations(generatedText, groundTruthPayload)
   *
   * Extracts capitalised words from generated text (potential proper nouns) and
   * checks each against the entity names present in groundTruthPayload.
   * Returns an array of unmatched candidates — possible hallucinations for DM review.
   *
   * This is a DM warning tool, not a blocker. Non-empty results mean
   * "Gemini may have invented something — please review." False positives
   * are expected for common capitalised words; DM judgment is final.
   *
   * @param {string} generatedText         - The prose Gemini returned
   * @param {object} groundTruthPayload    - Object from buildGroundTruthPayload()
   * @returns {string[]} unmatched proper noun candidates
   */
  function auditForHallucinations(generatedText, groundTruthPayload) {
    if (!generatedText || typeof generatedText !== 'string') return [];

    // Collect all known names from the payload
    const knownNames = new Set();

    // Party names and nicknames are always known regardless of session data
    PARTY_ROSTER.forEach(p => { knownNames.add(p.name); knownNames.add(p.nickname); });

    const gt = groundTruthPayload.ground_truth || {};
    (gt.npcs_present      || []).forEach(n => n.name  && knownNames.add(n.name));
    (gt.locations_visited || []).forEach(l => l.name  && knownNames.add(l.name));
    (gt.combats           || []).forEach(c => c.name  && knownNames.add(c.name));
    (gt.items_acquired    || []).forEach(i => i.name  && knownNames.add(i.name));
    (groundTruthPayload.cascade_context || []).forEach(e => e.name && knownNames.add(e.name));

    // Extract mid-sentence capitalised words (skip index 0 of each sentence —
    // sentence-start capitals are grammatically expected and not suspicious).
    const candidates = new Set();
    const sentences  = generatedText.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      for (let i = 1; i < words.length; i++) {
        const word = words[i].replace(/[^A-Za-z'-]/g, '');
        if (word.length > 2 && /^[A-Z]/.test(word)) {
          candidates.add(word);
        }
      }
    }

    // Return candidates not matched to any known name (substring check both ways)
    return [...candidates].filter(candidate => {
      const lower = candidate.toLowerCase();
      for (const known of knownNames) {
        if (known.toLowerCase().includes(lower) || lower.includes(known.toLowerCase())) {
          return false; // matched
        }
      }
      return true; // unmatched — flag for DM review
    });
  }

  /**
   * writeNarrativeField(campaignObj, targetId, targetType, fieldName, value)
   *
   * The only permitted write function in this module. Updates a narrative field
   * in-memory on campaignObj. Does NOT write to Drive or the repo JSON file —
   * the caller is responsible for persisting the updated campaignObj via Delta Review.
   *
   * Throws a descriptive Error if fieldName is not in APPROVED_FIELDS. This is the
   * hard wall that prevents generated prose from overwriting factual campaign data
   * (NPC names, session summaries, quest facts, etc.).
   *
   * targetType values and where the write lands:
   *   'session'        — session_logs[] by id; writes to session.narrative[fieldName]
   *   'npc'            — npc_directory[] by id; writes to npc.narrative[fieldName]
   *   'location'       — locations[] by id; writes to location.narrative[fieldName]
   *   'relationship'   — entity_relationships[] by id; writes to rel.narrative[fieldName]
   *   'quest_progress' — targetId must be 'qst_XXX|session_YYY'; only 'progress_narrative'
   *                      is writable via this path; written directly on progress_log entry
   *                      (not inside a narrative sub-object, per the schema)
   *
   * @param {object} campaignObj  - Live campaign JSON object (mutated in place)
   * @param {string} targetId     - Entity ID, or 'qst_XXX|session_YYY' for quest_progress
   * @param {string} targetType   - One of the five type strings above
   * @param {string} fieldName    - Must be in APPROVED_FIELDS or this throws
   * @param {*}      value        - Value to write
   */
  function writeNarrativeField(campaignObj, targetId, targetType, fieldName, value) {
    if (!APPROVED_FIELDS.has(fieldName)) {
      throw new Error(
        `writeNarrativeField: "${fieldName}" is not an approved narrative field and ` +
        `cannot be written by this module. Approved fields: ${[...APPROVED_FIELDS].join(', ')}`
      );
    }

    if (targetType === 'session') {
      const session = (campaignObj.session_logs || []).find(s => s.id === targetId);
      if (!session) throw new Error(`writeNarrativeField: session "${targetId}" not found`);
      if (!session.narrative) session.narrative = {};
      session.narrative[fieldName] = value;
      return;
    }

    if (targetType === 'npc') {
      const npc = (campaignObj.npc_directory || []).find(n => n.id === targetId);
      if (!npc) throw new Error(`writeNarrativeField: npc "${targetId}" not found`);
      if (!npc.narrative) npc.narrative = {};
      npc.narrative[fieldName] = value;
      return;
    }

    if (targetType === 'location') {
      const loc = (campaignObj.locations || []).find(l => l.id === targetId);
      if (!loc) throw new Error(`writeNarrativeField: location "${targetId}" not found`);
      if (!loc.narrative) loc.narrative = {};
      loc.narrative[fieldName] = value;
      return;
    }

    if (targetType === 'relationship') {
      const rel = (campaignObj.entity_relationships || []).find(r => r.id === targetId);
      if (!rel) throw new Error(`writeNarrativeField: relationship "${targetId}" not found`);
      if (!rel.narrative) rel.narrative = {};
      rel.narrative[fieldName] = value;
      return;
    }

    if (targetType === 'quest_progress') {
      // targetId format: 'qst_XXX|session_YYY' — pipe separator to uniquely address
      // the progress_log entry for a specific quest + session combination.
      // Only progress_narrative is writable via this path — it is a flat field on
      // the progress_log entry, not in a narrative sub-object (per schema, issue #41).
      if (fieldName !== 'progress_narrative') {
        throw new Error(
          `writeNarrativeField: only "progress_narrative" is writable on quest_progress entries, ` +
          `got "${fieldName}". Use targetType "quest" to write to the quest's narrative sub-object.`
        );
      }
      const [questId, sessionId] = targetId.split('|');
      if (!questId || !sessionId) {
        throw new Error(
          `writeNarrativeField: quest_progress targetId must be "qst_XXX|session_YYY", got "${targetId}"`
        );
      }
      const quest = (campaignObj.quest_ledger || []).find(q => q.id === questId);
      if (!quest) throw new Error(`writeNarrativeField: quest "${questId}" not found`);
      const entry = (quest.mechanics?.progress_log || []).find(p => p.session_id === sessionId);
      if (!entry) {
        throw new Error(
          `writeNarrativeField: no progress_log entry for session "${sessionId}" in quest "${questId}"`
        );
      }
      entry.progress_narrative = value;
      return;
    }

    throw new Error(
      `writeNarrativeField: unknown targetType "${targetType}". ` +
      `Valid types: session, npc, location, relationship, quest_progress`
    );
  }


  // ═════════════════════════════════════════════════════════
  // DEMO / FALLBACK RESPONSES
  // Returned when geminiApiKey is absent or empty.
  // Lets the UI remain testable without a live API key.
  // All include a generation_warning identifying them as demo output.
  // ═════════════════════════════════════════════════════════

  function _demoSessionNarrative(sessionId) {
    return {
      type: 'chronicle_entry',
      target_id: sessionId || 'session_001',
      text: [
        'The road to Bagyers Farm ran through a silence that did not belong to the countryside. ' +
        'Atticus felt it first — a wrongness in the roots, a held breath in the trees. ' +
        'By the time the farm came into view, the sky above the eastern field had already changed.',

        'Ched moved faster than any of them had seen him move in years. ' +
        'He did not explain. He did not have to. ' +
        'The thing rising from the furrows was not natural, and the halfling had seen its like before.',

        'The Pylon did not fall quietly. Neither did Ched.',
      ].join('\n\n'),
      generation_warnings: ['[DEMO MODE — geminiApiKey not configured in shared/config.js]'],
    };
  }

  function _demoEntityFlavor(entityId, entityName, entityType) {
    const texts = {
      npc: `${entityName || 'This figure'} moves through every room like they've already sized up the exits. ` +
           `There is a patience to them that reads as calm until the moment it doesn't. ` +
           `Whatever they carry from their past, they carry it quietly.`,
      location: `${entityName || 'This place'} has a specific quality of stillness — the kind that comes not from peace but from absence. ` +
                `The air settles differently here. ` +
                `Something happened, and the land remembers it even when the people do not.`,
    };
    return {
      type:      'flavor_text',
      target_id: entityId || 'unknown',
      text:      texts[entityType] || texts.npc,
      generation_warnings: ['[DEMO MODE — geminiApiKey not configured in shared/config.js]'],
    };
  }

  function _demoEdgeProse(relationshipId, fromName, toName) {
    return {
      type:      'edge_prose',
      target_id: relationshipId || 'rel_001',
      text: `${fromName || 'One'} does not speak of ${toName || 'the other'} directly, ` +
            `but the silence when that name comes up says enough. ` +
            `${toName || 'The other'} has never offered an explanation, and has not been asked for one.`,
      generation_warnings: ['[DEMO MODE — geminiApiKey not configured in shared/config.js]'],
    };
  }

  function _demoProgressNarrative(questId) {
    return {
      type:      'progress_narrative',
      target_id: questId || 'qst_001',
      text:      'The thread was thin and the direction uncertain, but it was more than they had the day before.',
      generation_warnings: ['[DEMO MODE — geminiApiKey not configured in shared/config.js]'],
    };
  }


  // ─────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────
  return {
    // Core
    buildGroundTruthPayload,

    // Generation
    generateSessionNarrative,
    generateEntityFlavor,
    generateEdgeProse,

    // Utilities
    detectCascadeCandidates,
    auditForHallucinations,
    writeNarrativeField,

    // Demo fallbacks — exposed so pages can use them in test mode
    _demoSessionNarrative,
    _demoEntityFlavor,
    _demoEdgeProse,
    _demoProgressNarrative,

    // Constants — exposed for pages that embed them in prompts or display them
    NARRATIVE_SYSTEM_PROMPT,
    APPROVED_FIELDS,
  };

})();
