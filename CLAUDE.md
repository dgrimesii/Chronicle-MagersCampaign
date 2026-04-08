# Chronicle — Magers Campaign
## Project context for Claude Code

---

## What this is

Chronicle is a DM tool and campaign log manager for the Magers D&D 5e campaign.
Vanilla HTML/CSS/JS web app. No framework, no bundler, no npm dependencies.
Hosted on GitHub Pages. Campaign data is read from the repo itself.
Write operations (publishing session updates) still use the Google Drive proxy.

---

## Current architecture (Phase 1)

```
DATA READS  → /data/magers-campaign.json  (same-origin, served by GitHub Pages)
DATA WRITES → Google Drive via Apps Script proxy  (Delta Review publish, backups)
APP HOSTING → GitHub Pages  (Chronicle-MagersCampaign repo)
```

Phase 1 changes from the original Drive-only design:
- Data reads moved from Drive proxy to same-origin fetch
- EMBEDDED_DATA removed from all HTML files
- The sync indicator bar removed
- scripts/build.js removed — no longer needed
- Drive proxy retained for writes only

---

## Repo structure

```
Chronicle-MagersCampaign/
├── index.html              # Root redirect → player/
├── player/
│   └── index.html          # Player-facing log (shareable, no admin tools)
├── admin/
│   ├── log-viewer.html     # Campaign log — fetches data from /data/ on init
│   ├── intake.html         # Session intake / OCR pipeline
│   ├── glossary.html       # OCR hints glossary
│   ├── delta-review.html   # Post-session delta review and Drive publish
│   ├── integrity.html      # Combat round integrity checker / gap filler
│   ├── log-editor.html     # Direct campaign data editor
│   ├── versions.html       # Version manager / Drive backups
│   └── drive-test.html     # Drive proxy diagnostics (write path only)
├── shared/
│   ├── config.js           # Drive write credentials — single source of truth
│   └── chronicle-ai.js     # Shared Anthropic API module
└── data/
    └── magers-campaign.json  # Campaign data — single source of truth
```

scripts/ directory and build.js have been removed.

---

## Critical conventions — do not break these

### Data loading (Phase 1 pattern)
- Viewer and player fetch campaign data from the repo: `../data/magers-campaign.json`
  from admin files; `./data/magers-campaign.json` or root-relative from player/
- Standard fetch() — no proxy, no CORS headers needed (same origin on GitHub Pages)
- There is NO EMBEDDED_DATA block in any HTML file
- There is NO sync bar or sync indicator
- If the fetch fails, show a clear error state — do not silently fall back to stale data

### Data loading implementation pattern
```javascript
async function loadCampaignData() {
  const res = await fetch('../data/magers-campaign.json');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  return normaliseCampaignJson(json);
}
```

### Updating campaign data
When data/magers-campaign.json changes:
1. Update meta.last_updated to today's date
2. Commit and push to main
3. GitHub Pages redeploys automatically — no build step required
The player view and admin view both read the same file; one commit updates both.

### Drive integration (writes only)
- Proxy URL and campaign file ID live ONLY in shared/config.js as window.CHRONICLE_CONFIG
- Never hardcode these in individual HTML files
- Admin files that write use: ../shared/config.js loaded before other scripts
- GET for all Drive operations except writes (avoids CORS preflight)
- Writes use POST with Content-Type: text/plain (CORS simple type, no preflight)
- Proxy scoped to folder 1BJQxOS4MspOlPzCt70r7zOY_8LnwAwPY only
- Drive used for: write-back after Delta Review publish, backup copies, listBackups

### No framework rule
- Zero npm packages, zero build steps
- Do not introduce React, Vue, webpack, Vite, or any bundler
- External CDN links are acceptable (D3, Google Fonts, JetBrains Mono)

### Theme — Arcane Night
- bg:#0f1020  gold:#d4af37  text:#f0e8d0
- CSS variables defined at :root in each file (no shared stylesheet)
- Never revert to Parchment theme values

### Navigation
- All admin pages: 7-item nav — Session Intake, OCR Glossary, Delta Review,
  Integrity, Campaign Log, Log Editor, Versions
- Nav links: onclick="window.location='filename.html'" (same-folder relative)
- Player view has NO links to any admin file

---

## Campaign data schema

File: data/magers-campaign.json  Schema version: 3.3.0

### Key IDs — do not reuse
- Party:     pc_001 to pc_006
- NPCs:      npc_001 npc_003 npc_004 npc_007–npc_013  (gaps: 002 005 006 — voided)
- Locations: loc_001–loc_013  (008=Atticus Clearing 009=Sholes Ford
             010=Western Unknown 013=Southern Unknown)
