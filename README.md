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
│   ├── config.js               # GITIGNORED — Drive proxy URL, campaign file ID, Anthropic API key
│   ├── chronicle-ai.js         # Shared Anthropic API module — exports window.ChronicleAI
│   └── chronicle-integrity.js  # Shared gap-detection module — exports window.ChronicleIntegrity
├── data/
│   └── magers-campaign.json    # Campaign data — single source of truth, schema version 4.0.0
├── scripts/
│   └── build.js                # STALE — injected EMBEDDED_DATA into HTML files; markers removed in Phase 1, script is now dead code
├── notes/
│   └── phase1-claude-code-prompt.md  # Historical prompt used to migrate data reads from Drive to repo fetch
├── docs/
│   └── chronicle-issue-prompt.md     # Reusable five-phase prompt template for completing GitHub issues
├── tests/
│   ├── run-all.js                    # Test runner — runs all test files, reports pass/fail summary
│   ├── integrity.test.js             # Tests for shared/chronicle-integrity.js
│   ├── intake-image.test.js          # Group A — OCR round-data shape validation
│   ├── intake-preparation.test.js    # Group C — session data preparation checks
│   ├── delta-schema.test.js          # Group E — delta item schema validation
│   ├── fixtures/
│   │   └── test-campaign.json        # Minimal v4.0.0 synthetic campaign for automated tests
│   ├── ocr-ground-truth/             # Ground-truth image+JSON pairs for OCR accuracy testing
│   └── ai-input-fixtures/            # Captured AI response fixtures for offline test runs
├── .gitignore                  # Ignores shared/config.js
├── CLAUDE.md                   # Behavioural instructions for Claude Code
└── README.md                   # This file
```

---

## Data architecture

```
DATA READS  → /data/magers-campaign.json  (same-origin fetch, served by GitHub Pages)
DATA WRITES → Google Drive via Apps Script proxy  (delta-review publish, backups)
APP HOSTING → GitHub Pages  (Chronicle-MagersCampaign repo)
```

Campaign data lives in `data/magers-campaign.json`. Both the admin log-viewer and player view fetch this file directly using `fetch('../data/magers-campaign.json')` at page load — no proxy, no CORS. Updating the JSON and pushing to GitHub triggers an automatic Pages redeploy; both views pick up the new data on next load.

Drive proxy is used for:
- Writing updated JSON to Drive after a Delta Review publish
- Creating named Drive backups before sessions
- Listing Drive backups in the Versions page

**Intake → Delta Review hand-off via sessionStorage:**  
When the DM clicks "Send to Delta Review" in `intake.html`, the page writes a `chronicle_intake_delta` envelope to `sessionStorage` and navigates to `delta-review.html`. Delta Review reads and clears this key on load (`loadIntakeDelta()`), replacing the empty `items[]` queue with the intake-sourced delta items. If no key is present (direct navigation), Delta Review starts with an empty queue as before.

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

`RAW` items carry confirmed OCR text as `rawData.ocr_text` and are not interpreted as combat round data — `buildIncomingFromItems()` filters these out (requires `combatId && roundNumber != null`), so they produce zero integrity gaps. `nlRender()` on a RAW item displays the raw OCR text in a pre-formatted block for DM review.

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
Schema version: `4.0.0` (stored as `_schema_version` at root)

v4 introduced a `mechanics`/`narrative` two-layer pattern on every entity type. Mechanical facts (queryable, structured) live in `mechanics`; prose for human readers lives in `narrative`. The `normaliseCampaignJson` function translates v4 paths into the flat shape the renderers already expect — the rendering code is unchanged.

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
| `combat_encounters` | Combats; outcome/location/sessions in `mechanics`, setup/finale/aftermath in `narrative`; slots have nested `action` object; enemy turns use `enemy_turns[]` |
| `deferred_gaps` | Workflow state array written by delta-review when the DM defers an integrity gap. Each entry: `{ id, combat_id, combat_name, session_id, missing_rounds[], gap_type, deferred_at, status }`. Not campaign narrative — persists alongside the JSON so the future campaign scanner can surface pending entries as a correction queue. |
| `prompt_improvement_log` | Workflow state array written by delta-review publish when the DM logged steering context during an OCR re-run in Session Intake. Each entry: `{ id, session_id, page_index, steering_text, failure_summary, corrected, logged_at, status }`. IDs use `pil_NNN` prefix. `status` starts as `'pending_review'`. Not campaign narrative — captures OCR prompt failure cases for future prompt improvement review (placeholder UI in `integrity.html`). |
| `entity_relationships` | Root-level array for explicit relationship records between any two entities (PCs, NPCs, locations, quests, etc.). Each entry: `{ id, source_id, target_id, relationship_type, session_id, notes }`. Starts empty; populated by future admin tooling. `relationship_type` uses a controlled vocabulary: `combat_antagonist`, `allied`, `quest_connection`, `location_inhabitant`, `social_contact`, `witnessed`, `unknown`. IDs use `rel_NNN` prefix. |

### Field name mappings (v4 JSON → normalised viewer shape)

The `normaliseCampaignJson` function (identical copies in `admin/log-viewer.html` and `player/index.html`) translates v4 paths at runtime. The renderers consume the normalised shape and are not aware of the v4 sub-object structure.

| v4 JSON path | Viewer field | Notes |
|---|---|---|
| `session_logs[].id` | `sessions[].id` | was `session_id` in v3 |
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
| `rounds[].slots[].action.name` | `rounds[].slots[].act` | v4 nests action; normaliser flattens |
| `rounds[].slots[].action.res` | `rounds[].slots[].res` | v4 nests action; normaliser flattens |
| `rounds[].slots[].action.val` | `rounds[].slots[].val` | v4 nests action; normaliser flattens |
| `rounds[].enemy_turns[]` | `rounds[].enemy[{desc, impact}]` | v4 richer structure; normaliser builds desc/impact strings |
| `world_lore[].narrative.content` | `lore[].content` | was root-level in v3 |
| `world_lore[].mechanics.reliability` | `lore[].reliability` | was root-level in v3 |
| `bestiary[].mechanics.reliability` | `bestiary[].reliability` | was root-level in v3 |
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

### Combat viewer format (compact slots)

```
rounds[n].slots[{ s, a, act, res, val?, notes? }]
rounds[n].enemy[{ desc, impact? }]
```

`s` = slot number (1–6), `a` = actor_id, `act` = action name, `res` = result (hit/miss/crit/save/success/neutral/unclear), `val` = damage or value, `notes` = optional string.

### ID registry

| Entity | In use | Gaps (voided) |
|---|---|---|
| Party | pc_001–pc_006 | — |
| NPCs | npc_001, npc_003, npc_004, npc_007–npc_013 | 002, 005, 006 voided |
| Locations | loc_001–loc_013 | — |
| Quests | qst_001–qst_005 | — |
| Items | item_001–item_010 | — |
| Combats | cbt_001–cbt_006 | — |
| Bestiary | mon_001–mon_008 | — |
| Lore | lore_001–lore_002 | — |
| Sessions | session_001–session_005 | — |

Next available: `npc_014`, `loc_014`, `qst_006`, `item_011`, `cbt_007`, `session_006`, `mon_009`, `lore_003`

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
- Fetches `../data/magers-campaign.json` at init using `fetch()`
- Two views toggled by header buttons: **Browse** and **Graph**
- **Browse view:** Left sidebar with search box, category filter pills, and entity list grouped by type. Right area shows entity detail cards with relationship chips, timelines, quest progress, and full combat round tables
- **Graph view:** D3.js (v7.9, cdnjs CDN) force-directed graph of entities. Toolbar with legend, Reset View button, Focus Party button. Click a node to open a side panel with entity summary
- Header has a "⇄ Admin" button linking to `../admin/log-viewer.html`
- On load failure, shows an error status — no silent fallback

---

### `admin/log-viewer.html` — Campaign log (admin view)

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/log-viewer.html`
- **Audience:** DM only
- Fetches `../data/magers-campaign.json` at init using `async/await fetch()`
- Loads D3.js (v7.9, cdnjs CDN) and `../shared/config.js`
- Identical UI structure to player view: Browse + Graph views, sidebar, entity detail cards
- 7-item admin nav bar; "⇄ Player View" button to `../player/`
- On load failure, shows an error panel with message and copy-to-clipboard option

