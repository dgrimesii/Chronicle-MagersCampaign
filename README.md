# Chronicle — Magers Campaign

## What this is

Chronicle is a DM tool and campaign log manager for the Magers D&D 5e campaign, run by John Magers. It provides an admin interface for the DM to record sessions, fill combat round data using AI, review deltas before publishing them to the campaign file — and a separate read-only player view for sharing progress with the party. It is a vanilla HTML/CSS/JS web app with no framework and no build step. The DM runs it locally from VS Code with Live Server, and GitHub Pages serves the pushed copy. Campaign data is a plain JSON file in the repo: publishing writes it in the DM's local clone, and the DM commits and pushes it from VS Code. The Google Drive proxy is used only for the Versions page's backups.

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
│   ├── session.html            # Session page (#99–#101) — the rebuilt intake; upload, extract, identify, and reading each page's facts so far
│   ├── intake.html             # Session intake / photo OCR pipeline — uses ChronicleAI
│   ├── glossary.html           # OCR hints glossary — hardcoded glossary data, no JSON fetch
│   ├── delta-review.html       # Post-session delta review and publish (writes the local campaign file) — uses ChronicleAI
│   ├── integrity.html          # Combat round integrity checker / gap filler — uses ChronicleAI
│   └── log-editor.html         # In-browser campaign data editor — edits in memory only
├── shared/
│   ├── config.js               # GITIGNORED — Safe Test Mode switch, Anthropic and Gemini API keys (Drive keys left from before #98 are ignored)
│   ├── chronicle-store.js      # Storage module — every campaign read and write goes through window.ChronicleStore
│   ├── chronicle-ids.js        # Opaque UUID ids and legacy-ID translation (#95) — exports window.ChronicleIds; also require()-able in Node
│   ├── chronicle-entities.js   # Entity identification (#100) — mention prompt, review rows, the DM's actions, publish items; exports window.ChronicleEntities; also require()-able in Node
│   ├── chronicle-facts.js      # Per-page facts (#101) and narrative passages (#102) — facts prompt against step 3's occurrences, reply check, imbalance/economy checks, merge across pages, passage publish items; exports window.ChronicleFacts; also require()-able in Node
│   ├── chronicle-publish.js    # Publish logic (#92) — applies approved review items, writes the 5.0.0 shapes; exports window.ChroniclePublish; also require()-able in Node
│   ├── chronicle-ai.js         # Shared Anthropic API module — exports window.ChronicleAI
│   ├── chronicle-integrity.js  # Gap detection and the nine round sanity checks (#104) — exports window.ChronicleIntegrity
│   └── chronicle-narrative.js  # Shared Gemini narrative module — exports window.ChronicleNarrative
├── data/
│   ├── magers-campaign.json    # Campaign data — single source of truth, schema version 5.0.0
│   ├── magers-campaign.prev.json # GITIGNORED — the campaign file as it was before the last publish (#97); appears after a first publish
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
│   ├── integrity.test.js             # Tests for shared/chronicle-integrity.js (gap detection)
│   ├── sanity-checks.test.js         # Tests for the nine round sanity checks (#104): one per check on the fixture, plus the acceptance cases
│   ├── intake-image.test.js          # Group A — OCR round-data shape validation
│   ├── intake-preparation.test.js    # Group C — session data preparation checks
│   ├── delta-schema.test.js          # Group E — delta item schema validation
│   ├── delta-apply.test.js           # Tests for shared/chronicle-publish.js (publish), incl. the #92 gate run through both viewers
│   ├── store.test.js                 # Tests for shared/chronicle-store.js — paths, local-file publishing against a fake folder, no GitHub or Drive calls, Safe Test Mode
│   ├── turn-schema.test.js           # Tests for the 5.0.0 turn schema: migration rules, converted data, both viewers' normalisers
│   ├── bestiary-fold.test.js         # Tests for the Goblin Slinger fold (#94): no mon_006, roster roles, both viewers' bestiary
│   ├── opaque-ids.test.js            # Tests for opaque ids (#95): chronicle-ids.js, the reference check (gate), migrated data, both viewers
│   ├── session-header.test.js        # Tests for the session page's upload step (#99): session choices, the header through applySession, nav bar
│   ├── entity-identification.test.js # Tests for shared/chronicle-entities.js (#100): rows, matching, actions, flags, publish items through applySession
│   ├── fact-extraction.test.js       # Tests for shared/chronicle-facts.js (#101, #102): occurrences not names, self-checks, one combat across a page break, passages attached where they belong
│   ├── fixtures/
│   │   └── test-campaign.json        # Minimal v5.0.0 synthetic campaign for automated tests
│   ├── output/                       # GITIGNORED — test-campaign.published.json, written by a Safe Test Mode publish (#97)
│   ├── ocr-ground-truth/             # Ground-truth image+JSON pairs for OCR accuracy testing
│   └── ai-input-fixtures/            # Captured AI response fixtures for offline test runs
├── .vscode/
│   └── settings.json           # Live Server ignores data/** and tests/**, so a publish never reloads the page (#97)
├── .gitignore                  # Ignores shared/config.js, data/magers-campaign.prev.json, tests/output/
├── CLAUDE.md                   # Behavioural instructions for Claude Code
└── README.md                   # This file
```

---

## Data architecture

```
STORAGE     → shared/chronicle-store.js  (window.ChronicleStore — the only code that reads or writes campaign data)
DATA READS  → /data/magers-campaign.json  (same-origin fetch, served by Live Server locally or GitHub Pages)
DATA WRITES → data/magers-campaign.json in the local clone  (delta-review publish, File System Access API, #97)
              then commit and push from VS Code
BACKUPS     → git history once the DM commits; data/magers-campaign.prev.json until then
APP HOSTING → Live Server from VS Code (DM, admin); GitHub Pages serves what is pushed
```

Campaign data lives in `data/magers-campaign.json`. Every page that needs it calls `ChronicleStore.loadCampaign()`, which fetches this file same-origin (no proxy, no CORS) or, in Safe Test Mode, the test fixture. No page calls `fetch()` on the campaign file itself. Nothing in Chronicle calls Google Drive any more (#98). Updating the JSON and pushing to GitHub triggers an automatic Pages redeploy; every page picks up the new data on next load.

**Identifiers (issue #95).** Every entity `id` is a UUID v4, allocated by `ChronicleIds.newId()` in `shared/chronicle-ids.js`, never counted. The old typed ID (`pc_001`, `npc_014`, `cbt_005`, `session_005`) is kept on the entity as `legacy_id` and is frozen. Intake, the AI prompts and the DM still name entities by legacy ID, so anything that accepts an ID from outside the data translates it: Delta Review translates its staged queue when the campaign loads and again at publish, and the viewers accept a legacy ID in `selectEntity()`. Run `node scripts/migrate-opaque-ids.js data/magers-campaign.json --check` after any hand edit to confirm every reference still resolves.

**Publish (issue #92).** What a publish writes is decided by `ChroniclePublish.applySession()` in `shared/chronicle-publish.js`; Delta Review's `applyDeltasToCampaign()` is a thin wrapper that passes it the page's state, and the tests require the same file. It writes combat rounds in the 5.0.0 turn schema (turning the AI's one-entry-per-roll proposals into activities and outcomes, with targets resolved to ids and the round's session as `sid`), fills a placeholder session such as `session_006` instead of appending a second one, merges a round that continues across two pages, and recomputes the derived fields: each combat's `sessions` and `total_rounds_logged`, each session's `combats`, `locations_visited` and `npcs_met`, each location's `sessions_visited` and `combat_history`, and each bestiary entry's `combat_appearances`. Derived values are added, never removed, because some of today's hand-entered values (an NPC met outside combat) are not yet recorded anywhere the computation can see. Each publish returns notes on decisions it made for the DM (a weapon recorded as Attack, a placeholder's recorded date kept); the page logs them to the console and counts them in the status line.

**Local-file publishing (issue #97).** Publish writes `data/magers-campaign.json` in the DM's local clone through the browser's File System Access API (Chrome or Edge, with the page served by Live Server on `127.0.0.1`). The page never talks to GitHub and needs no token; the DM commits and pushes from VS Code, separately and on their own schedule, and git history is the backup once committed.

- **The folder.** On the first publish the DM picks the repository folder (`showDirectoryPicker`). A folder without `data/magers-campaign.json` is refused; if the DM picked the `data` folder itself, the error says so and asks for the folder that contains it. The picker reopens in the folder picked last, so after picking `data` by mistake, go up one level and make sure `data` is not highlighted before Select Folder. The handle is kept in IndexedDB (database `chronicle-store`), so later publishes reuse it. Each IndexedDB connection is closed after use, and an IndexedDB that is blocked or silent for 5 seconds only means the folder is asked for again, never a publish that waits forever; each new browser session the browser asks once, on the Confirm Publish click, for permission to edit it again.
- **Stale-file check.** `ChronicleStore.loadPublishBase()` reads the file from disk and remembers its exact text. `ChronicleStore.publishSession()` reads it again before writing. If the text differs at all (a `git pull`, a hand edit, a publish from another tab), the publish stops and nothing is written.
- **Safety net.** Before overwriting, the current file is copied to `data/magers-campaign.prev.json` (git-ignored), so the previous version can be put back until the session is committed.
- **Format.** The file is written as `JSON.stringify(campaign, null, 2)` plus a final newline, the format the repo stores, so VS Code's diff shows only what the publish changed. The browser writes to a temporary file and swaps it in when complete, so a failed write leaves the old file in place.
- **Errors.** Every failure (no folder chosen, permission refused, wrong folder, file missing, file changed) is shown as an error that ends "Nothing was written".
- **Live Server.** `.vscode/settings.json` sets `liveServer.settings.ignoreFiles` to Live Server's defaults plus `data/**` and `tests/**`, so a publish does not reload the page and lose the review. Restart Live Server after changing it.

The store module exists so the planned storage moves change only one file: #97 moved publish from Drive to the local file, and phase 7 replaces the repo file with an API backed by Postgres (see `docs/intake-redesign.md`, "Build order").

**Google Drive is retired (issue #98).** Chronicle no longer calls Google Drive. The Apps Script proxy calls, the Versions page with its Drive backups, and `drive-test.html` were removed; git history is the backup. Turning off the Apps Script deployment itself is the DM's step. A `config.js` that still has `proxyUrl`, `campaignFileId` or `testCampaignFileId` keeps working; nothing reads those keys.

**Intake → Delta Review hand-off via sessionStorage:**  
When the DM clicks "Send to Delta Review" in `intake.html`, the page writes a `chronicle_intake_delta` envelope to `sessionStorage` and navigates to `delta-review.html`. Delta Review reads but does **not** clear this key on load (`loadIntakeDelta()`). The key persists in sessionStorage until `publish()` removes it after a successful write, so the DM can navigate away from Delta Review and return without losing the queue. A companion flag (`chronicle_intake_delta_loaded`) is set after the first successful parse; on return visits it triggers a "Queue restored from previous session" banner that auto-dismisses after 5 seconds. If no key is present (direct navigation or post-publish reload), Delta Review starts with an empty queue as before.

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
2. **Delta Review** (`admin/delta-review.html`, opened through Live Server in Chrome or Edge) — review AI-proposed changes, approve, then Publish. Publish writes `data/magers-campaign.json` in the local clone (#97). The first time, pick the repository folder; each new browser session, allow editing it once
3. **Commit and push in VS Code.** The status line suggests the message `Publish session_NNN: <title>`. GitHub Pages redeploys on push

The rebuilt intake, `admin/session.html`, replaces steps 1 and 2 with one page as issues #99–#106 land. So far it has upload, extraction, entity identification and reading each page's facts, and cannot publish, so sessions still go through the two pages above.

If the file changed on disk after Delta Review read it (a `git pull`, a hand edit), Publish stops with nothing written; reload Delta Review and publish again. Until you commit, `data/magers-campaign.prev.json` holds the file as it was before the publish. To try the workflow without touching the campaign file, turn on Safe Test Mode (below): publish then writes `tests/output/test-campaign.published.json`.

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

`aliases` is written by the session page's entity identification (#100) once that page can publish (#106); no entity has one yet. `passages` is written by the session page (#102) once it can publish (#106): `{ text, session_id, speaker, page }`, on the one object the passage describes; no object has one yet. `role` is set on one group: `cbt_005` Goblin Slingers (`slinger`, #94). An observed ability in a bestiary entry may carry the same `role` when it was seen only in that role. `target_text` is used by the migrated data (`cbt_003` rounds 5 and 7).

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

### `admin/session.html` — Session (intake rebuild, steps 1–3 and the start of 4)

- **Audience:** DM only. First item in the admin nav bar
- The single page that replaces `intake.html` and `delta-review.html` (docs/intake-redesign.md, "The new flow"). Built in steps: #99 is the page and step 1, upload; #100 adds step 2, extract, and step 3, identify; #101 reads each page's facts at the start of step 4; the review grid and publish follow in #102–#106. The old pages stay until phase 5 passes
- Loads `../shared/config.js`, `../shared/chronicle-store.js`, `../shared/chronicle-ids.js`, `../shared/chronicle-publish.js`, `../shared/chronicle-entities.js`, `../shared/chronicle-facts.js` and `../shared/chronicle-ai.js`. The campaign comes through `ChronicleStore.loadCampaign()` (the fixture in Safe Test Mode); if it fails, the page shows the error and no session can be started
- **Session ID and date:** the picker lists `ChroniclePublish.sessionChoices()`: placeholder sessions first ("Fill placeholder session_006 — The Larkspur Dragons"), then the next new ID (`session_008`). Nothing is preselected. Picking a placeholder fills in its recorded date; a new session starts with no date, so the DM types the day it was played. Changing a placeholder's recorded date shows a warning, because publish keeps the recorded date and only reports the difference
- **Pages:** one drop zone takes photos (one per page) and at most one `.txt`/`.md` notes file; other types are refused with a message. Each photo is compressed when added (longest side 1800 px, JPEG, retried at 1400 px; too large still is shown on the row), so a bad photo is caught at upload. Rows are reordered by dragging the ≡ handle or with the ↑/↓ buttons (#71); the order is the reading order for extraction
- Also loads the campaign's NPC, location, monster and combat names and `../data/pc-abilities.json`, kept from intake for extraction (#100). A failure of either is only logged
- **Continue** needs a session, a date, at least one page or notes file, and every photo compressed. It builds the session header with `ChroniclePublish.sessionHeader()`, the item publish reads the session ID and date from, shows it, and starts step 2
- **Step 2, Extract (#100):** each page (and the notes file) is sent to the AI once, in order, with `ChronicleEntities.mentionPrompt()` and `ChronicleAI.extractMentions()`. The reply is every mention of an entity: kind, the words exactly as written, the line, the round, and optionally a candidate entity id from the campaign list (which includes the open combats and their roster groups). Each page row shows waiting, reading, its mention count, or the error with a Retry button; a page with no list blocks step 3, and there is no demo fallback. A dense page takes one to two minutes. Pages already read are not re-read when the DM goes back, unless the pages or their order changed
- **Step 3, Identify (#100):** the mentions become rows (`ChronicleEntities.buildRows()`), one per kind and spelling, each listing every occurrence with its page, round and line. New rows come first, then inexact matches (the AI's candidate), then exact matches (the words equal a name, PC nickname or alias), which **Bulk acknowledge** settles together. The AI's confidence never decides which rows are exact. Actions, each covering every occurrence of the row: **Acknowledge** (a New row asks for the entity's name; an inexact match saves the words as an alias), **Link to existing** (any entity of the kind, or one another row created this session; saves the words as an alias unless the box is unticked), **Separate as new** (new entity plus a "not to be confused with" note on the look-alike), **Split** (names the entities; occurrences are assigned in step 4), **Mark as sub-type** (creatures: a roster group with a role in a combat, pointing at the bestiary entry). **Change** reopens a row, and any rows linked to the entity it created. A flag box lists likely merges: one non-group entity taking two turns in one round, one entity in two places or on both sides in one scene
- **Continue** after Identify needs every row settled. It builds the publish items with `ChronicleEntities.toQueueItems()`, says how many, and opens step 4
- **Step 4, facts (#101):** each page is read again with `ChronicleFacts.factsPrompt()` and `ChronicleAI.extractFacts()`, in order, for its rounds, turns, activities and outcomes in the turn schema's terms, plus quest progress and loot. Every actor and target is one of that page's occurrence ids from step 3, never a name, and nothing is placed by initiative slot; each turn keeps the line of the notes it came from. The prompt lists the combats the page may continue (open combats with their last recorded round, and combats created in step 3) and where the previous page stopped. A reply that names an entity or uses a value outside the schema is re-read once with the problems listed, then shown as an error with Retry; a reply that fails the imbalance or action-economy check is re-read once and any problem left is shown as a flag. The pages are then merged (`ChronicleFacts.mergePages()`): rounds of one combat across a page break stay one combat, a round split across pages is joined, and a round number going back down is flagged as a likely new combat. The result is shown read-only with every flag and the AI's own self-check notes; the round grid for correcting it is #103, so the page stops there. Changing a step 3 answer re-reads the facts
- **Passages (#102):** the same facts call splits the page's narrative (DM description and exposition, and what NPCs say, quoted or reported) into passages, cleaned into complete sentences with abbreviations expanded and no new facts. Each has a speaker (`dm`, which is fact, or the NPC's occurrence, which is testimony) and attaches to the most specific thing it describes: an entity, a combat, a round, an activity, a quest step, or the session. They are shown grouped by attachment with their speaker. `ChronicleFacts.passageItems()` turns those on an entity, combat or the session into publish items; those on a round, activity or quest step wait for the facts to be written (#106). New lore whose passage an NPC spoke is marked `reliability: "rumoured"`, `source_type: "npc_testimony"`. Each page's one-sentence summary, which intake used to discard, is saved as the session summary on the header publish reads (filled only if the session has none)
- **No saved state:** everything lives in the open tab (no sessionStorage or localStorage; saved drafts wait for Postgres). Once a page or notes file is added, leaving or reloading the page asks first (`beforeunload`)

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
- Reviews AI-proposed session deltas (new entities, round data, quest updates) before writing them to the campaign JSON
- Loads `../shared/config.js`, `../shared/chronicle-store.js`, `../shared/chronicle-ids.js`, `../shared/chronicle-publish.js`, `../shared/chronicle-integrity.js`, `../shared/chronicle-ai.js` and `../shared/chronicle-narrative.js`
- Fetches `../data/pc-abilities.json` once at start-up (`loadPartySpellNames()`, as intake does) for the party's spell names, which publish uses to tell a spell from a weapon. If the fetch fails the page carries on and publish records non-standard actions as Attack, saying so in its notes
- **IDs (issue #95):** the staged queue names entities by legacy ID. When the campaign loads, `translateQueueIds()` rewrites every legacy ID in the queue to its UUID, before gap detection. At publish, `ChroniclePublish.applySession()` translates every delta again and gives each NEW entity a UUID. A placeholder the page or intake made up for a new entity (`cbt_007`, `session_008`) maps to that UUID for the rest of the publish, and NEW deltas are applied first, so a round queued before its new combat still finds it. Only a new session keeps its placeholder, as `legacy_id`. Relationship ids are UUIDs too. The New-combat placeholder number is counted from the frozen legacy IDs, so it never names an existing combat
- Uses `ChronicleAI.sendCorrectionToAI()` to refine individual delta items via an AI assistant chat panel
- On load, calls `loadIntakeDelta()` — if a `chronicle_intake_delta` key exists in sessionStorage (written by `intake.html` "Send to Delta Review"), the envelope items replace the default empty queue and a banner identifies the session source. The key is **not cleared on load** — it persists until `publish()` succeeds, so the DM can navigate away and return without losing the queue (restoration banner auto-dismisses after 5 seconds). If no key exists, the queue is empty as usual.
- **Integrity pre-flight panel**: on load, calls `ChronicleStore.loadCampaign()` (`../data/magers-campaign.json`) and runs `ChronicleIntegrity.checks()` against the staged session data. If gaps are found, an integrity panel appears in the center area before the review queue. Each gap presents three options: **Accept** (acknowledged, no record written), **Defer** (flagged for future correction — written to `deferred_gaps[]` in the published JSON), or **Edit** (AI-assisted fill via image or typed description; approved proposals join the approval queue). The Publish button is blocked until every gap has an explicit Accept or Defer decision. The **Reprocess** sub-option under Edit is a disabled placeholder — see code comments for design decisions required before building
- **Publish** action: `ChronicleStore.loadPublishBase()` reads `data/magers-campaign.json` from disk in the local clone (asking for the repository folder the first time, and for permission once per browser session); `applyDeltasToCampaign()` hands the approved items, the deferred gaps, the prompt-improvement entries from sessionStorage and the spell names to `ChroniclePublish.applySession()` (see Data architecture, "Publish"); then `ChronicleStore.publishSession()` writes the result back to the file, keeping the previous one as `data/magers-campaign.prev.json` (see Data architecture, "Local-file publishing"). In Safe Test Mode the base is `tests/fixtures/test-campaign.json` and the result goes to `tests/output/test-campaign.published.json`. Opening the confirmation panel clears the previous publish status, so an old error never sits under a new attempt. The status line names the file written, suggests the commit message `Publish session_NNN: <title>` (adding "real campaign file untouched" in test mode) and counts publish's notes (listed in the console). On success the prompt-improvement entries are cleared from sessionStorage; on failure (including "changed on disk") the error is shown, nothing is written and the queue is kept. Needs Chrome or Edge
- **What publish writes (issue #92):** queued ROUND items keep the AI's flat proposal shape (one entry per roll) so the review card and inline edits work as before; publish converts them to the 5.0.0 turn schema. The intake session stub (`session_id`, `session_date`, root `summary`) is written under the schema's names (`id`/`legacy_id`, `date`, `narrative.summary`) with every session field present; when the session already exists (the `session_006`/`session_007` placeholders) its empty fields are filled and nothing recorded is overwritten. The "Narrative notes" item is not written (it used to be pushed as a session with no id). A new combat gets every combat field, including an empty `enemies_roster`
- **RAW item Interpret button** (issue #70): RAW OCR-page items are not written on publish. Each RAW item card has an **Interpret** button that sends the OCR text to the AI and converts it to ROUND delta items for normal review and approval. The source RAW item is marked `'interpreted'` once complete.
- Approval workflow: each queue item can be Approved, Rejected, or sent for AI correction. Items include session metadata, NPC entries, location entries, combat rounds, and quest updates
- The integrity check uses `ChronicleStore.loadCampaign()`, the same file publish writes, as it was when the page loaded

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
- Edits are applied to the in-memory ENTITIES array only — there is no write-back to the JSON file. "Save" commits changes locally within the browser session; they are lost on page reload
- The `previewChanges()` function shows an alert describing pending edits; it does not produce a real JSON diff or write to any file

---

## Shared modules

Load order when a page needs several: `config.js` → `chronicle-store.js` → `chronicle-ids.js` → `chronicle-publish.js` → `chronicle-integrity.js` → `chronicle-ai.js` → `chronicle-narrative.js` → page script.

### `shared/chronicle-publish.js`

Loaded by `delta-review.html` and `session.html`; required directly by `tests/delta-apply.test.js`, `tests/delta-schema.test.js`, `tests/session-header.test.js` and `tests/entity-identification.test.js`. Exports `window.ChroniclePublish` in the browser and `module.exports` under Node. Depends on `chronicle-ids.js` (looked up when called, so it must be loaded first in the page). No DOM, sessionStorage or network access. Added by issue #92.

| Export | What it does |
|---|---|
| `applySession(campaign, approved, options)` | Applies one session's approved queue items and returns `{ campaign, notes }`; neither input is modified. `options = { deferredGaps, promptLog, spellNames, now }`, all optional. A MOD carrying `_passage_append` (#102: passages added to the object's `passages`, skipping one with the same text and session) or `_alias_append` (added to `aliases`, skipping the name, nickname and existing aliases), `_note_append` (a line added to text `notes`) or `_roster_group_append` (a group added to `enemies_roster` unless its `actor_id` exists) adds to the entity instead of replacing fields (#100); a repeat publish adds nothing twice. Order: give every NEW entity its UUID; apply NEW items (sessions filled or created, combats created with full shape); apply ROUND, MOD and RELATIONSHIP items; recompute derived fields; append deferred gaps and prompt-log entries (`pil_NNN`); set `meta.last_updated`, `_last_published` and `_delta_count` |
| `deriveFields(campaign)` | Recomputes the derived fields in place (listed under Data architecture, "Publish"). Adds values, never removes them. Idempotent. On the current campaign file it changes one thing: Lake Town's `sessions_visited` gains `session_006`, which the session already listed |
| `STANDARD_ACTIONS` | The twelve standard action names an action-economy activity may have |
| `sessionChoices(campaign)` | The sessions the session page offers at upload (#99): every session whose `notes` start with "PLACEHOLDER", in data order, as `{ legacyId, title, date, placeholder: true }`; then the next new ID, one past the highest `session_NNN` legacy ID. Complete sessions are not offered |
| `sessionHeader(legacyId, date)` | The NEW `session_logs` item that carries the chosen session ID and date to `applySession` (#99): `rawData: { session_id, date }`. A placeholder is filled in place (its recorded date kept); a new ID is added with that date and `legacy_id`. Throws if the ID is not `session_NNN` or the date is not `YYYY-MM-DD` |

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

### `shared/chronicle-entities.js`

Loaded by `session.html`; required directly by `tests/entity-identification.test.js`. Exports `window.ChronicleEntities` in the browser and `module.exports` under Node. Depends on `chronicle-ids.js` (for new UUIDs). No DOM, storage or network access. Added by issue #100. It does for the session page what Delta Review's name index and duplicate check (#56) and cohort matching (#62) did; Delta Review keeps its own copies until phase 5 retires it.

| Export | What it does |
|---|---|
| `KINDS` | The mention kinds (`pc`, `npc`, `creature`, `faction`, `cohort`, `place`, `thing`, `combat`, `quest`, `moment`, `lore`): the group shown, the arrays a match may come from, and where a new one is created. A `pc` cannot be created, only linked |
| `norm(s)` | Lowercase, punctuation removed, spaces collapsed; no plural or fuzzy folding, so only true exact matches are bulk-acknowledged |
| `buildIndex(campaign)` | Every entity with its names (name, PC nickname, aliases). Open combats (outcome `paused`/`ongoing`) are marked, and their roster groups are added under a page-only id `roster:<combat id>:<actor_id>` that is never written |
| `entityListForPrompt(index)` / `mentionPrompt({entityList, pageLabel})` / `parseMentions(text)` | The step 2 prompt for one page and the check on the reply (JSON with a `mentions` list, each with words); anything else throws |
| `buildRows(pages, index)` / `sortRows(rows)` | Mentions → occurrences (`occ_<page>_<n>`, words kept as written) → rows, matched exact / inexact / new and ordered new first |
| `acknowledge`, `linkToExisting`, `separateAsNew`, `split`, `markSubType`, `reopen`, `bulkAcknowledgeExact`, `allSettled`, `newEntities` | The DM's actions on a row, and the entities this session's answers create |
| `resolveOccurrences(rows, index)` | Each occurrence's entity, roster group, or the entities it must be assigned between (a split); what facts and passages (#101, #102) will read |
| `flags(rows, index)` | Likely merges: acting twice in a round (groups excluded), two places in one scene, ally and enemy in one scene |
| `toQueueItems(rows, index, sessionLegacyId)` | The publish items: NEW entities (words linked to them become their aliases), `_alias_append` on existing entities (not roster groups), `_note_append` on a separated look-alike, `_roster_group_append` for a sub-type. Exact acknowledgements write nothing |

### `shared/chronicle-facts.js`

Loaded by `session.html`; required directly by `tests/fact-extraction.test.js`. Exports `window.ChronicleFacts` in the browser and `module.exports` under Node. Depends on `chronicle-entities.js`. No DOM, storage or network access. Added by issue #101.

| Export | What it does |
|---|---|
| `ENUMS` | The turn schema's economy, result, val_type and special-event values, plus the loot changes |
| `pageReferences(page, rows, index)` | This page's occurrences, each with what step 3 settled it as (entity, enemy group, or "to be assigned" for a split) and whether it is a group |
| `combatChoices(campaign, rows, index)` | The combats a page may add rounds to: open combats, recorded combats a page mentions, and combats created in step 3, each with its last recorded round |
| `factsPrompt({pageLabel, references, combats, carry, reread})` | The system prompt for one page: facts, passages (#102) and a page summary. No fixed slot-to-PC roster; attribute by occurrence, never by slot |
| `parseFacts(text)` | The reply's JSON with every list present; anything else throws |
| `validateFacts(facts, references, combats)` | Errors that make a reply unusable: an actor or target that is not an occurrence id of the page, an unknown combat, an economy/result/val_type outside the schema; a passage whose speaker is not `dm` or an occurrence, or whose attachment names something the page does not have |
| `checkFacts(facts, references)` | The self-checks from #104: more than one action or bonus action for one character in a round (groups exempt; a reaction recorded separately does not count), and imbalance (two actions for one while another who acts in that combat has no turn) |
| `mergePages(pages, references)` | The session's facts: rounds merged across pages in page order, each turn tagged with its page; round resets flagged; passages and page summaries gathered |
| `passageItems(merged, references, sessionLegacyId)` | Passages as MOD `_passage_append` items on an entity (a roster group's go on its combat), a combat or the session; those on a round, activity or quest step are returned as `deferred` for #106. Each passage is on one object only |
| `testimonyUpdates(identityItems, passages, references)` | New lore an NPC told the party gets `reliability: "rumoured"`, `source_type: "npc_testimony"` and the NPC as `source`; existing lore keeps its reliability |

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

Loaded by every page that reads or writes campaign data: `player/index.html` and the admin pages `log-viewer`, `intake`, `delta-review`, `integrity` and `log-editor`. Exports `window.ChronicleStore`. It is the only code that fetches the campaign JSON or touches the campaign file on disk. It reads `window.CHRONICLE_CONFIG` when each call runs, and works without `config.js` for reads (GitHub Pages).

| Method | What it does today | Planned change |
|---|---|---|
| `.loadCampaign()` | Same-origin fetch of `../data/magers-campaign.json`. In Safe Test Mode: `../tests/output/test-campaign.published.json` (no cache) when it exists, else the fixture; any status other than 404 on the output file throws. Returns the raw v4 JSON; throws on HTTP error | Phase 7: API call |
| `.loadPublishBase()` | Gets the repository folder (from IndexedDB, or `showDirectoryPicker` the first time, refusing a folder without `data/magers-campaign.json`), asks for read/write permission when the browser needs it, then reads `data/magers-campaign.json` from disk (`tests/fixtures/test-campaign.json` in Safe Test Mode) and remembers the exact text (#97). Must be called straight from a click | Phase 7: API call |
| `.publishSession(campaign, summary, options)` | `summary = { sessionId, sessionRef, title, label }`, `options = { onProgress }`. Needs `loadPublishBase()` first, in the same mode. Re-reads the file and throws, writing nothing, if its text changed; otherwise writes the current text to `data/magers-campaign.prev.json`, then the campaign to `data/magers-campaign.json`. Safe Test Mode writes only `tests/output/test-campaign.published.json`. Returns `{ mode: 'local-file', path, previousPath, testMode, commitMessage }`, where `commitMessage` is `Publish <sessionRef>: <title>` (#97) | Phase 7: API call |
| `.saveDraft()` / `.loadDraft()` | Stubs — always reject with "not available until … Postgres" | Phase 7: saved review drafts |
| `.isSafeTestMode()` | `true` when `CHRONICLE_CONFIG.safeTestMode === true` | — |

Publishing throws a message ending "Nothing was written" for a browser without the File System Access API, a closed folder picker, refused permission, a folder that is not the repository, a missing file or a file changed on disk. The store makes no network request to publish, and contains no GitHub URL or token and no Drive proxy setting (#98).

---

### `shared/chronicle-integrity.js`

Loaded by `delta-review.html` and `integrity.html`; required (with a stubbed `window`) by `tests/integrity.test.js` and `tests/sanity-checks.test.js`. Exports `window.ChronicleIntegrity`. No DOM access, no API calls. Load order: see the top of this section.

- `.checks(campaignData, incomingData)` — pure gap-detection function. Takes a campaign object and an array of incoming delta items; returns a flat array of gap objects. Gap object shape: `{ id, group, sev, block, isNew, cbtId, cbtName, sessHint, miss, have, rmin, rmax, title, detail, ctx }`. Delta Review's Accept/Defer gate and `deferred_gaps[]` still use it, unchanged until phase 5 retires that page (the DM's choice on #104)

**Round sanity checks (issue #104).** Nine pure functions over one combat in the 5.0.0 turn schema, each returning flags `{ check, cell: { combat, round, s?, actor_id?, activity? }, message, suggestedMove?: { to, label } }`. They are sanity checks, not controls: a flag has no blocking field and publish never runs them. `ctx` is `{ abilities: abilityContext(campaign, pcAbilities), names: partyNames(campaign), order? }`, where `order` is the confirmed initiative order `[{ s, a, from?, to? }]` from the round grid (#103). Two optional working fields on a slot feed two checks and are never written to the data: `source_line` (from #101) and `note_order` (where the notes listed the turn).

| Check | Flags |
|---|---|
| `imbalance` | In one round, one PC with two or more actions while another active PC has none; suggests moving it when only one is missing |
| `sourceLine` | A turn whose source line starts with a different PC's name or short form (Att, Asp, Gold) than its row; suggests "Move to <name as written>" |
| `abilityOwnership` | A spell (Magic · detail) or a bonus action, reaction or other feature not on that PC's list; suggests the one other PC who has it |
| `actionEconomy` | More than one action without Action Surge, or more than one bonus action, in a round; an enemy group with more actions than its starting `count`; a feature under the wrong economy (pc-abilities `action_economy`, plus Flurry of Blows, Cunning Action, Healing Word, Misty Step, Shield, Opportunity Attack, Absorb Elements) |
| `outcomeCount` | An activity whose detail or notes state a count ("3 Melee Attacks", "(x2)") that differs from its outcomes; a Flurry of Blows without two strikes |
| `state` | Acting after being downed (anything but Death Save or No Action) or killed, before joining (by `order.from`), or releasing a readied action with no Ready. A party blow counts at once; an enemy's effects count from the next round, and an enemy is judged by its state at the start of the round. A heal clears a downing, including one still pending from an enemy that round; a heal with no target heals the PCs its notes name; a downed PC whose own turn is a heal (a Goodberry) is back up. Enemy groups are not tracked |
| `roundOrder` | A round whose `note_order` does not follow the slot order |
| `duplicates` | The same activity, result and value (not null) in two cells of one round |
| `gaps` | An active PC (by `order`, or everyone seen in the combat) with no turn in a round; worded as often fine |

`roundChecks(combat, ctx)` runs all nine; `SANITY_CHECKS` lists their names. `abilityContext` merges each PC's harvested sheet (actions, spells, feats, action economy from `data/pc-abilities.json`) with every spell or feature the campaign already records them using, because the harvested lists are incomplete. `partyNames` gives each PC's name, nickname and aliases. The facts prompt (#101) asks the AI to run the checks that apply before initiative order exists on its own reply. No page shows the flags yet; the round grid (#103) will run `roundChecks` on every change. On the recorded campaign they raise six flags, each a real question about the data: Healing Word recorded as an action (`cbt_001` r3), Goli's "3 Melee Attacks" with two recorded (`cbt_002` r4), Del acting in `cbt_003` r9–11 after a heal that names no target, and three PCs without a turn in a round

---

### `shared/chronicle-ai.js`

Loaded by `intake.html`, `delta-review.html`, `integrity.html` and `session.html` via `<script src="../shared/chronicle-ai.js">`. The module reads the Anthropic API key from `window.CHRONICLE_CONFIG.anthropicApiKey` (set by `config.js`). Calls go directly from the browser to the Anthropic API using the `anthropic-dangerous-direct-browser-access` header — there is no server-side proxy for AI requests.

Model: `claude-sonnet-4-6`

Public API (`window.ChronicleAI`):
- `.call({system, messages, onResult, onError, onLoading, maxTokens})` — raw API call; `onResult(text, stopReason)`, and `maxTokens` overrides the 4096 default
- `.extractFacts({system, image, text})` — session page step 4 (#101): one page's facts, as a Promise of the raw reply. Adds the table's 2024 rules and the party's action-economy exceptions to the prompt; streamed, output limit 32,000 tokens, a cut-off reply retried once then rejected
- `.extractMentions({system, image, text})` — session page step 2 (#100): one page's mention list, as a Promise of the raw reply. Streamed (a dense page takes minutes, and a non-streamed request that long was dropped with HTTP 503), output limit 16,000 tokens; a reply cut off at the limit is retried once, then rejected. No demo fallback
- `.fillRoundsFromImage({images, combatName, combatId, sessionId, roundNumbers, ...})` — vision round extraction
- `.fillRoundsFromText({text, combatName, combatId, sessionId, roundNumbers, ...})` — text round transcription
- `.sendCorrectionToAI({correctionText, itemContext, scope, pendingItems, ...})` — delta correction assistant
- `.PARTY_ROSTER` — party nicknames string for injecting into prompts
- `.imageContent(source)` — builds an Anthropic image content block from a File, data-URL, or `{media_type, data}` object
- `.demoRoundProposals(roundNumbers, sessionId, source)` — demo data for offline testing
- `.demoCorrectionResponse(correctionText, itemContext)` — demo data for offline testing. No page shows it any more: Delta Review used it in place of a failed correction call, which made a failure look like a real answer; since #101 it shows the error instead

---

## Deployment

- **Host:** GitHub Pages, serving from the `main` branch root
- **Player URL:** `https://<username>.github.io/Chronicle-MagersCampaign/player/`
- **Admin URL:** `https://<username>.github.io/Chronicle-MagersCampaign/admin/log-viewer.html`
- **Deploy trigger:** Automatic on push to `main`. A Delta Review publish writes only the local file (#97), so Pages shows it once the DM commits and pushes from VS Code
- **Local:** the DM runs the admin pages from VS Code with Live Server (`http://127.0.0.1:5500/admin/…`). Publishing needs this, in Chrome or Edge
- `shared/config.js` is gitignored and must be present locally on each admin machine — it is never deployed to Pages. Without it the admin pages still load campaign data, but cannot call the Anthropic or Gemini API, and Safe Test Mode is off.

---

## Known issues and gaps

| Issue | File | Detail |
|---|---|---|
| AI round output is not the turn schema | `shared/chronicle-ai.js` | The round-fill prompts return their own flat per-roll format (`initiative_grid` entries with `action_type`, a literal action name and a free-text target). Publish converts it (#92), but the AI gives no spell/attack type, so an action that is neither a known spell nor a standard action is recorded as Attack and noted. #101 moves extraction itself to the turn schema. |
| Enemy actions are published as written | `shared/chronicle-publish.js` | The AI returns enemy actions as free text (`{desc, impact}`) with no group id, result or target. Publish assigns each line to a roster group (adding a group the notes name, or `Unidentified enemies` when none is named) and keeps the text as the activity's name, with no outcomes. Structured enemy turns arrive with #101. |
| Narrative notes item is not saved | `shared/chronicle-publish.js` | Intake's "Narrative notes" queue item (`narrative_text`) is reference text for the review. Publish used to push it as a session with no id; since #92 it writes nothing and says so in its notes. The session page keeps narrative as passages instead (#102); the old intake is retired in phase 5. |
| Derived fields only add | `shared/chronicle-publish.js` | `deriveFields()` adds computed values and never removes stored ones, because some hand-entered values (an NPC met outside combat, a place passed through) are not yet recorded anywhere it can see. A wrong stored value therefore survives a publish. Full recomputation becomes possible once passages and mentions are recorded (#100–#102). |
| Placeholder fill never overwrites | `shared/chronicle-publish.js` | Filling `session_006`/`session_007` writes only empty fields, because intake's stub dates itself to the day of intake. A deliberate change to a recorded title, date or summary is reported in the publish notes but not applied; make it with a MOD item or by hand. |
| Publishing needs Chrome or Edge on a local clone | `shared/chronicle-store.js` | The File System Access API is Chromium-only, and publish writes the clone on the DM's machine (#97). Firefox and Safari get a clear error. Phase 7's server-side API removes this. |
| A publish is not saved until committed | `data/magers-campaign.json`, `data/magers-campaign.prev.json` | Publish writes only the working copy; nothing reaches git or GitHub Pages until the DM commits and pushes. `.prev.json` holds one step back: a second publish before committing replaces it. |
| Session page stops after reading facts | `admin/session.html` | The page has steps 1–3 and reads each page's facts (#99–#101). The round grid, passages and publish are #102–#106, so what it builds is shown but not published; sessions still go through Session Intake and Delta Review. |
| Passages on rounds, activities and quest steps wait | `shared/chronicle-facts.js` | Those objects are written with the facts at publish (#106), so their passages are held until then; passages on entities, combats and the session are publish items already. |
| Passages are not shown in the viewers | `admin/log-viewer.html`, `player/index.html` | Neither viewer reads `passages` yet. Showing them, with testimony marked, is part of the player-view rollout in phase 7 of the build order. |
| Passage placement follows the AI | `shared/chronicle-facts.js` | The AI chooses each passage's attachment and speaker; until the review grid and entity pages (#103) can move one, a misplaced passage stays where it landed. In testing an NPC's remark about a pact went on the session because step 2 had not listed the pact as an entity, and a place description began with the party's arrival. |
| Sanity checks are not shown on any page yet | `shared/chronicle-integrity.js` | The nine checks (#104) work on turn-schema rounds; the session page's facts become those rounds in the round grid (#103), which will show the flags. Until then they run only in the tests. |
| Ability lists are from June | `data/pc-abilities.json` | The ability-ownership and action-economy checks read the sheets harvested on 26 June 2026. Run `node scripts/harvest-characters.js` before the backlog (the DM's step, #104). The sheets show current abilities, so an early session may pass one learned later. |
| Facts are not yet corrected or published | `shared/chronicle-facts.js` | The facts list is read-only. Misreadings stay until the round grid (#103) can fix them: on the real session 6 pages the AI read "Healing Hands" as "Iteraling Hinds", "Nat 1" as "Not 1", and recorded the goblins' "Hit - Dragon, Dragon, Oregon" line as an event rather than attacks. The AI's self-check notes list most of these. |
| Integrity's round fill keeps the fixed slot roster | `shared/chronicle-ai.js` (`fillRoundsFromText`) | Its prompt still says slot 1 = Goldie … slot 6 = Att, the cause of misplaced turns. The session page does not use it; left until phase 5 retires the old pages (the DM's choice on #101). |
| A player's absence is not recorded from the notes | `shared/chronicle-facts.js` | A line such as "Lance out work, played by David" is not a turn; the facts call records it as an event at best. Recording it as a session `player_absence` note is not in #101's scope. |
| Roster groups cannot hold aliases | `shared/chronicle-entities.js` | A spelling linked to a roster group ("Slinge" → Goblin Slingers) is used for this session but not saved, because `aliases` exists only on entities (#93). The same spelling is an inexact match again next session. |
| Two copies of name matching | `admin/delta-review.html`, `shared/chronicle-entities.js` | Delta Review keeps its own name index and duplicate check (#56) and cohort matching (#62); the session page uses `chronicle-entities.js`. Left so today's workflow does not change mid-rebuild (the DM's choice on #100); Delta Review's copy goes with the page in phase 5. |
| Identification flags read the AI's tags | `shared/chronicle-entities.js` | Acting twice, two places and ally-and-enemy are worked out from the turn, scene, location and allegiance the AI tags each mention with, because facts do not exist yet at step 3. A mistagged mention can raise or miss a flag; #101 and #104 add checks on the extracted facts. |
| Intake cannot reorder pages | `admin/intake.html` | Pages are read in the order they were added, and a row cannot be moved; the notice now says so (#71). Reordering was built into the session page instead (#99), because intake is retired with phase 5. |
| Intake files every session as `session_006` | `admin/intake.html` | Intake reads a session ID field that is not on the page, so it falls back to `session_006` and dates the stub to the day of intake. The session page picks both at upload (#99); intake is retired with phase 5 rather than fixed. |
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
| Log editor edits are in-memory only | `admin/log-editor.html` | No write-back to JSON. Changes are lost on page reload. |
| Player view links to admin | `player/index.html` | Has a "⇄ Admin" button linking to `../admin/log-viewer.html`. |
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
├── integrity.test.js               # Tests for shared/chronicle-integrity.js (gap detection)
├── sanity-checks.test.js           # Round sanity checks (#104) — one per check on the fixture; Cure Wounds in Goli's row; cbt_002 round 4; never blocks
├── intake-image.test.js            # Group A — OCR round-data shape validation
├── intake-preparation.test.js      # Group C — session data preparation checks
├── delta-schema.test.js            # Group E — delta item schema validation
├── delta-apply.test.js             # shared/chronicle-publish.js (#92): turn schema, enemy turns, sessions, derived fields, merges, IDs; gate through both viewers
├── store.test.js                   # shared/chronicle-store.js — paths, local-file publishing (fake folder), no GitHub or Drive calls, Safe Test Mode
├── turn-schema.test.js             # 5.0.0 turn schema — migration rules, converted data, both normalisers
├── bestiary-fold.test.js           # Goblin Slinger fold (#94) — no mon_006, roster roles, both normalisers
├── opaque-ids.test.js              # Opaque ids (#95) — helpers, reference check, migrated data, both normalisers
├── session-header.test.js          # Session page upload step (#99) — session choices, header through applySession, nav bar
├── entity-identification.test.js   # Entity identification (#100) — rows, exact/inexact/new, actions, flags, aliases/notes/roster groups through applySession
├── fact-extraction.test.js         # Per-page facts (#101) and passages (#102) — references, prompt, validation (occurrences only), checks, merge across pages, passages through applySession
├── fixtures/
│   └── test-campaign.json          # Minimal v5.0.0 synthetic campaign — no real data
├── output/                         # GITIGNORED — test-campaign.published.json from a Safe Test Mode publish (#97)
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

`shared/config.js` (gitignored) holds the settings below. `shared/chronicle-store.js` applies them; no page checks them itself:

| Field | Default | Purpose |
|---|---|---|
| `safeTestMode` | `false` | When `true`, all reads and publishes target test data |

When `safeTestMode: true`:
- `ChronicleStore.loadCampaign()` reads `../tests/output/test-campaign.published.json` when a test publish has written it, and `../tests/fixtures/test-campaign.json` otherwise, instead of the repo file. The admin log viewer therefore shows a test publish; delete `tests/output/` to go back to the fixture
- `ChronicleStore.loadPublishBase()` builds on `tests/fixtures/test-campaign.json`, and `.publishSession()` writes only `tests/output/test-campaign.published.json` (git-ignored). It never writes the fixture, which the automated tests depend on, or `data/magers-campaign.json`, and makes no `.prev` copy (#97)

Switching test mode on or off requires changing only `config.js`. Older copies of `config.js` may still define `proxyUrl`, `campaignFileId`, `testCampaignFileId` and the `getCampaignPath()` / `getCampaignFileId()` resolvers. Nothing reads or calls them since #98; they can be deleted.

**Never commit `safeTestMode: true`** — it would redirect all data reads for anyone who deploys the page locally.

### Test fixture

`tests/fixtures/test-campaign.json` is a minimal v5.0.0 campaign with synthetic data (no real Magers campaign content). It contains: 2 party members, 2 sessions, 1 combat (3 rounds with known content), 3 NPCs, 2 quests, 2 items, 2 locations. All automated tests run against this fixture. Since #95 its entities have UUID ids with their old typed IDs as `legacy_id`, like the real file; its two quest objectives never had ids and still have none.

---

## Updating this document

This README is regenerated from source using Claude Code. To update it after making changes to Chronicle, run the prompt in `docs/chronicle-docs-prompt.md` from the repository root in Claude Code. That prompt reads every file and rewrites both README.md and CLAUDE.md in one pass.
