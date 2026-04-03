# Chronicle — Magers Campaign

Campaign log management system for the Magers D&D 5e campaign.

## Structure

```
Chronicle-MagersCampaign/
├── index.html              # Root — redirects to player view
├── player/
│   └── index.html          # Player-facing campaign log (shareable)
├── admin/
│   ├── log-viewer.html     # Campaign log (admin view with Drive sync)
│   ├── intake.html         # Session intake / OCR pipeline
│   ├── glossary.html       # OCR hints glossary
│   ├── delta-review.html   # Post-session delta review and publish
│   ├── integrity.html      # Combat log integrity checker
│   ├── log-editor.html     # Campaign data editor
│   ├── versions.html       # Version manager / Drive backup
│   └── drive-test.html     # Drive access diagnostics
├── shared/
│   ├── config.js           # Drive proxy URL and campaign file ID
│   └── chronicle-ai.js     # Shared Anthropic API module
├── data/
│   └── magers-campaign.json  # Campaign data (source of truth)
└── scripts/
    └── build.js            # Rebuilds EMBEDDED_DATA from JSON
```

## GitHub Pages

The player view is publicly accessible at:
`https://<username>.github.io/Chronicle-MagersCampaign/player/`

Admin tools are in the `/admin/` folder — share these only with the DM.

## Updating campaign data

1. Edit `data/magers-campaign.json`
2. Update `meta.last_updated` to today's date
3. Run the build script to update embedded data in HTML files:
   ```bash
   node scripts/build.js
   ```
4. Commit and push — GitHub Pages deploys automatically

## Drive integration

Drive credentials live in `shared/config.js` only.  
Update `proxyUrl` and `campaignFileId` there if they change.  
Never hardcode these values in individual HTML files.

## Admin navigation

All admin pages share a 7-item nav bar:  
Session Intake → OCR Glossary → Delta Review → Integrity → Campaign Log → Log Editor → Versions

## Tech stack

- Vanilla HTML/CSS/JS — no framework, no build step required for the app itself
- D3.js (CDN) for the relationship graph
- Google Apps Script proxy for Drive integration  
- Anthropic Claude API for AI features (OCR, delta review, integrity fill)
- Node.js required only for `scripts/build.js`