---

### `admin/intake.html` — Session Intake

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/intake.html`
- **Audience:** DM only
- Three-step wizard: (1) upload session photos, (2) review OCR output page-by-page, (3) consolidate into session document
- Loads `../shared/config.js` and `../shared/chronicle-ai.js`
- Uses `ChronicleAI.call()` with vision to extract handwritten combat notes from uploaded images; images are compressed to ≤1800px before sending to stay within the Anthropic 5MB base64 limit
- Does not fetch `magers-campaign.json` — operates on uploaded image data only
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
- Loads `../shared/config.js`, `../shared/chronicle-integrity.js`, and `../shared/chronicle-ai.js`
- Uses `ChronicleAI.sendCorrectionToAI()` to refine individual delta items via an AI assistant chat panel
- On load, calls `loadIntakeDelta()` — if a `chronicle_intake_delta` key exists in sessionStorage (written by `intake.html` "Send to Delta Review"), the envelope items replace the default empty queue and a banner identifies the session source. If no key exists, the queue is empty as usual.
- **Integrity pre-flight panel**: on load, fetches `../data/magers-campaign.json` and runs `ChronicleIntegrity.checks()` against the staged session data. If gaps are found, an integrity panel appears in the center area before the review queue. Each gap presents three options: **Accept** (acknowledged, no record written), **Defer** (flagged for future correction — written to `deferred_gaps[]` in the published JSON), or **Edit** (AI-assisted fill via image or typed description; approved proposals join the approval queue). The Publish button is blocked until every gap has an explicit Accept or Defer decision. The **Reprocess** sub-option under Edit is a disabled placeholder — see code comments for design decisions required before building
- **Publish** action: fetches current campaign JSON from Drive (not from `/data/`), applies approved deltas, appends any deferred gap records to `deferred_gaps[]`, then writes the result back to Drive via the proxy
- Approval workflow: each queue item can be Approved, Rejected, or sent for AI correction. Items include session metadata, NPC entries, location entries, combat rounds, and quest updates
- Does not read campaign data from Drive for the integrity check — uses `../data/magers-campaign.json` (same-origin repo copy). The Drive copy and repo copy can diverge; integrity checks against whichever is currently in the repo

---

### `admin/integrity.html` — Campaign Integrity (placeholder)

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/integrity.html`
- **Audience:** DM only
- Fetches `../data/magers-campaign.json` at init. Loads `../shared/config.js`, `../shared/chronicle-integrity.js`, and `../shared/chronicle-ai.js`
- The intake gap-checker that formerly lived here was moved to `delta-review.html` (Phase B). This page is now a placeholder shell for the future campaign quality scanner
- The **Run Scan** button is present but disabled — functionality is not yet implemented. When built, this tool will surface structural gaps and quality improvement opportunities across the full campaign JSON. It will also display the `deferred_gaps[]` queue (entries created when the DM chose Defer during a delta-review session)
- See the page script comments for the full planned feature set (scan types, output format, write-back options)

