# Chronicle — Magers Campaign
## Project context for Claude Code

---

## What this is

Chronicle is a DM tool and campaign log manager for the Magers D&D 5e campaign.
It is a vanilla HTML/CSS/JS web app with no framework, no bundler, no npm dependencies.
It is hosted on GitHub Pages and uses a Google Apps Script proxy for Google Drive integration.

---

## Repo structure

```
Chronicle-MagersCampaign/
├── index.html              # Root redirect → player/
├── player/
│   └── index.html          # Player-facing log (shareable, no admin tools)
├── admin/
│   ├── log-viewer.html     # Campaign log with Drive sync (main admin screen)
│   ├── intake.html         # Session intake / OCR pipeline
│   ├── glossary.html       # OCR hints glossary
│   ├── delta-review.html   # Post-session delta review and publish to Drive
│   ├── integrity.html      # Combat round integrity checker / gap filler
│   ├── log-editor.html     # Direct campaign data editor
│   ├── versions.html       # Version manager / Drive backups
│   └── drive-test.html     # Drive proxy diagnostics (8 tests)
├── shared/
│   ├── config.js           # Drive credentials — single source of truth
│   └── chronicle-ai.js     # Shared Anthropic API module
├── data/
│   └── magers-campaign.json  # Campaign data (source of truth)
└── scripts/
    └── build.js            # Rebuilds EMBEDDED_DATA in HTML files from JSON
```

---

## Critical conventions — do not break these

### Drive integration
- Proxy URL and campaign file ID live ONLY in `shared/config.js` as `window.CHRONICLE_CONFIG`
- Never hardcode these values in individual HTML files
- All admin HTML files load `../shared/config.js` before any other script
- GET requests for all Drive operations EXCEPT writes (GET avoids CORS preflight)
- Writes use POST with `Content-Type: text/plain` (a CORS simple type, no preflight)
- The proxy is scoped to folder `1BJQxOS4MspOlPzCt70r7zOY_8LnwAwPY` only

### EMBEDDED_DATA
- Both `admin/log-viewer.html` and `player/index.html` contain a full copy of the
  campaign data as `const EMBEDDED_DATA = { ... }; // end EMBEDDED_DATA`
- These markers are used by `scripts/build.js` to find and replace the block
- ALWAYS run `node scripts/build.js` after editing `data/magers-campaign.json`
- Never manually edit EMBEDDED_DATA in the HTML — it is generated, not authored

### No framework rule
- This project uses zero npm packages, zero build steps (except build.js for EMBEDDED_DATA)
- Do not introduce React, Vue, webpack, Vite, or any bundler
- Do not introduce npm dependencies
- External CDN links are acceptable (D3, Google Fonts, JetBrains Mono)

### Theme
- All screens use Arcane Night theme: `--bg:#0f1020`, `--gold:#d4af37`, `--text:#f0e8d0`
- CSS variables are defined at `:root` in each file (not a shared stylesheet yet)
- Never revert to the old Parchment theme values

### Navigation
- All admin pages share a 7-item nav: Session Intake → OCR Glossary → Delta Review →
  Integrity → Campaign Log → Log Editor → Versions
- Nav links use `onclick="window.location='filename.html'"` (same-folder relative)
- The player view has NO nav links to admin files

---

## Campaign data schema

File: `data/magers-campaign.json`  
Schema version: `3.3.0`

### Key IDs (do not reuse)
- Party: `pc_001`–`pc_006`
- NPCs: `npc_001`, `npc_003`, `npc_004`, `npc_007`–`npc_013` (gaps: npc_002, 005, 006)
- Locations: `loc_001`–`loc_013` (gaps: loc_008–010 are Atticus's Clearing, Sholes Ford,
  Western Unknown — loc_011/012 are Lake Town/Green Harbor)
- Quests: `qst_001`–`qst_005`
- Items: `item_001`–`item_010`
- Combats: `cbt_001`–`cbt_006`
- Bestiary: `mon_001`–`mon_008` (gaps: mon_002/003/005–008 are the new entries)
- Lore: `lore_001`–`lore_002`

### Next available IDs
- NPC: `npc_014`
- Location: `loc_014`
- Quest: `qst_006`
- Item: `item_011`
- Combat: `cbt_007`
- Session: `session_006`
- Bestiary: `mon_009`
- Lore: `lore_003`

### Combat encounters format (viewer format)
The `combat_encounters` array uses compact slot format:
```json
{
  "id": "cbt_001",
  "sessions": ["session_002"],
  "location_id": "loc_007",
  "rounds": [
    {
      "n": 1,
      "sid": "session_002",
      "slots": [{"s": 1, "a": "pc_001", "act": "Firebolt", "res": "hit", "val": "4"}],
      "enemy": [{"desc": "Rock Lobster attacks Goldie", "impact": "8 damage"}]
    }
  ]
}
```
`cbt_006` (Wolf Fight) has `rounds: []` — detail pending.

