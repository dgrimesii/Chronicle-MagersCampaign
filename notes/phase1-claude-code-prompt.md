## Chronicle Phase 1 — Move data reads from Drive proxy to same-origin fetch

### Context
Chronicle is a GitHub Pages web app. Campaign data currently loads via a Google Drive
proxy. Phase 1 moves data reads to a same-origin fetch from data/magers-campaign.json
in the repo. The Drive proxy is kept for writes only.

Read CLAUDE.md before starting. It contains the full project context.

---

### Files to change

**admin/log-viewer.html**
**player/index.html**

These are the only two files that currently load campaign data. All other admin files
(intake, glossary, delta-review, integrity, log-editor, versions) do not load the
campaign JSON on their own — skip them.

---

### What to do in each file

#### 1. Remove EMBEDDED_DATA

Find the block that starts with:
  const EMBEDDED_DATA = {
and ends with:
  }; // end EMBEDDED_DATA

Delete the entire block including those two lines. It will be large (30-40 KB of JS).

#### 2. Remove the sync indicator bar

In admin/log-viewer.html only:

Remove the HTML element:
  <div id="sync-bar" ...>...</div>

Remove the CSS rules for:
  #sync-bar  #sync-bar.stale  #sync-bar.current  .sync-btn  .sync-btn.stale-btn
  .sync-btn.current-btn  .sync-btn:disabled

Remove the JS functions:
  function updateSyncBar(driveDate) { ... }
  async function syncFromDrive() { ... }

Remove any calls to updateSyncBar() — there will be one in ingestDriveData().

Remove from CONFIG:
  embeddedDataDate: ...
  driveDataDate: ...

#### 3. Replace init() with a same-origin fetch

**In admin/log-viewer.html**, replace the existing init() function with:

```javascript
async function init() {
  setStatus('Loading campaign data…', 'loading');
  try {
    const res = await fetch('../data/magers-campaign.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    DATA = normaliseCampaignJson(json);
    registerAll();
    renderSessionTimeline();
    renderSidebar();
    applyMode();
    setStatus(
      'Loaded · ' + (DATA.sessions?.length||0) + ' sessions · ' +
      (DATA.party?.length||0) + ' PCs · ' + (DATA.combats?.length||0) + ' combats',
      'ok'
    );
  } catch(e) {
    setStatus('Failed to load campaign data: ' + e.message, 'error');
    showError('Could not load data/magers-campaign.json: ' + e.message +
      '\n\nMake sure the file exists in the repo and the site has been deployed.',
      'init');
  }
}

init();
```

**In player/index.html**, replace init() with:

```javascript
function init() {
  setStatus('Loading campaign data…', 'loading');
  fetch('../data/magers-campaign.json')
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(json) {
      DATA = normaliseCampaignJson(json);
      registerAll();
      renderSessionTimeline();
      renderSidebar();
      applyMode();
      setStatus(
        'Magers Campaign · ' + (DATA.sessions?.length||0) + ' sessions logged',
        'ok'
      );
    })
    .catch(function(e) {
      setStatus('Failed to load campaign data: ' + e.message, 'error');
      console.error('[Chronicle] data load failed:', e);
    });
}

init();
```

Note: player/index.html does not have showError() — use console.error only.

#### 4. Remove Drive loading code from admin/log-viewer.html

Remove these functions entirely (they are no longer called):
  async function loadFromDrive() { ... }
  function extractDriveId(input) { ... }
  function parseDriveInput(val) { ... }

Remove the Drive file ID input from the settings panel HTML.
Keep the settings panel itself — it still controls admin/player mode.

Remove from CONFIG:
  driveFileId: ...
  campaignFileId: ...
  proxyUrl: ...

These now live only in shared/config.js. The log-viewer does not need them for reads.
It does not perform writes, so it does not need them at all.

Keep ingestDriveData() — it is still called if someone manually triggers a load
through the settings panel in future. Just remove the Drive ID input field from
the settings panel HTML so it's not surfaced to users.

#### 5. Remove the loadFromDrive button from the settings panel

In the settings panel HTML, remove the Drive file ID input field and Load button.
Keep the admin/player mode toggle buttons.

---

### What NOT to change

- Do not change normaliseCampaignJson() — it still does the same field mapping work
- Do not change renderSidebar(), renderDetail(), or any render functions
- Do not change the Drive write path in delta-review.html or versions.html
- Do not change shared/config.js
- Do not change shared/chronicle-ai.js
- Do not change data/magers-campaign.json
- Do not change any admin file other than log-viewer.html
- Do not add any npm packages or build steps

---

### Verification — done when

1. Open admin/log-viewer.html in a browser (via a local server or deployed to Pages)
   The sidebar populates with sessions, combats, PCs, NPCs, locations, quests,
   items, and lore within 1-2 seconds of page load
2. There is no sync bar in the header
3. There is no EMBEDDED_DATA const in either HTML file
   (search the files for "end EMBEDDED_DATA" — it should not exist)
4. Clicking any entity in the sidebar loads its detail panel correctly
5. Open player/index.html — same sidebar population, no admin nav links
6. Reducing the browser window does not show any overflow or layout breaks in the header
7. There are no console errors on page load in either file