---

### `admin/log-editor.html` — Log Editor

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/log-editor.html`
- **Audience:** DM only
- In-browser editor for party, NPC, location, quest, item, and lore entries
- Loads `../shared/config.js`
- Fetches `../data/magers-campaign.json` at init and rebuilds the ENTITIES list from live v4 JSON; shows a toast error (rather than silently falling back) if fetch fails
- Loads `../shared/config.js` and `../shared/chronicle-ai.js` — AI draft panel (`ChronicleAI.call()`) is wired and available
- Edits are applied to the in-memory ENTITIES array only — there is no write-back to the JSON file or Drive. "Save" commits changes locally within the browser session; they are lost on page reload
- The `previewChanges()` function shows an alert describing pending edits; it does not produce a real JSON diff or write to any file

---

### `admin/versions.html` — Version Manager

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/versions.html`
- **Audience:** DM only
- Manages a local backup ledger (stored in `localStorage`) and syncs with Drive backups
- Loads `../shared/config.js`
- Fetches backup list from Drive via proxy; can download any Drive backup as a JSON file
- "Pre-session backup" action: calls `fetchCampaignFromDrive()` (reads from Drive, not from `/data/`) to compute stats, then writes a backup copy to Drive
- Backup ledger stored in browser `localStorage` — cleared if the user clears site data

---

### `admin/drive-test.html` — Drive Diagnostics

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/drive-test.html`
- **Audience:** DM only (for debugging Drive proxy issues)
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

### `shared/chronicle-integrity.js`

Loaded by `delta-review.html` and `integrity.html`. Exports `window.ChronicleIntegrity` with a single method:

- `.checks(campaignData, incomingData)` — pure gap-detection function. Takes a campaign object and an array of incoming delta items; returns a flat array of gap objects. No DOM access, no API calls. Load order when all three shared modules are needed: `config.js` → `chronicle-integrity.js` → `chronicle-ai.js` → page script.

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
├── fixtures/
│   └── test-campaign.json          # Minimal v4.0.0 synthetic campaign — no real data
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

`shared/config.js` (gitignored) contains two fields and two resolver functions that redirect data reads and Drive writes to test targets:

| Field | Default | Purpose |
|---|---|---|
| `safeTestMode` | `false` | When `true`, all reads and Drive writes target test data |
| `testCampaignFileId` | `''` | Drive file ID of the test campaign copy |

When `safeTestMode: true`:
- `getCampaignPath()` returns `'../tests/fixtures/test-campaign.json'` instead of `'../data/magers-campaign.json'`
- `getCampaignFileId()` returns `testCampaignFileId` instead of `campaignFileId`

All HTML pages call these resolvers rather than using hardcoded paths. This means switching test mode on or off requires changing only `config.js`.

**Never commit `safeTestMode: true`** — it would redirect all data reads for anyone who deploys the page locally.

### Test fixture

`tests/fixtures/test-campaign.json` is a minimal v4.0.0 campaign with synthetic data (no real Magers campaign content). It contains: 2 party members, 2 sessions, 1 combat (3 rounds with known content), 3 NPCs, 2 quests, 2 items, 2 locations. All automated tests run against this fixture.

---

## Updating this document

This README is regenerated from source using Claude Code. To update it after making changes to Chronicle, run the prompt in `docs/chronicle-docs-prompt.md` from the repository root in Claude Code. That prompt reads every file and rewrites both README.md and CLAUDE.md in one pass.