- Quests:    qst_001–qst_005
- Items:     item_001–item_010
- Combats:   cbt_001–cbt_006  (cbt_006=Wolf Fight rounds pending)
- Bestiary:  mon_001–mon_008  (002=Axe Beak 003=Vespon Swarm 005=Vespon Queen
             006=Goblin Slinger 007=Ogre 008=Giant Rat/ROUS)
- Lore:      lore_001–lore_002

### Next available IDs
npc_014  loc_014  qst_006  item_011  cbt_007  session_006  mon_009  lore_003

### normaliseCampaignJson — field mappings applied by the viewer
session_id → id            session_date → date
narrative_vibe kept as-is  class → cls   current_level → level
progress_log[{session_id,entry}] → progress[{s,e}]
location_id → location added to each combat
npc_directory → npcs       world_lore → lore
quest_ledger → quests      inventory_and_loot → items
current_holder_id → holder
session_found || origin_session → session
is_quest_item → quest (boolean)

### Combat viewer format (compact slots)
rounds[n].slots[{s, a, act, res, val?, notes?}]
rounds[n].enemy[{desc, impact?}]
cbt_006 Wolf Fight has rounds:[] — detail pending

---

## Drive proxy (write path only)

URL: see shared/config.js
Folder: 1BJQxOS4MspOlPzCt70r7zOY_8LnwAwPY

API:
  GET  ?action=backup&id=FILE_ID&label=LABEL  → {ok, backupId, name}
  GET  ?action=listBackups&id=FILE_ID         → {ok, backups:[{id,name,modified,size}]}
  GET  ?action=diagnose&id=FILE_ID            → {ok, diagnostics:{name,mimeType,size}}
  POST Content-Type:text/plain  body:{action:"write",fileId,data:{...}}  → {ok}

Note: GET ?action=read is no longer used — data is read from the repo directly.

---

## Shared AI module — shared/chronicle-ai.js

Loaded by: intake.html, delta-review.html, integrity.html
Exports on window.ChronicleAI:
  .call({system, messages, onResult, onError, onLoading})
  .fillRoundsFromImage(imageDataURL, context)
  .fillRoundsFromText(text, context)
  .sendCorrectionToAI(delta, context)
  .PARTY_ROSTER  — party nicknames string for AI prompts
  .imageContent(dataURL)  — Anthropic image content block
Model: claude-sonnet-4-20250514

---

## The party

pc_001 Zragar/Goldie    Wizard Lv2      David
pc_002 Malachite/Mal    Barbarian Lv2   Lance
pc_003 Ashton/Ash       Warlock Lv2     Frazer
pc_004 Asphodel/Del     Monk Lv2        Kevin
pc_005 Derwin/Goli      Rogue Lv2       Sam
pc_006 Atticus/Atti     Druid Lv2       Jamie
DM: John Magers | Sessions: 5 | Arc: traveling west toward Lake Town

---

## Known open items (session 005)

- cbt_006 Wolf Fight: rounds pending
- pc_003 Ashton: notes field empty
- npc_013 The Low-Level Wizard: no proper name, no session link
- qst_003 Escort to Lake Town: no objectives, no narrative_motivation — active
- cbt_005 Goblin Ambush: paused — continues session_006
- loc_009 loc_010 loc_013: map markers only, no other context

---

## Post-session workflow (Phase 1)

1. Session Intake (admin/intake.html) — upload photos, OCR round data
2. Delta Review (admin/delta-review.html) — approve deltas, click Publish
   Publish writes updated JSON to Google Drive (write path unchanged)
3. Download updated JSON from Drive
4. Replace data/magers-campaign.json in repo
5. Commit and push — Pages redeploys, all viewers updated automatically

Phase 2 goal: eliminate step 3-4 by having Publish commit directly to the repo
via the GitHub Contents API.

---

## Architecture decisions

2026-04-03  Phase 1: data reads → same-origin fetch from /data/
            Rationale: eliminates EMBEDDED_DATA maintenance, removes proxy as read
            dependency, simplifies architecture for GitHub Pages deployment
2026-04-03  Drive proxy retained for writes only
            Rationale: write reimplementation deferred to Phase 2
2026-04-03  Removed EMBEDDED_DATA, build.js, sync indicator
            Rationale: all three existed solely to manage the Drive read lag
2026-04-08  Anthropic API key stored in shared/config.js only
            Rationale: Key never committed to repo — config.js is gitignored.
            Each admin user holds their own copy locally. Browser calls Anthropic
            directly with anthropic-dangerous-direct-browser-access header.