### normaliseCampaignJson field mappings
When the viewer reads the JSON, these fields are renamed:
- `session_id` → `id`
- `session_date` → `date`
- `narrative_vibe` kept as-is (viewer reads `s.narrative_vibe`)
- `class` → `cls`
- `progress_log` entries `{session_id, entry}` → `{s, e}`
- `location_id` → `location` (added to each combat)
- `npc_directory` → `npcs` (passed through directly)
- `world_lore` → `lore`
- `quest_ledger` → `quests`
- `inventory_and_loot` → `items`
- `current_holder_id` → `holder`
- `session_found` or `origin_session` → `session`
- `is_quest_item` → `quest` (boolean)

---

## Drive proxy (Google Apps Script)

Deployed at: see `shared/config.js`  
Folder scope: `1BJQxOS4MspOlPzCt70r7zOY_8LnwAwPY` (campaign folder only)

### API
- `GET ?action=read&id=FILE_ID` → `{ok:true, raw:"<json string>"}`
- `GET ?action=backup&id=FILE_ID&label=pre-session_006` → `{ok:true, backupId, name}`
- `GET ?action=listBackups&id=FILE_ID` → `{ok:true, backups:[{id,name,modified,size}]}`
- `GET ?action=diagnose&id=FILE_ID` → `{ok:true, diagnostics:{name,mimeType,size}}`
- `POST Content-Type:text/plain` body `{action:"write",fileId,data:{...}}` → `{ok:true}`

The client always parses `json.raw` for read responses — the proxy returns the file
content as a raw string, NOT pre-parsed, to avoid server-side JSON encoding issues.

---

## Shared AI module (shared/chronicle-ai.js)

Loaded by: intake.html, delta-review.html, integrity.html

Exports on `window.ChronicleAI`:
- `ChronicleAI.call({system, messages, onResult, onError, onLoading})`
- `ChronicleAI.fillRoundsFromImage(imageDataURL, context)` — integrity checker
- `ChronicleAI.fillRoundsFromText(text, context)` — integrity checker
- `ChronicleAI.sendCorrectionToAI(delta, context)` — delta review
- `ChronicleAI.PARTY_ROSTER` — string of party nicknames for AI context
- `ChronicleAI.imageContent(dataURL)` — builds Anthropic image content block

Model: `claude-sonnet-4-20250514`  
API key: injected by Claude.ai environment (no key needed in code)

---

## The party (Magers Campaign)

| ID | Name | Nick | Class | Player |
|---|---|---|---|---|
| pc_001 | Zragar | Goldie | Wizard Lv2 | David |
| pc_002 | Malachite | Mal | Barbarian Lv2 | Lance |
| pc_003 | Ashton | Ash | Warlock Lv2 | Frazer |
| pc_004 | Asphodel | Del | Monk Lv2 | Kevin |
| pc_005 | Derwin | Goli | Rogue Lv2 | Sam |
| pc_006 | Atticus | Atti | Druid Lv2 | Jamie |

DM: John Magers | Sessions logged: 5 | Current arc: traveling west toward Lake Town

---

## Known open items (as of session 005)

- `cbt_006` Wolf Fight: rounds pending — to be filled when DM provides notes
- `pc_003` Ashton: notes field empty — no character details recorded yet
- `npc_013` The Low-Level Wizard: no proper name recorded, no session link
- `qst_003` Escort to Lake Town: no objectives, no narrative_motivation — active
- `cbt_005` Goblin Ambush: outcome `paused` — continues session_006
- Ched's Map markers `loc_009` (Sholes Ford/Fish), `loc_010` (Western ?),
  `loc_013` (Southern X): no context beyond map location

---

## Workflow for a new session

1. Run Session Intake (`admin/intake.html`) — upload photos, get OCR'd round text
2. Run Delta Review (`admin/delta-review.html`) — review and approve changes
3. Click Publish — backs up Drive file, applies deltas, writes new JSON to Drive
4. Download updated JSON from Drive → replace `data/magers-campaign.json`
5. Run `node scripts/build.js` — rebuilds EMBEDDED_DATA in both viewer and player
6. Commit and push — GitHub Pages deploys automatically

---

## Sync indicator logic

`shared/config.js` contains `embeddedDataDate`.  
`data/magers-campaign.json` contains `meta.last_updated`.  
When Drive date > embedded date, the sync bar in the admin viewer turns amber.  
Update `meta.last_updated` in the JSON whenever campaign data changes.  
`node scripts/build.js` updates `embeddedDataDate` in `shared/config.js` automatically.
