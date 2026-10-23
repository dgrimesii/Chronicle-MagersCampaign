# Chronicle — Magers Campaign

## What this is

Chronicle is a DM tool and campaign log manager for the Magers D&D 5e campaign, run by John Magers. It provides an admin interface for the DM to record sessions, fill combat round data using AI, review deltas before publishing, and manage Drive backups — and a separate read-only player view for sharing progress with the party. It is a vanilla HTML/CSS/JS web app hosted on GitHub Pages with no framework and no build step. Campaign data is served from the repo as a plain JSON file. The Google Drive proxy is used only for writes (publish and backup).

---

## Repository structure

```
Chronicle-MagersCampaign/
├── index.html                  # Landing page — two buttons: Enter Chronicle → player/, Admin Access → admin/log-viewer.html
├── images/
│   └── Netherees-Background.jpg  # Background image used by index.html
├── player/
│   └── index.html              # Player-facing campaign log — fetches ../data/magers-campaign.json at init
├── admin/
│   ├── index.html              # Redirect to log-viewer.html
│   ├── log-viewer.html         # Campaign log (admin view) — fetches ../data/magers-campaign.json at init
│   ├── intake.html             # Session intake / photo OCR pipeline — uses ChronicleAI
│   ├── glossary.html           # OCR hints glossary — hardcoded glossary data, no JSON fetch
│   ├── delta-review.html       # Post-session delta review and Drive publish — uses ChronicleAI
│   ├── integrity.html          # Combat round integrity checker / gap filler — uses ChronicleAI
│   ├── log-editor.html         # In-browser campaign data editor — edits in memory only
│   ├── versions.html           # Version manager / Drive backup ledger
│   └── drive-test.html         # Drive proxy diagnostics (write path only) — no nav bar
├── shared/
│   ├── config.js               # GITIGNORED — Drive proxy URL, campaign file ID, Anthropic and Gemini API keys
│   ├── chronicle-store.js      # Storage module — every campaign read and write goes through window.ChronicleStore
│   ├── chronicle-ids.js        # Opaque UUID ids and legacy-ID translation (#95) — exports window.ChronicleIds; also require()-able in Node
│   ├── chronicle-publish.js    # Publish logic (#92) — applies approved review items, writes the 5.0.0 shapes; exports window.ChroniclePublish; also require()-able in Node
│   ├── chronicle-ai.js         # Shared Anthropic API module — exports window.ChronicleAI
│   ├── chronicle-integrity.js  # Shared gap-detection module — exports window.ChronicleIntegrity
│   └── chronicle-narrative.js  # Shared Gemini narrative module — exports window.ChronicleNarrative
├── data/
│   ├── magers-campaign.json    # Campaign data — single source of truth, schema version 5.0.0
│   └── pc-abilities.json       # Per-PC ability/spell/action lists harvested from D&D Beyond; used by intake.html OCR prompt enrichment (issue #80). Regenerate with: node scripts/harvest-characters.js
├── scripts/
│   ├── build.js                # STALE — injected EMBEDDED_DATA into HTML files; markers removed in Phase 1, script is now dead code
│   ├── harvest-characters.js  # Fetches all 6 PC character sheets from D&D Beyond, extracts key ability/spell names, writes data/pc-abilities.json. Run manually after sessions where characters level up.
│   ├── migrate-turn-schema.js # Converts combat rounds from 4.x slots to the 5.0.0 turn schema (issue #93). Dry run by default; --write rewrites the file. Idempotent; prints before/after counts and the inconsistencies it found.
│   └── migrate-opaque-ids.js  # Gives every entity a UUID id and keeps its typed ID as legacy_id (issue #95). Dry run by default; --write rewrites; --check only checks that every reference resolves. Idempotent.
├── notes/
│   └── phase1-claude-code-prompt.md  # Historical prompt used to migrate data reads from Drive to repo fetch
├── docs/
│   ├── chronicle-issue-prompt.md     # Reusable five-phase prompt template for completing GitHub issues
│   ├── intake-flow.md                # Mermaid flowchart of the current session intake → Delta Review → publish → repo sync flow, with known blockers marked
│   └── intake-redesign.md            # Design document for the intake rebuild: identity-first five-step flow, turn schema, decisions and build order
├── tests/
│   ├── run-all.js                    # Test runner — runs all test files, reports pass/fail summary
│   ├── integrity.test.js             # Tests for shared/chronicle-integrity.js
│   ├── intake-image.test.js          # Group A — OCR round-data shape validation
│   ├── intake-preparation.test.js    # Group C — session data preparation checks
│   ├── delta-schema.test.js          # Group E — delta item schema validation
│   ├── delta-apply.test.js           # Tests for shared/chronicle-publish.js (publish), incl. the #92 gate run through both viewers
│   ├── store.test.js                 # Tests for shared/chronicle-store.js — paths, Drive calls, Safe Test Mode
│   ├── turn-schema.test.js           # Tests for the 5.0.0 turn schema: migration rules, converted data, both viewers' normalisers
│   ├── bestiary-fold.test.js         # Tests for the Goblin Slinger fold (#94): no mon_006, roster roles, both viewers' bestiary
│   ├── opaque-ids.test.js            # Tests for opaque ids (#95): chronicle-ids.js, the reference check (gate), migrated data, both viewers
│   ├── fixtures/
│   │   └── test-campaign.json        # Minimal v5.0.0 synthetic campaign for automated tests
│   ├── ocr-ground-truth/             # Ground-truth image+JSON pairs for OCR accuracy testing
│   └── ai-input-fixtures/            # Captured AI response fixtures for offline test runs
├── .gitignore                  # Ignores shared/config.js
├── CLAUDE.md                   # Behavioural instructions for Claude Code
└── README.md                   # This file
```

---

## Data architecture

```
STORAGE     → shared/chronicle-store.js  (window.ChronicleStore — the only code that reads or writes campaign data)
DATA READS  → /data/magers-campaign.json  (same-origin fetch, served by GitHub Pages)
DATA WRITES → Google Drive via Apps Script proxy  (delta-review publish, backups)
APP HOSTING → GitHub Pages  (Chronicle-MagersCampaign repo)
```

Campaign data lives in `data/magers-campaign.json`. Every page that needs it calls `ChronicleStore.loadCampaign()`, which fetches this file same-origin (no proxy, no CORS) or, in Safe Test Mode, the test fixture. No page calls `fetch()` on the campaign file or talks to the Drive proxy itself; the one exception is `admin/drive-test.html`, which exists to test the proxy directly. Updating the JSON and pushing to GitHub triggers an automatic Pages redeploy; every page picks up the new data on next load.

