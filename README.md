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
│   └── chronicle-ai.js         # Shared Anthropic API module — exports window.ChronicleAI
├── data/
│   └── magers-campaign.json    # Campaign data — single source of truth, schema version 4.0.0
├── scripts/
│   └── build.js                # STALE — injected EMBEDDED_DATA into HTML files; markers removed in Phase 1, script is now dead code
├── notes/
│   └── phase1-claude-code-prompt.md  # Historical prompt used to migrate data reads from Drive to repo fetch
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

### Field name mappings (v4 JSON → normalised viewer shape)

The `normaliseCampaignJson` function (identical copies in `admin/log-viewer.html` and `player/index.html`) translates v4 paths at runtime. The renderers consume the normalised shape and are not aware of the v4 sub-object structure.

| v4 JSON path | Viewer field | Notes |
|---|---|---|
| `session_logs[].id` | `sessions[].id` | was `session_id` in v3 |
| `session_logs[].date` | `sessions[].date` | was `session_date` in v3 |
| `session_logs[].narrative.summary` | `sessions[].summary` | was root-level in v3 |
| `session_logs[].narrative.tone` | `sessions[].narrative_vibe` | was root-level in v3 |
| `session_logs[].narrative.key_moments[].description` | `sessions[].key_moments[]` (string) | v4 moments are objects; normaliser flattens to string array |
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
- Uses `ChronicleAI.call()` with vision to extract handwritten combat notes from uploaded images
- Does not fetch `magers-campaign.json` — operates on uploaded image data only
- "Send to Delta Review" button navigates to `delta-review.html`

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
- Loads `../shared/config.js` and `../shared/chronicle-ai.js`
- Uses `ChronicleAI.sendCorrectionToAI()` to refine individual delta items via an AI assistant chat panel
- **Publish** action: fetches current campaign JSON from Drive (not from `/data/`), applies approved deltas, writes the result back to Drive via the proxy
- Approval workflow: each queue item can be Approved, Rejected, or sent for AI correction. Items include session metadata, NPC entries, location entries, combat rounds, and quest updates
- Does not read from `data/magers-campaign.json` — the DM downloads the Drive copy and manually replaces the repo file after review

---

### `admin/integrity.html` — Integrity Checker

- **URL:** `https://<user>.github.io/Chronicle-MagersCampaign/admin/integrity.html`
- **Audience:** DM only
- Checks combat entries for missing round data and provides a workflow to fill gaps using AI
- Loads `../shared/config.js` and `../shared/chronicle-ai.js`
- Has a debug/log panel (TP panel) showing raw AI prompts and responses
- Uses `ChronicleAI.fillRoundsFromImage()` for photo-based round extraction and `ChronicleAI.fillRoundsFromText()` for typed descriptions
- Fetches `../data/magers-campaign.json` at init to populate the combat selector; shows an error state if fetch fails
- Includes a "LLM Log" panel showing raw prompt/response traffic for debugging

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

## Shared AI module — `shared/chronicle-ai.js`

Loaded by `intake.html`, `delta-review.html`, and `integrity.html` via `<script src="../shared/chronicle-ai.js">`. The module reads the Anthropic API key from `window.CHRONICLE_CONFIG.anthropicApiKey` (set by `config.js`). Calls go directly from the browser to the Anthropic API using the `anthropic-dangerous-direct-browser-access` header — there is no server-side proxy for AI requests.

Model: `claude-sonnet-4-20250514`

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
| `scripts/build.js` is dead code | `scripts/build.js` | EMBEDDED_DATA markers were removed from all HTML files in Phase 1. Running the script produces "SKIP (markers not found)" warnings and changes nothing. |
| Log editor edits are in-memory only | `admin/log-editor.html` | No write-back to JSON or Drive. Changes are lost on page reload. |
| Player view links to admin | `player/index.html` | Has a "⇄ Admin" button linking to `../admin/log-viewer.html`. |
| drive-test campaign-read test obsolete | `admin/drive-test.html` | Tests `?action=read` on the proxy, which the main app no longer calls. |
| cbt_006 Wolf Fight has no rounds | `data/magers-campaign.json` | `rounds: []` — combat detail is pending. |
| npc_013 has no name | `data/magers-campaign.json` | The Low-Level Wizard: no proper name, no session link. |
| qst_003 Escort to Lake Town incomplete | `data/magers-campaign.json` | No objectives, no narrative.motivation — currently active. |
| loc_009, loc_010, loc_013 are stubs | `data/magers-campaign.json` | Map markers only — no description or context. |

---

## Updating this document

This README is regenerated from source using Claude Code. To update it after making changes to Chronicle, run the prompt in `docs/chronicle-docs-prompt.md` from the repository root in Claude Code. That prompt reads every file and rewrites both README.md and CLAUDE.md in one pass.