**Identifiers (issue #95).** Every entity `id` is a UUID v4, allocated by `ChronicleIds.newId()` in `shared/chronicle-ids.js`, never counted. The old typed ID (`pc_001`, `npc_014`, `cbt_005`, `session_005`) is kept on the entity as `legacy_id` and is frozen. Intake, the AI prompts and the DM still name entities by legacy ID, so anything that accepts an ID from outside the data translates it: Delta Review translates its staged queue when the campaign loads and again at publish, and the viewers accept a legacy ID in `selectEntity()`. Run `node scripts/migrate-opaque-ids.js data/magers-campaign.json --check` after any hand edit to confirm every reference still resolves.

**Publish (issue #92).** What a publish writes is decided by `ChroniclePublish.applySession()` in `shared/chronicle-publish.js`; Delta Review's `applyDeltasToCampaign()` is a thin wrapper that passes it the page's state, and the tests require the same file. It writes combat rounds in the 5.0.0 turn schema (turning the AI's one-entry-per-roll proposals into activities and outcomes, with targets resolved to ids and the round's session as `sid`), fills a placeholder session such as `session_006` instead of appending a second one, merges a round that continues across two pages, and recomputes the derived fields: each combat's `sessions` and `total_rounds_logged`, each session's `combats`, `locations_visited` and `npcs_met`, each location's `sessions_visited` and `combat_history`, and each bestiary entry's `combat_appearances`. Derived values are added, never removed, because some of today's hand-entered values (an NPC met outside combat) are not yet recorded anywhere the computation can see. Each publish returns notes on decisions it made for the DM (a weapon recorded as Attack, a placeholder's recorded date kept); the page logs them to the console and counts them in the status line.

The store module exists so the planned storage moves change only one file: rebuild phase 2 makes publish commit to the repo instead of Drive (#97), and phase 7 replaces the repo and Drive with an API backed by Postgres (see `docs/intake-redesign.md`, "Build order").

Drive proxy is used (through `ChronicleStore`) for:
- Writing updated JSON to Drive after a Delta Review publish
- Creating named Drive backups before sessions
- Listing Drive backups in the Versions page

**Intake → Delta Review hand-off via sessionStorage:**  
When the DM clicks "Send to Delta Review" in `intake.html`, the page writes a `chronicle_intake_delta` envelope to `sessionStorage` and navigates to `delta-review.html`. Delta Review reads but does **not** clear this key on load (`loadIntakeDelta()`). The key persists in sessionStorage until `publish()` removes it after a successful Drive write, so the DM can navigate away from Delta Review and return without losing the queue. A companion flag (`chronicle_intake_delta_loaded`) is set after the first successful parse; on return visits it triggers a "Queue restored from previous session" banner that auto-dismisses after 5 seconds. If no key is present (direct navigation or post-publish reload), Delta Review starts with an empty queue as before.

`chronicle_intake_delta` envelope shape:
```json
{
  "source": "intake",
  "timestamp": "ISO-8601",
  "sessionId": "session_006",
  "pageCount": 3,
  "hasNarrative": true,
  "items": [
    { "id": "intake_session", "type": "NEW", "array": "session_logs", "group": "Session", ... },
    { "id": "intake_page_0", "type": "RAW", "array": "session_logs", "group": "Session", ... },
    { "id": "intake_narrative", "type": "NEW", "array": "session_logs", "group": "Session", ... }
  ]
}
```

`RAW` items carry confirmed OCR text as `rawData.ocr_text`. They are not interpreted as combat round data — `buildIncomingFromItems()` filters them out (requires `combatId && roundNumber != null`), so they produce zero integrity gaps, and `applyDeltasToCampaign()` has no RAW handler so approving a RAW item on publish writes nothing to the campaign JSON. `nlRender()` on a RAW item displays the raw OCR text in a pre-formatted block plus an **Interpret** button. Clicking Interpret opens a combat-selector form; selecting a combat and clicking "Run Interpret" sends the OCR text to the AI via `ChronicleAI.fillRoundsFromText()`, which returns round proposals that are converted into ROUND-type delta items and added to `cascadeItems[]`. The DM then reviews and approves those ROUND items normally. The source RAW item is marked `'interpreted'` (teal dot, dimmed) once the AI call completes.

`scripts/build.js` still exists in the repository but is dead code. It was written to inject `EMBEDDED_DATA` blocks into `admin/log-viewer.html` and `player/index.html` — a pattern that was replaced in Phase 1 when both files were migrated to runtime fetch. The HTML files no longer contain the `EMBEDDED_DATA` markers the script looks for, so running it produces "SKIP (markers not found)" warnings and modifies nothing.

---

## Updating campaign data

To update the campaign after a session:

1. Edit `data/magers-campaign.json` directly
2. Update `meta.last_updated` to today's date
3. Commit and push to `main` — GitHub Pages redeploys automatically

No build script is required. Both the player view and admin log-viewer read the same JSON file; one commit updates both.

The post-session workflow via the admin tools:
1. **Session Intake** (`admin/intake.html`) — upload session photos; AI extracts combat round data
2. **Delta Review** (`admin/delta-review.html`) — review AI-proposed changes, approve, then Publish to Drive
3. Download the updated JSON from Drive
4. Replace `data/magers-campaign.json` in the repo
5. Commit and push

Phase 2 goal (not yet implemented): Publish commits directly to the repo via the GitHub Contents API, eliminating the manual download-and-replace step.

---

## Schema

File: `data/magers-campaign.json`  
Schema version: `5.0.0` (stored as `_schema_version` at root). The change from 4.1.0 to 5.0.0 was approved by the DM on issue #93.

v4 introduced a `mechanics`/`narrative` two-layer pattern on every entity type. Mechanical facts (queryable, structured) live in `mechanics`; prose for human readers lives in `narrative`. v5.0.0 keeps that pattern and replaces each combat slot's fixed action fields with the turn schema below (activities tagged by action economy, each with outcomes). The `normaliseCampaignJson` function translates both into the flat shape the renderers already expect. The file's own `_field_type_reference` (`slot_fields`, `enemy_turn_fields`, `common_optional_fields`) documents every field.

### Top-level sections

| Key | Contents |
|---|---|
| `_schema_version` | Schema version string (root level) |
| `party` | Six player characters (pc_001–pc_006) |
| `session_logs` | One entry per session; summary/tone in `narrative`, mechanics in `mechanics` |
| `character_moments` | Significant character moments; character_ids/refs in `mechanics`, prose in `narrative` |
| `npc_directory` | Named NPCs; disposition in `mechanics`, description in `narrative` |
| `bestiary` | Monster entries; reliability/appearances in `mechanics`, description in `narrative` |
| `world_lore` | Lore entries; reliability in `mechanics`, content prose in `narrative` |
| `inventory_and_loot` | Items; item_type/holder/found_session/is_quest_relevant in `mechanics`, description in `narrative` |
| `locations` | Named locations; visibility in `mechanics`, description in `narrative` |
| `quest_ledger` | Quests; status/priority/objectives/progress_log in `mechanics`, motivation in `narrative` |
| `combat_encounters` | Combats; outcome/location/sessions/`enemies_roster` in `mechanics`, setup/finale/aftermath in `narrative`; each round's party `slots[]` and `enemy_turns[]` hold `activities[]` with `outcomes[]` (see Turn schema below) |
| `deferred_gaps` | Workflow state array written by delta-review when the DM defers an integrity gap. Each entry: `{ id, combat_id, combat_name, session_id, missing_rounds[], gap_type, deferred_at, status }`. Not campaign narrative — persists alongside the JSON so the future campaign scanner can surface pending entries as a correction queue. |
| `prompt_improvement_log` | Workflow state array written by delta-review publish when the DM logged steering context during an OCR re-run in Session Intake. Each entry: `{ id, session_id, page_index, steering_text, failure_summary, corrected, logged_at, status }`. IDs use `pil_NNN` prefix. `status` starts as `'pending_review'`. Not campaign narrative — captures OCR prompt failure cases for future prompt improvement review (placeholder UI in `integrity.html`). |
| `entity_relationships` | Root-level array for explicit relationship records between any two entities (PCs, NPCs, locations, quests, etc.). Each entry: `{ id, source_id, target_id, relationship_type, session_id, notes }`. Starts empty; populated by future admin tooling. `relationship_type` uses a controlled vocabulary: `combat_antagonist`, `allied`, `quest_connection`, `location_inhabitant`, `social_contact`, `witnessed`, `unknown`. IDs use `rel_NNN` prefix. |
| `factions` | Root-level array for organized groups with campaign significance (named leadership, ongoing role, deep lore potential). Distinct from `npc_directory[]` (named individuals). Each entry: `{ id, name, mechanics: { status, alignment, home_location, known_members[], origin_session }, narrative: { description, motivation, flavor_text, flavor_text_version, regeneration_flagged } }`. Starts empty. IDs use `fac_NNN` prefix. `fac_NNN` IDs are valid `source_id`/`target_id` values in `entity_relationships[]`. Introduced in schema v4.1. |
| `cohorts` | Root-level array for anonymous recurring groups scoped to a bounded story period (e.g. `lake_town_region_goblinoids`). Third tier of the entity model — below factions (no campaign-level permanence) and distinct from NPCs (no individual identity). Each entry: `{ id, name, mechanics: { status, home_location, associated_quests[], associated_sessions[], bestiary_entries[], promoted_to, origin_session }, narrative: { description } }`. `status` is one of `active`, `resolved`, `promoted`. `promoted_to` links to a `fac_NNN` when elevated. Starts empty. IDs use `coh_NNN` prefix. **Admin-only — not exposed in player view.** Introduced in schema v4.1. |

### Field name mappings (v4 JSON → normalised viewer shape)

The `normaliseCampaignJson` function (identical copies in `admin/log-viewer.html` and `player/index.html`) translates v4 paths at runtime. The renderers consume the normalised shape and are not aware of the v4 sub-object structure.

| v4 JSON path | Viewer field | Notes |
|---|---|---|
| every entity's `legacy_id` → `id` | `legacy_ids` (object) | #95: map of legacy ID → UUID over every top-level entity array. The page uses it to re-key the hardcoded `RELS` and `PARTY_LOOKUP` maps at load (`relinkLegacyMaps()`), to open an entity from a legacy ID in `selectEntity()`, and to add each `legacy_id` to the search text |
| `session_logs[].id` | `sessions[].id` | was `session_id` in v3; a UUID since #95 |
| `session_logs[].legacy_id` | `sessions[].legacy_id` | #95: the session's `session_NNN`. Session references (round tag, quest progress log, item "Found") show it through `sessionLabel()`, so they read as before |
| `party[].legacy_id` | `party[].legacy_id` | #95: the old `pc_NNN` |
| `session_logs[].date` | `sessions[].date` | was `session_date` in v3 |
| `session_logs[].narrative.summary` | `sessions[].summary` | was root-level in v3 |
| `session_logs[].narrative.tone` | `sessions[].narrative_vibe` | was root-level in v3 |
| `session_logs[].narrative.key_moments[].description` | `sessions[].key_moments[]` (string) | v4 moments are objects; normaliser flattens to string array |
| `session_logs[].narrative.chronicle_entry` | `sessions[].chronicle_entry` | Gemini-generated prose entry; null until generated |
| `session_logs[].narrative.chronicle_entry_generated_at` | `sessions[].chronicle_entry_generated_at` | ISO-8601 timestamp of last generation; null until generated |
| `session_logs[].narrative.chronicle_entry_model` | `sessions[].chronicle_entry_model` | Model ID used for last generation; null until generated |
| `session_logs[].narrative.chronicle_entry_version` | `sessions[].chronicle_entry_version` | Generation counter; increments on each regeneration |
| `session_logs[].narrative.narrative_beats` | `sessions[].narrative_beats` | DM-tagged key beats fed to Gemini as generation anchors |
| `session_logs[].narrative.human_guidance` | `sessions[].human_guidance` | Free-text DM steering notes for Gemini; null if not set |
| `session_logs[].narrative.generation_warnings` | `sessions[].generation_warnings` | Warnings from last Gemini call (hallucination flags, etc.) |
| `party[].mechanics.class` | `party[].cls` | was `p.class` in v3 |
| `party[].mechanics.level` | `party[].level` | was `p.current_level` in v3 |
| `party[].campaign_notes` | `party[].notes` | was `p.notes` in v3 |
| `npc_directory[].mechanics.disposition` | `npcs[].disposition` | was root-level in v3 |
| `npc_directory[].narrative.description` | `npcs[].description` | was root-level in v3 |
| `locations[].mechanics.visibility` | `locations[].visibility` | was root-level in v3 |
| `locations[].narrative.description` | `locations[].description` | was root-level in v3 |
| `quest_ledger[].mechanics.status/priority/category` | `quests[].status/priority/category` | was root-level in v3 |
| `quest_ledger[].narrative.motivation` | `quests[].motivation` | was `narrative_motivation` root-level in v3 |
| `quest_ledger[].mechanics.objectives[].description` | `quests[].objectives[].desc` | was `o.desc` in v3 |
| `quest_ledger[].mechanics.objectives[].is_completed` | `quests[].objectives[].done` | was `o.done` in v3 |
| `quest_ledger[].mechanics.progress_log[].fact` | `quests[].progress[].e` | was `.entry` in v3 |
| `quest_ledger[].mechanics.progress_log[].progress_narrative` | `quests[].progress[].progress_narrative` | Gemini-generated narrative for this progress entry; null until generated |
| `quest_ledger[].mechanics.origin_session` | `quests[].origin` | was root-level in v3 |
| `inventory_and_loot[].mechanics.item_type` | `items[].type` | was root-level `type` in v3 |
| `inventory_and_loot[].mechanics.current_holder` | `items[].holder` | was `current_holder_id` in v3 |
| `inventory_and_loot[].mechanics.found_session` | `items[].session` | was `session_found` in v3 |
| `inventory_and_loot[].mechanics.is_quest_relevant` | `items[].quest` (boolean) | was `is_quest_item` in v3 |
| `combat_encounters[].mechanics.outcome` | `combats[].outcome` | was root-level in v3 |
| `combat_encounters[].mechanics.location` | `combats[].location` | was `location_id` in v3 |
| `combat_encounters[].mechanics.sessions` | `combats[].sessions` | was root-level in v3 |
| `combat_encounters[].mechanics.total_rounds_logged` | `combats[].totalRounds` | was root-level in v3 |
| `combat_encounters[].narrative.setup` | `combats[].narrativeContext` | was root-level in v3 |
| `combat_encounters[].narrative.finale` | `combats[].finale` | was root-level in v3 |
| `combat_encounters[].narrative.aftermath` | `combats[].aftermath` | was root-level in v3 |
| `rounds[].slots[].activities[]` | `rounds[].slots[].act` | 5.0.0: every activity as one label, joined with ` / ` (`activityLabel()`): the action bare, others prefixed `BA:`, `R:`, `Move:`, `Free:`, `Legendary:`. Attack and Magic show their `detail` (weapon or spell); other names show `name · detail`. `—` when the slot has no activities |
| `rounds[].slots[].activities[economy=action].outcomes[0].res` | `rounds[].slots[].res` | 5.0.0: the action activity's result when it has exactly one outcome, else null (no badge), as 4.x did for `attacks[]`. Falls back to the first activity when there is no action |
| `rounds[].slots[].activities[economy=action].outcomes[0].val` | `rounds[].slots[].val` | Same rule as `res` |
| `rounds[].slots[].notes` + outcome `effect` | `rounds[].slots[].notes` | Slot notes, else the action activity's `notes`, followed by one "`<target> <effect>`" line per outcome effect (e.g. `Ogre killed`), joined with `; ` (`effectLines()`). Since #95 the target is named by `targetLabel()`: a party member's nickname, another entity's name, or a roster label as written (`Del downed`, not the UUID) |
| `rounds[].enemy_turns[]` | `rounds[].enemy[{desc, impact}]` | 5.0.0: `desc` = `actor_id: ` + every activity's label, each with ` (res, val)` when it has one outcome, joined with `; `. `impact` = one "`<target> <effect>`" line per outcome effect (`Del downed`; the target named by `targetLabel()`, #95), then the `special_events[].description`s not matched to a roll, joined with `; ` |
| `world_lore[].narrative.content` | `lore[].content` | was root-level in v3 |
| `world_lore[].mechanics.reliability` | `lore[].reliability` | was root-level in v3 |
| `bestiary[].mechanics.reliability` | `bestiary[].reliability` | was root-level in v3 |
| `bestiary[].narrative.description` | `bestiary[].content` | Shown as "Knowledge" in the detail panel (#94) |
| `bestiary[].mechanics.observed_abilities[]` | `bestiary[].traits[]` | One string per ability: `[role] ` (when the ability has a `role`) + `name — description`. Shown as "Observed traits" (#94) |
| every `combat_encounters[].mechanics.enemies_roster[]` group with this `mon_ref` | `bestiary[].roles[]` | Derived, not stored: the group's `actor_id`, plus ` (role)` when it has one, deduplicated. Shown as "Seen as" (#94) |
| `character_moments[].mechanics.character_ids` | `moments[].character_ids` | was root-level in v3 |
| `character_moments[].narrative.description` | `moments[].description` | was root-level in v3 |
| `character_moments[].mechanics.parent_event_id` | `moments[].parent_event_id` | was root-level in v3 |
| `character_moments[].mechanics.origin_session` | `moments[].origin_session` | was root-level in v3 |
| `npc_directory[].narrative.flavor_text` | `npcs[].narrative.flavor_text` | Gemini-generated flavor text; null until generated. Accessed via `...n` spread on the NPC object |
| `npc_directory[].narrative.flavor_text_version` | `npcs[].narrative.flavor_text_version` | Generation counter |
| `npc_directory[].narrative.regeneration_flagged` | `npcs[].narrative.regeneration_flagged` | Boolean — DM has flagged this entry for regeneration |
| `locations[].narrative.flavor_text` | `locations[].narrative.flavor_text` | Gemini-generated flavor text; null until generated. Accessed via `...l` spread on the location object |
| `locations[].narrative.flavor_text_version` | `locations[].narrative.flavor_text_version` | Generation counter |
| `locations[].narrative.regeneration_flagged` | `locations[].narrative.regeneration_flagged` | Boolean — DM has flagged this entry for regeneration |
| `entity_relationships` | `entity_relationships` | Pass-through; empty array until populated |
| `factions` | `factions` | Pass-through; empty array until populated. Each faction carries `mechanics` (status, alignment, home_location, known_members[], origin_session) and `narrative` (description, motivation, flavor_text, flavor_text_version, regeneration_flagged). IDs use `fac_NNN` prefix. Introduced in schema v4.1. |
| `cohorts` | `cohorts` | Pass-through in `admin/log-viewer.html` only — **absent from `player/index.html`** (cohorts are admin-only). Each cohort carries `mechanics` (status, home_location, associated_quests[], associated_sessions[], bestiary_entries[], promoted_to, origin_session) and `narrative` (description). IDs use `coh_NNN` prefix. Introduced in schema v4.1. |

### Combat viewer format (compact slots)

```
rounds[n].slots[{ s, a, act, res, val?, notes? }]
rounds[n].enemy[{ desc, impact? }]
```

`s` = slot number (1–6), `a` = actor_id, `act` = every activity's label (see the mappings above), `res` = result (hit/miss/crit/save/success/failure/neutral/unclear; death saves use success/failure and keep the hit/miss colours), `val` = damage or value, `notes` = optional string.

The normalisers read only 5.0.0 turns. The 4.x compatibility shim (`slot.action`, `et.action`) was removed by #92, once publish wrote `activities[]` and no 4.x rounds remained in `data/`. A slot or enemy turn with no `activities` list shows as an empty turn (`—`, or the group name alone) rather than breaking the page.

### Turn schema (5.0.0)

Introduced by issue #93 (design: `docs/intake-redesign.md`, "What a turn holds"). A turn records what the entity's action economy was spent on:

```json
{ "s": 6, "a": "pc_005",
  "activities": [
    { "economy": "action", "name": "Attack", "detail": "3 Melee Attacks",
      "outcomes": [ { "res": "hit", "val": null, "target_id": null }, { "res": "hit", "val": null, "target_id": null } ],
      "notes": "3 Rocks killed" }
  ],
  "notes": null }
```

| Level | Field | Values / meaning |
|---|---|---|
| Slot | `s`, `a`, `activities[]`, `notes` | Party members only. Replaces 4.x `action`, `bonus_action`, `reaction`, `movement`, `object_interaction` |
| Activity | `economy` | `action`, `bonus_action`, `reaction`, `movement`, `free`, `legendary_action`, `legendary_resistance` |
| Activity | `name` | Action economy: a standard action (Attack, Dash, Disengage, Dodge, Help, Hide, Influence, Magic, Ready, Search, Study, Utilize), `Death Save`, or `No Action` / `No Action: <reason>`. Other economies: the feature or spell (Flurry of Blows, Healing Word) |
| Activity | `outcomes[]` | One per attack roll or spell target; empty when there was no roll |
| Activity (optional) | `detail`, `val_type`, `notes`, `member` | Spell or weapon; damage/healing; annotation; named group member (goblin 3) |
| Activity (optional) | `ready_ref` | On a reaction releasing a readied action: `{ round, s }` of the Ready activity |
| Outcome | `res`, `val`, `target_id` | Always present (null when unknown). Replaces 4.x `attacks[]` entries and the action's own result. `target_id` is an ID or null: an entity's UUID id (since #95), or the `actor_id` of one of the combat's `enemies_roster` groups, because roster groups have no ids. It is never free text, and never several targets joined |
| Outcome (optional) | `target_text` | The target exactly as written when it is not an entity (`"horse"`). Only present when `target_id` is null |
| Outcome (optional) | `detail` | The attack used for this one roll (`Bite`, `Claw`). Overrides the activity's `detail`, so one Multiattack can hold a claw and a bite with separate targets. Carried from each 4.x `attacks[].name`, except labels that are not attack names ("Attack"/"attacks" restate the activity; "hits" is a result) |
| Outcome (rule) | one per attack | One outcome per attack roll, even when the target repeats: "Melee (x2)" on Malachite is two outcomes with the same `target_id` (Malachite's id, legacy `pc_002`) |
| Outcome (optional) | `effect`, `notes` | `downed` / `killed` (down is an outcome, never an activity); per-roll note such as `Nat 1` or `Bite`. A down or kill matched to its roll lives only here, not also in `special_events` |

**Enemy turns:** `{ actor_id, activities[], special_events[], notes }`. There is one turn per `enemies_roster` group per round, holding every activity of that group. Enemies have no initiative slots, so the 4.x `initiative_position` was dropped (it was null on every recorded turn). Legendary actions and resistances are activities in the boss's turn. Lair actions are their own turn with `actor_id: "lair"`.

**New optional fields (5.0.0):**
- `aliases[]` on every entity: other names the notes use for it.
- `passages[]` on any entity, combat, round, activity, quest progress entry, character moment or session. Each entry is `{ text, session_id, speaker, page }`, where `speaker` is `"dm"` or an entity ID.
- `role` on an `enemies_roster` group, to tell apart groups of the same creature (`melee`, `slinger`). The group's `count` is recorded only when known at the start of the combat.
- `target_text` on an outcome: a target that is not an entity, kept as written (`"horse"`), with `target_id` null.

`aliases` and `passages` are not populated yet; #100 to #102 add them. `role` is set on one group: `cbt_005` Goblin Slingers (`slinger`, #94). An observed ability in a bestiary entry may carry the same `role` when it was seen only in that role. `target_text` is used by the migrated data (`cbt_003` rounds 5 and 7).

**How the 42 recorded rounds converted** (`scripts/migrate-turn-schema.js`):
- **Action names:**
  - `type: spell` → `Magic` with the spell as `detail`.
  - `type: attack` → `Attack` with the weapon as `detail`.
  - `death_save` → `Death Save`, with hit/miss relabelled success/failure.
  - `other` → `No Action` (`Stable` became `No Action: Stable`).
  - `Ready: X` → `Ready` with `X` as `detail`.
  - Any other ability name is kept as written and reported.
- **Results:** a result of `neutral` (or none) with no value gives an activity with no outcomes.
- **Attack lists:** `attacks[]` entries become outcomes. Each entry's `name` becomes the outcome's `detail` (`Bite` ×4 in `cbt_004` r3, `Melee` ×2 in `cbt_005` r2), and its notes move to the outcome's `notes`. By DM ruling on #93, labels that are not attack names are left out: "Attack"/"attacks"/"Attacks" only restate the activity, and "hits" is a result already held in `res`. The unexplained "s" (12 outcomes) is kept as recorded.
- **Movement:** strings become `movement` activities.
- **Targets:**
  - A slash-joined target (`"pc_001/pc_005"`) becomes one outcome per target, each with the same `res` and `val` null.
  - A non-entity target goes to `target_text`.
  - An action-level target that only summarised its per-attack targets (`cbt_004` r3 ROUS `"party"`) is dropped and reported.
- **DM decisions on #93** (listed in the script's `EFFECT_DECISIONS` and `expandNoteTargets`):
  - `cbt_002` r4's note "Hits on Goli, Del, Mal" becomes three hit outcomes (pc_005, pc_004, pc_002).
  - `cbt_002` r13 and r15 "Melee (x2)" on Malachite each become two hit outcomes on pc_002.
  - Nine downs and kills move from `special_events` onto their outcome's `effect`: `cbt_001` r2; `cbt_002` r7, r12 and r14; `cbt_003` r7 (horse killed, pc_004 downed) and r9; `cbt_005` r2; and `cbt_005` r3 (Atti's Ice Knife targets the Ogre, killed).
  - Two stay in `special_events`: `cbt_002` r6 (held for the DM's ID check) and Del's familiar in `cbt_004` r4 (no roll to attach it to).
  - The viewers show outcome effects in the enemy row's impact, or in a party slot's notes.
- **Counts:** before and after the conversion match (280 actions, 3 bonus actions, 7 movements, 280 results counted per target, 34 enemy turns, 42 rounds). The `cbt_002` r4, r13 and r15 decisions then add 4 outcomes, so the file holds 284.
- **Re-running:** the script is safe to re-run. From the 4.1.0 file it reproduces the committed combats exactly; on the converted file it changes nothing.
- **Inconsistencies:** reported on issue #93, not fixed. Two items stay on the script's review list for the DM: the `cbt_003` r5 Axe Beaks note, and the `cbt_002` r6 ID/name mismatch.

### ID registry

Since issue #95 every entity `id` is a lowercase **UUID v4** (`3f2b8c1e-9a4d-4c7e-b1f0-6d2a9e5c4b81`), the format chosen by the DM to match Storyteller's constraint C15 (opaque, non-sequential, type-free). The type lives in the array an entity sits in, never in its id. New ids come from `ChronicleIds.newId()`; there is no "next available" ID any more.

Each entity migrated by #95 keeps its old typed ID as `legacy_id`. Legacy IDs are **frozen**: none are assigned to new entities, except that a session published after #95 keeps the `session_NNN` the DM typed at intake. The file's own `_id_registry` records the format and the voided legacy IDs.

| Entity | Legacy IDs (frozen) | Voided legacy IDs (never reuse) |
|---|---|---|
| Party | pc_001–pc_006 | — |
| NPCs | npc_001, npc_003, npc_004, npc_007–npc_014 | npc_002, npc_005, npc_006 |
| Locations | loc_001–loc_013 | — |
| Quests | qst_001–qst_005 (objectives obj_001–obj_005) | — |
| Items | item_001–item_011 | — |
| Combats | cbt_001–cbt_006 | — |
| Bestiary | mon_001–mon_005, mon_007–mon_008 | mon_006 (Goblin Slinger, folded into Goblins by #94) |
| Lore | lore_001–lore_003 | — |
| Sessions | session_001–session_007 | — |
| Character moments | moment_001–moment_003 | — |
| Factions, cohorts, relationships | (none yet) | — |

Workflow records keep typed ids: `prompt_improvement_log[]` (`pil_NNN`) and `deferred_gaps[]` (`gap_NNN`). No entity refers to them.

`scripts/migrate-opaque-ids.js` did the conversion: 77 ids (72 entities and 5 quest objectives) and 727 references, found by walking the whole file for strings that exactly equal a legacy ID. 77 prose strings that mention a legacy ID inside longer text ("Killed by pc_006 Ice Knife") were left as written.

---

## Views

### `index.html` — Landing page

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/`
- **Audience:** Anyone navigating to the root
- Displays the Chronicle title over a dimmed background image (`images/Netherees-Background.jpg`)
- Two buttons: "Enter Chronicle" → `player/`, "Admin Access" → `admin/log-viewer.html`
- No campaign data fetch

---

### `player/index.html` — Player view

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/player/`
- **Audience:** Players — read-only, shareable
- Loads the campaign at init with `ChronicleStore.loadCampaign()` (`../data/magers-campaign.json`); loads `../shared/config.js` (optional — absent on Pages) and `../shared/chronicle-store.js`
- Two views toggled by header buttons: **Browse** and **Graph**
- **Browse view:** Left sidebar with search box, category filter pills, and entity list grouped by type. Right area shows entity detail cards with relationship chips, timelines, quest progress, and full combat round tables
- **Graph view:** D3.js (v7.9, cdnjs CDN) force-directed graph of entities. Toolbar with legend, Reset View button, Focus Party button. Click a node to open a side panel with entity summary
- Header has a "⇄ Admin" button linking to `../admin/log-viewer.html`
- On load failure, shows an error status — no silent fallback

---

### `admin/log-viewer.html` — Campaign log (admin view)

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/log-viewer.html`
- **Audience:** DM only
- Loads the campaign at init with `ChronicleStore.loadCampaign()` (`../data/magers-campaign.json`)
- Loads D3.js (v7.9, cdnjs CDN), `../shared/config.js` and `../shared/chronicle-store.js`
- Identical UI structure to player view: Browse + Graph views, sidebar, entity detail cards
- 7-item admin nav bar; "⇄ Player View" button to `../player/`
- On load failure, shows an error panel with message and copy-to-clipboard option

---

### `admin/intake.html` — Session Intake

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/intake.html`
- **Audience:** DM only
- Three-step wizard: (1) upload session pages via single "Session Pages" zone (images and/or text files, mixed drops supported), (2) review OCR output page-by-page, (3) consolidate into session document. "← Back to Upload" in Step 2 returns to Step 1 with all files and generated OCR text preserved; re-running OCR only processes new unprocessed pages
- Loads `../shared/config.js` and `../shared/chronicle-ai.js`
- Uses `ChronicleAI.call()` with vision to extract handwritten combat notes from uploaded images; images are compressed to ≤1800px before sending to stay within the Anthropic 5MB base64 limit
- Loads `../shared/chronicle-store.js` and calls `ChronicleStore.loadCampaign()` once at page load via `loadCampaignContext()` (so Safe Test Mode now applies here too) to extract NPC, location, monster, and combat name lists for OCR prompt enrichment. If the fetch fails, `campaignEntities` stays null and OCR continues with the base prompt only (graceful degradation)
- Fetches `../data/pc-abilities.json` once at page load via `loadPCAbilities()` to extract per-PC action and spell lists. Generated by `scripts/harvest-characters.js` from D&D Beyond character sheets; re-run that script after characters level up. If the fetch fails, `pcAbilities` stays null and OCR continues without the abilities block (graceful degradation). Both fetches run in parallel at script init.
- **OCR review correction modes (Step 2):** three paths per page — (a) manual textarea edit, (b) re-run OCR with the same prompt, (c) re-run with steering (DM-typed context prepended to the system prompt). Steering text can be logged as a prompt improvement suggestion via sessionStorage (key `chronicle_prompt_improvement_log`)
- "Send to Delta Review" button writes a `chronicle_intake_delta` envelope to sessionStorage (containing one session stub, one RAW item per confirmed OCR page, and one narrative item if present), then navigates to `delta-review.html`. Delta Review reads and clears this key on load.

---

### `admin/glossary.html` — OCR Glossary

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/glossary.html`
- **Audience:** DM only
- Maintains a glossary of abbreviations and terms to help the AI interpret handwritten notes
- Glossary entries are hardcoded in a JavaScript array in the file — not stored in `magers-campaign.json`
- Loads `../shared/config.js` only (no AI module)
- Features: search, category filter, tier filter (tentative/confirmed), promote/demote entries, add/remove entries, copy-prompt view showing the glossary formatted for use in AI prompts
- No fetch of campaign data

---

### `admin/delta-review.html` — Delta Review

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/delta-review.html`
- **Audience:** DM only
- Reviews AI-proposed session deltas (new entities, round data, quest updates) before committing them to the campaign JSON
- Loads `../shared/config.js`, `../shared/chronicle-store.js`, `../shared/chronicle-ids.js`, `../shared/chronicle-publish.js`, `../shared/chronicle-integrity.js`, `../shared/chronicle-ai.js` and `../shared/chronicle-narrative.js`
- Fetches `../data/pc-abilities.json` once at start-up (`loadPartySpellNames()`, as intake does) for the party's spell names, which publish uses to tell a spell from a weapon. If the fetch fails the page carries on and publish records non-standard actions as Attack, saying so in its notes
- **IDs (issue #95):** the staged queue names entities by legacy ID. When the campaign loads, `translateQueueIds()` rewrites every legacy ID in the queue to its UUID, before gap detection. At publish, `ChroniclePublish.applySession()` translates every delta again and gives each NEW entity a UUID. A placeholder the page or intake made up for a new entity (`cbt_007`, `session_008`) maps to that UUID for the rest of the publish, and NEW deltas are applied first, so a round queued before its new combat still finds it. Only a new session keeps its placeholder, as `legacy_id`. Relationship ids are UUIDs too. The New-combat placeholder number is counted from the frozen legacy IDs, so it never names an existing combat
- Uses `ChronicleAI.sendCorrectionToAI()` to refine individual delta items via an AI assistant chat panel
- On load, calls `loadIntakeDelta()` — if a `chronicle_intake_delta` key exists in sessionStorage (written by `intake.html` "Send to Delta Review"), the envelope items replace the default empty queue and a banner identifies the session source. The key is **not cleared on load** — it persists until `publish()` succeeds, so the DM can navigate away and return without losing the queue (restoration banner auto-dismisses after 5 seconds). If no key exists, the queue is empty as usual.
- **Integrity pre-flight panel**: on load, calls `ChronicleStore.loadCampaign()` (`../data/magers-campaign.json`) and runs `ChronicleIntegrity.checks()` against the staged session data. If gaps are found, an integrity panel appears in the center area before the review queue. Each gap presents three options: **Accept** (acknowledged, no record written), **Defer** (flagged for future correction — written to `deferred_gaps[]` in the published JSON), or **Edit** (AI-assisted fill via image or typed description; approved proposals join the approval queue). The Publish button is blocked until every gap has an explicit Accept or Defer decision. The **Reprocess** sub-option under Edit is a disabled placeholder — see code comments for design decisions required before building
- **Publish** action: `ChronicleStore.loadPublishBase()` fetches the current campaign JSON from Drive (not from `/data/`); `applyDeltasToCampaign()` hands the approved items, the deferred gaps, the prompt-improvement entries from sessionStorage and the spell names to `ChroniclePublish.applySession()` (see Data architecture, "Publish"); then `ChronicleStore.publishSession()` makes a Drive backup labelled with the session stub's item id and writes the result back to Drive. In Safe Test Mode the base is the local fixture and the result is downloaded as `test-campaign.json` instead of written. On success the status line counts publish's notes (listed in the console) and the prompt-improvement entries are cleared from sessionStorage; on failure they are kept
- **What publish writes (issue #92):** queued ROUND items keep the AI's flat proposal shape (one entry per roll) so the review card and inline edits work as before; publish converts them to the 5.0.0 turn schema. The intake session stub (`session_id`, `session_date`, root `summary`) is written under the schema's names (`id`/`legacy_id`, `date`, `narrative.summary`) with every session field present; when the session already exists (the `session_006`/`session_007` placeholders) its empty fields are filled and nothing recorded is overwritten. The "Narrative notes" item is not written (it used to be pushed as a session with no id). A new combat gets every combat field, including an empty `enemies_roster`
- **RAW item Interpret button** (issue #70): RAW OCR-page items are not written on publish. Each RAW item card has an **Interpret** button that sends the OCR text to the AI and converts it to ROUND delta items for normal review and approval. The source RAW item is marked `'interpreted'` once complete.
- Approval workflow: each queue item can be Approved, Rejected, or sent for AI correction. Items include session metadata, NPC entries, location entries, combat rounds, and quest updates
- Does not read campaign data from Drive for the integrity check — uses `../data/magers-campaign.json` (same-origin repo copy). The Drive copy and repo copy can diverge; integrity checks against whichever is currently in the repo

---

### `admin/integrity.html` — Campaign Integrity (placeholder)

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/integrity.html`
- **Audience:** DM only
- Loads the campaign at init with `ChronicleStore.loadCampaign()`. Loads `../shared/config.js`, `../shared/chronicle-store.js`, `../shared/chronicle-integrity.js`, and `../shared/chronicle-ai.js`
- The intake gap-checker that formerly lived here was moved to `delta-review.html` (Phase B). This page is now a placeholder shell for the future campaign quality scanner
- The **Run Scan** button is present but disabled — functionality is not yet implemented. When built, this tool will surface structural gaps and quality improvement opportunities across the full campaign JSON. It will also display the `deferred_gaps[]` queue (entries created when the DM chose Defer during a delta-review session)
- See the page script comments for the full planned feature set (scan types, output format, write-back options)

---

### `admin/log-editor.html` — Log Editor

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/log-editor.html`
- **Audience:** DM only
- In-browser editor for party, NPC, location, quest, item, and lore entries
- Loads `../shared/config.js`
- Loads the campaign at init with `ChronicleStore.loadCampaign()` and rebuilds the ENTITIES list from live v4 JSON; shows a toast error (rather than silently falling back) if fetch fails
- Loads `../shared/config.js`, `../shared/chronicle-store.js` and `../shared/chronicle-ai.js` — AI draft panel (`ChronicleAI.call()`) is wired and available
- Edits are applied to the in-memory ENTITIES array only — there is no write-back to the JSON file or Drive. "Save" commits changes locally within the browser session; they are lost on page reload
- The `previewChanges()` function shows an alert describing pending edits; it does not produce a real JSON diff or write to any file

---

### `admin/versions.html` — Version Manager

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/versions.html`
- **Audience:** DM only
- Manages a local backup ledger (stored in `localStorage`) and syncs with Drive backups
- Loads `../shared/config.js` and `../shared/chronicle-store.js`
- Fetches the backup list from Drive with `ChronicleStore.listBackups()`; can download any Drive backup as a JSON file via `ChronicleStore.loadBackup()`
- "Pre-session backup" action: `ChronicleStore.createBackup()` makes a Drive backup copy, then `ChronicleStore.loadPublishBase()` reads the Drive file (not `/data/`; the local fixture in Safe Test Mode) to compute stats
- Backup ledger stored in browser `localStorage` — cleared if the user clears site data

---

### `admin/drive-test.html` — Drive Diagnostics

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/drive-test.html`
- **Audience:** DM only (for debugging Drive proxy issues)
- The only page that calls the Drive proxy directly instead of through `ChronicleStore` — its job is to test the proxy itself
- Runs a suite of diagnostic tests against the Drive proxy: proxy reachability, file access, diagnose, campaign-read (now unused since reads moved to repo), campaign-write, backup
- Loads `../shared/config.js`
- No admin nav bar (standalone diagnostic page)
- The "campaign-read" test still calls `?action=read` on the proxy even though data reads moved to same-origin fetch in Phase 1

---

## Drive proxy

The proxy is a Google Apps Script web app whose URL lives in `shared/config.js` (gitignored).

```
GET  ?action=backup&id=FILE_ID&label=LABEL  → {ok, backupId, name}
GET  ?action=listBackups&id=FILE_ID         → {ok, backups:[{id,name,modified,size}]}
GET  ?action=diagnose&id=FILE_ID            → {ok, diagnostics:{name,mimeType,size}}
POST Content-Type:text/plain  body:{action:"write",fileId,data:{...}}  → {ok}
```

GET for all operations except writes avoids CORS preflight. POST uses `Content-Type: text/plain` (a CORS simple type). The proxy is scoped to Drive folder `1BJQxOS4MspOlPzCt70r7zOY_8LnwAwPY`.

`GET ?action=read` is still tested by `drive-test.html` but is no longer called by the main app.

---

## Shared modules

Load order when a page needs several: `config.js` → `chronicle-store.js` → `chronicle-ids.js` → `chronicle-publish.js` → `chronicle-integrity.js` → `chronicle-ai.js` → `chronicle-narrative.js` → page script.

### `shared/chronicle-publish.js`

Loaded by `delta-review.html`; required directly by `tests/delta-apply.test.js` and `tests/delta-schema.test.js`. Exports `window.ChroniclePublish` in the browser and `module.exports` under Node. Depends on `chronicle-ids.js` (looked up when called, so it must be loaded first in the page). No DOM, sessionStorage or network access. Added by issue #92.

| Export | What it does |
|---|---|
| `applySession(campaign, approved, options)` | Applies one session's approved queue items and returns `{ campaign, notes }`; neither input is modified. `options = { deferredGaps, promptLog, spellNames, now }`, all optional. Order: give every NEW entity its UUID; apply NEW items (sessions filled or created, combats created with full shape); apply ROUND, MOD and RELATIONSHIP items; recompute derived fields; append deferred gaps and prompt-log entries (`pil_NNN`); set `meta.last_updated`, `_last_published` and `_delta_count` |
| `deriveFields(campaign)` | Recomputes the derived fields in place (listed under Data architecture, "Publish"). Adds values, never removes them. Idempotent. On the current campaign file it changes one thing: Lake Town's `sessions_visited` gains `session_006`, which the session already listed |
| `STANDARD_ACTIONS` | The twelve standard action names an action-economy activity may have |

**Round conversion rules** (an AI proposal entry is `{s, a, act, res, val, notes, action_type, target, target_effects, val_type}`, one per roll):
- **Grouping:** entries with the same slot and actor make one slot; consecutive entries with the same economy and action text make one activity, one outcome per roll. A slot already in 5.0.0 shape is kept as it is; any other shape is left out and noted.
- **Economy:** `action_type` maps to the economy (`free_action` → `free`). A missing `action_type` is recorded as the action and counted in the notes.
- **Name and detail (action economy):** `Death save` → Death Save; `No Action`/`None` → No Action; a prevented turn (`Stable`, `Unconscious`…) → `No Action: <reason>`; `Ready: X` → Ready · X; a standard action keeps its name; a known spell → Magic · spell; anything else → Attack · text, noted once per name. Known spells are the party's spell lists plus every spell the campaign already records as a Magic activity, because the harvested lists are incomplete. Other economies keep the text as the name (Flurry of Blows).
- **Results:** a neutral result with no value is no roll (no outcome). For a death save hit/miss become success/failure. `fail` (the target failed its save) becomes hit, the counterpart of `save`. An unknown result word becomes `unclear` and is noted. A non-numeric value becomes null and is noted.
- **Targets:** resolved to an existing id, `self` → the actor, a roster group of this combat (singular/plural forms match), a party member by name or nickname, an NPC by name, or the first roster group of a bestiary creature with that name; otherwise kept as `target_text` with `target_id` null. A slash-joined target becomes one outcome per target. `killed`/`downed` in `target_effects` become the outcome's `effect`; other conditions go in the outcome's notes.
- **Notes:** a single roll's note sits on the activity (the viewers show activity notes); with several rolls each outcome keeps its own.
- **Enemy lines** (`{desc, impact}`): grouped into one turn per roster group per round. The group comes from a `Label:` prefix, from the text starting with a roster label, or from the only group the combat has. A label the roster lacks is added as a new group (pointing at a bestiary entry of that name if there is one) and noted; a line with no usable label goes to an `Unidentified enemies` group and is noted. The action text is kept as the activity's name; `impact` becomes a `special_events` entry of type `other`.
- **Session (`sid`):** a known session id is kept; `incoming session` or no value means the publish's own session when it has exactly one; a comma-joined list with exactly one known session means that one; anything else is written as null and noted.
- **Merging:** a round number already recorded is merged: each slot's and enemy group's activities are added, an identical activity is not added twice, and the round keeps its recorded `sid`.

### `shared/chronicle-ids.js`

Loaded by `delta-review.html`; required directly by `scripts/migrate-opaque-ids.js`, `scripts/migrate-turn-schema.js` and the tests. Exports `window.ChronicleIds` in the browser and `module.exports` under Node. No dependencies. Added by issue #95.

| Export | What it does |
|---|---|
| `ENTITY_ARRAYS` | The root arrays whose objects carry an opaque id. Quest objectives are added by `forEachEntity()`. `prompt_improvement_log` and `deferred_gaps` are not included (workflow records) |
| `newId()` | A fresh lowercase UUID v4 (`crypto.randomUUID()`). The one place ids are minted |
| `isOpaqueId(s)` / `isLegacyId(s)` | Whether `s` is a UUID / a typed legacy ID such as `npc_014` (whole string only) |
| `forEachEntity(campaign, fn)` | Calls `fn(obj, arrayName)` for every entity and quest objective |
| `buildLegacyIndex(campaign)` | `Map` of `legacy_id` → `id` |
| `translateRefs(value, index)` | Deep copy with every string that exactly equals a legacy ID replaced; prose and `legacy_id` fields untouched |
| `findEntity(campaign, idOrLegacy)` | `{ entity, array }` for a UUID or a legacy ID, or `null` |

The two viewers do not load it: `normaliseCampaignJson` must stay self-contained, so it builds its own `legacy_ids` map. `chronicle-narrative.js` does not load it either; it matches a party member by `id` or through `legacy_id` itself (`_findPartyMember()`).

### `shared/chronicle-store.js`

Loaded by every page that reads or writes campaign data: `player/index.html` and the admin pages `log-viewer`, `intake`, `delta-review`, `integrity`, `log-editor` and `versions`. Exports `window.ChronicleStore`. It is the only code that fetches the campaign JSON or calls the Drive proxy (except `drive-test.html`, which tests the proxy directly). It reads `window.CHRONICLE_CONFIG` when each call runs, and works without `config.js` for reads (GitHub Pages).

| Method | What it does today | Planned change |
|---|---|---|
| `.loadCampaign()` | Same-origin fetch of `../data/magers-campaign.json` (the test fixture in Safe Test Mode). Returns the raw v4 JSON; throws on HTTP error | Phase 7: API call |
| `.loadPublishBase()` | Reads the Drive campaign file through the proxy (`?action=read`), which publish builds on (the fixture in Safe Test Mode) | #97: same as `loadCampaign()` |
| `.publishSession(campaign, summary, options)` | `summary = { sessionId, label }`, `options = { onProgress }`. Makes a Drive backup labelled `summary.label`, then POSTs the campaign to Drive. Returns `{ mode: 'drive', backup }`. In Safe Test Mode downloads `test-campaign.json` instead and returns `{ mode: 'test-download', filename }` | #97: commit to the repo |
| `.createBackup(label)` | Drive `?action=backup` on the campaign file | Phase 7 |
| `.listBackups()` | Drive `?action=listBackups` | Phase 7 |
| `.loadBackup(backupId)` | Drive `?id=<backupId>`; returns the backup's JSON | Phase 7 |
| `.saveDraft()` / `.loadDraft()` | Stubs — always reject with "not available until … Postgres" | Phase 7: saved review drafts |
| `.isSafeTestMode()` | `true` when `CHRONICLE_CONFIG.safeTestMode === true` | — |

Drive calls use the test Drive file (`testCampaignFileId`) in Safe Test Mode and throw "Drive is not configured" when `config.js` or its `proxyUrl` is missing.

---

### `shared/chronicle-integrity.js`

Loaded by `delta-review.html` and `integrity.html`. Exports `window.ChronicleIntegrity` with a single method:

- `.checks(campaignData, incomingData)` — pure gap-detection function. Takes a campaign object and an array of incoming delta items; returns a flat array of gap objects. No DOM access, no API calls. Load order: see the top of this section.

Gap object shape: `{ id, group, sev, block, isNew, cbtId, cbtName, sessHint, miss, have, rmin, rmax, title, detail, ctx }`

---

### `shared/chronicle-ai.js`

Loaded by `intake.html`, `delta-review.html`, and `integrity.html` via `<script src="../shared/chronicle-ai.js">`. The module reads the Anthropic API key from `window.CHRONICLE_CONFIG.anthropicApiKey` (set by `config.js`). Calls go directly from the browser to the Anthropic API using the `anthropic-dangerous-direct-browser-access` header — there is no server-side proxy for AI requests.

Model: `claude-sonnet-4-6`

Public API (`window.ChronicleAI`):
- `.call({system, messages, onResult, onError, onLoading})` — raw API call
- `.fillRoundsFromImage({images, combatName, combatId, sessionId, roundNumbers, ...})` — vision round extraction
- `.fillRoundsFromText({text, combatName, combatId, sessionId, roundNumbers, ...})` — text round transcription
- `.sendCorrectionToAI({correctionText, itemContext, scope, pendingItems, ...})` — delta correction assistant
- `.PARTY_ROSTER` — party nicknames string for injecting into prompts
- `.imageContent(source)` — builds an Anthropic image content block from a File, data-URL, or `{media_type, data}` object
- `.demoRoundProposals(roundNumbers, sessionId, source)` — demo data for offline testing
- `.demoCorrectionResponse(correctionText, itemContext)` — demo data for offline testing

---

## Deployment

- **Host:** GitHub Pages, serving from the `main` branch root
- **Player URL:** `https://<username>.github.io/Chronicle-MagersCampaign/player/`
- **Admin URL:** `https://<username>.github.io/Chronicle-MagersCampaign/admin/log-viewer.html`
- **Deploy trigger:** Automatic on push to `main`
- `shared/config.js` is gitignored and must be present locally on each admin machine — it is never deployed to Pages. Admin pages that require it (all admin pages except `drive-test.html` for basic display) will fail to call Drive or the Anthropic API without it.

---

## Known issues and gaps

| Issue | File | Detail |
|---|---|---|
| AI round output is not the turn schema | `shared/chronicle-ai.js` | The round-fill prompts return their own flat per-roll format (`initiative_grid` entries with `action_type`, a literal action name and a free-text target). Publish converts it (#92), but the AI gives no spell/attack type, so an action that is neither a known spell nor a standard action is recorded as Attack and noted. #101 moves extraction itself to the turn schema. |
| Enemy actions are published as written | `shared/chronicle-publish.js` | The AI returns enemy actions as free text (`{desc, impact}`) with no group id, result or target. Publish assigns each line to a roster group (adding a group the notes name, or `Unidentified enemies` when none is named) and keeps the text as the activity's name, with no outcomes. Structured enemy turns arrive with #101. |
| Narrative notes item is not saved | `shared/chronicle-publish.js` | Intake's "Narrative notes" queue item (`narrative_text`) is reference text for the review. Publish used to push it as a session with no id; since #92 it writes nothing and says so in its notes. The intake rebuild keeps narrative as passages (#100–#102). |
| Derived fields only add | `shared/chronicle-publish.js` | `deriveFields()` adds computed values and never removes stored ones, because some hand-entered values (an NPC met outside combat, a place passed through) are not yet recorded anywhere it can see. A wrong stored value therefore survives a publish. Full recomputation becomes possible once passages and mentions are recorded (#100–#102). |
| Placeholder fill never overwrites | `shared/chronicle-publish.js` | Filling `session_006`/`session_007` writes only empty fields, because intake's stub dates itself to the day of intake. A deliberate change to a recorded title, date or summary is reported in the publish notes but not applied; make it with a MOD item or by hand. |
| Session stub field names | `admin/intake.html`, `admin/delta-review.html` | Intake still writes the stub as `session_id`, `session_date` and a root `summary`, and the review card reads those names. Publish translates them (#92). The session page of the intake rebuild replaces the stub. |
| Turn-schema migration inconsistencies | `data/magers-campaign.json` | Reported by the migration and listed on issue #93, not fixed (scope). Examples: `cbt_002` r4 Goli's "3 Melee Attacks" has 2 results; Move/Dash logged as both the action and the movement in 5 turns; 3 spells with no result. |
| `cbt_002` r6 IDs disagree with names | `data/magers-campaign.json` | The event "pc_001 (Goli) downed" and "pc_005 (Del) at 1HP" name the wrong IDs (pc_001 is Goldie, pc_005 is Goli). `mechanics.pcs_downed` records Del's round 7 down twice (under pc_005 and pc_004) and has pc_001 "Goli DOWNED Round 6". The round 6 hit targets pc_001 and pc_005. Slot data supports the names. Left unchanged for the DM to check against the notes as a separate data fix. |
| `cbt_003` r5 note may sit on the wrong turn | `data/magers-campaign.json` | The Axe Beaks note "1 swarm attacks each horse (2 total). Del hit." reads like the Vespon Swarm's turn (one horse outcome, notes "2 separate swarm attacks"). Left as is pending the DM's check of the session_004 notes. |
| Death saves no longer count in round hit/miss chips | `admin/log-viewer.html`, `player/index.html` | `roundSummaryChips()` and the combat totals count `res === 'hit'`/`'miss'`. Death saves were logged as hit/miss and inflated those counts; as success/failure they no longer do. Intentional, recorded here so the change in totals is not mistaken for lost data. |
| Prose still names legacy IDs | `data/magers-campaign.json` | 77 strings mention a legacy ID inside text ("Killed by pc_006 Ice Knife", "Combat paused at end of session_005"). #95 left them as written: rewriting them to UUIDs would make the notes unreadable, and `legacy_id` still resolves them. The viewers show them as plain text, not links. |
| AI prompts and intake still use legacy IDs | `shared/chronicle-ai.js`, `admin/intake.html`, `admin/glossary.html`, `shared/chronicle-narrative.js` | The party roster in the prompts, the AI's example output, the session ID field in intake and the glossary's PC list all say `pc_001`/`session_006`. Delta Review translates them to UUIDs when the campaign loads and at publish. An entity created after #95 has no legacy ID, so the AI is shown its UUID. Moved off legacy IDs by the intake rebuild (#99–#101). |
| Hardcoded relationship and party maps keyed by legacy ID | `admin/log-viewer.html`, `player/index.html` | `RELS` and `PARTY_LOOKUP` were written by hand with legacy IDs. `relinkLegacyMaps()` re-keys them to UUIDs at load (56 graph links before and after #95). `RELS` is replaced by computed relationships in #106. |
| Enemy roster groups have no ids | `data/magers-campaign.json` | An outcome's `target_id` and an enemy turn's `actor_id` may be a roster `actor_id` label ("Goblins"), not a UUID. #95 gave ids to objects that already had one; roster groups never did. The reference check accepts a roster label only within its own combat. |
| `scripts/build.js` is dead code | `scripts/build.js` | EMBEDDED_DATA markers were removed from all HTML files in Phase 1. Running the script produces "SKIP (markers not found)" warnings and changes nothing. |
| Log editor edits are in-memory only | `admin/log-editor.html` | No write-back to JSON or Drive. Changes are lost on page reload. |
| Player view links to admin | `player/index.html` | Has a "⇄ Admin" button linking to `../admin/log-viewer.html`. |
| drive-test campaign-read test obsolete | `admin/drive-test.html` | Tests `?action=read` on the proxy, which the main app no longer calls. |
| Campaign scanner not yet implemented | `admin/integrity.html` | Run Scan button is disabled. Page is a placeholder shell. See page script comments for planned functionality. |
| Reprocess sub-option is a placeholder | `admin/delta-review.html` | The Reprocess button under Edit in the integrity panel is disabled. See code comments for design decisions required before building. |
| cbt_003 Axe Beak & Vespon Ambush rounds 2–3 missing | `data/magers-campaign.json` | `rounds[]` contains [1, 4–11] — rounds 2 and 3 are absent. Surfaced by integrity checker. Check physical session_004 notes; if unrecoverable, formalise via deferred_gaps workflow. Tracked in #35. |
| cbt_006 Wolf Fight has no rounds | `data/magers-campaign.json` | `rounds: []` — combat detail is pending. |
| npc_013 has no name | `data/magers-campaign.json` | The Low-Level Wizard: no proper name, no session link. |
| qst_003 Escort to Lake Town incomplete | `data/magers-campaign.json` | No objectives, no narrative.motivation — currently active. |
| loc_009, loc_010, loc_013 are stubs | `data/magers-campaign.json` | Map markers only — no description or context. |

---

## Test infrastructure

### Directory layout

```
tests/
├── run-all.js                      # Runs every test file; exits 1 if any fail
├── integrity.test.js               # Tests for shared/chronicle-integrity.js
├── intake-image.test.js            # Group A — OCR round-data shape validation
├── intake-preparation.test.js      # Group C — session data preparation checks
├── delta-schema.test.js            # Group E — delta item schema validation
├── delta-apply.test.js             # shared/chronicle-publish.js (#92): turn schema, enemy turns, sessions, derived fields, merges, IDs; gate through both viewers
├── store.test.js                   # shared/chronicle-store.js — paths, Drive calls, Safe Test Mode
├── turn-schema.test.js             # 5.0.0 turn schema — migration rules, converted data, both normalisers
├── bestiary-fold.test.js           # Goblin Slinger fold (#94) — no mon_006, roster roles, both normalisers
├── opaque-ids.test.js              # Opaque ids (#95) — helpers, reference check, migrated data, both normalisers
├── fixtures/
│   └── test-campaign.json          # Minimal v5.0.0 synthetic campaign — no real data
├── ocr-ground-truth/
│   └── README.md                   # Ground-truth pair format (image + expected JSON)
└── ai-input-fixtures/
    └── README.md                   # AI response fixture naming conventions
```

### Running tests

```
node tests/run-all.js          # Full suite (all groups except ground-truth OCR)
node tests/integrity.test.js   # Individual file
```

All tests are plain Node.js — no install required.

### Safe Test Mode

`shared/config.js` (gitignored) contains two fields that redirect data reads and Drive writes to test targets. `shared/chronicle-store.js` applies them; no page checks them itself:

| Field | Default | Purpose |
|---|---|---|
| `safeTestMode` | `false` | When `true`, all reads and Drive writes target test data |
| `testCampaignFileId` | `''` | Drive file ID of the test campaign copy |

When `safeTestMode: true`:
- `ChronicleStore.loadCampaign()` and `.loadPublishBase()` read `../tests/fixtures/test-campaign.json` instead of the repo file or Drive
- `ChronicleStore.publishSession()` downloads the result as `test-campaign.json` instead of writing to Drive, and makes no backup
- `ChronicleStore.createBackup()` and `.listBackups()` target `testCampaignFileId` instead of `campaignFileId`

Switching test mode on or off requires changing only `config.js`. Older copies of `config.js` also define `getCampaignPath()` and `getCampaignFileId()` resolvers; only `drive-test.html` still calls `getCampaignFileId()`, and nothing calls `getCampaignPath()`.

**Never commit `safeTestMode: true`** — it would redirect all data reads for anyone who deploys the page locally.

### Test fixture

`tests/fixtures/test-campaign.json` is a minimal v5.0.0 campaign with synthetic data (no real Magers campaign content). It contains: 2 party members, 2 sessions, 1 combat (3 rounds with known content), 3 NPCs, 2 quests, 2 items, 2 locations. All automated tests run against this fixture. Since #95 its entities have UUID ids with their old typed IDs as `legacy_id`, like the real file; its two quest objectives never had ids and still have none.

---

## Updating this document

This README is regenerated from source using Claude Code. To update it after making changes to Chronicle, run the prompt in `docs/chronicle-docs-prompt.md` from the repository root in Claude Code. That prompt reads every file and rewrites both README.md and CLAUDE.md in one pass.
