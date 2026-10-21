/**
 * shared/chronicle-store.js
 *
 * The one place Chronicle reads and writes campaign data.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Where campaign data is stored is going to change twice: phase 2 of the
 * rebuild moves publish from Google Drive to a commit in the repo (#97), and
 * phase 7 moves everything to an API backed by Postgres
 * (docs/intake-redesign.md, "Build order"). Before this module, every page
 * had its own fetch() of the campaign JSON and two pages carried their own
 * copy of the Drive proxy code. With every read and write routed through
 * here, each of those moves changes only this file.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChronicleStore:
 *   loadCampaign()            — the repo copy every page displays
 *   loadPublishBase()         — the copy a publish builds on (Drive today)
 *   publishSession(c, s, o)   — writes a published campaign (Drive today)
 *   createBackup(label)       — Drive backup copy of the live campaign file
 *   listBackups()             — Drive backups of the live campaign file
 *   loadBackup(backupId)      — reads one Drive backup
 *   saveDraft() / loadDraft() — stubs; saved review drafts arrive in phase 7
 *   isSafeTestMode()          — whether Safe Test Mode is on
 *
 * Safe Test Mode is resolved here and nowhere else. When
 * CHRONICLE_CONFIG.safeTestMode is true, reads come from the test fixture,
 * publish downloads the result instead of writing it, and backups target
 * testCampaignFileId.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * Every admin page except glossary.html and drive-test.html, and the player
 * view, load their campaign data through this module. Without it none of
 * them can load, and Delta Review and Versions cannot reach Drive.
 *
 * LOAD ORDER
 * ----------
 * Load after config.js and before any other shared module or page script:
 *   config.js → chronicle-store.js → chronicle-integrity.js → chronicle-ai.js
 *   → chronicle-narrative.js → page script
 * config.js is optional. It is gitignored and absent on GitHub Pages, so
 * loadCampaign() must work without it; only the Drive calls need it.
 */

window.ChronicleStore = (function() {

  // Paths are relative to the calling page. Every page that loads this module
  // lives exactly one folder below the repo root (admin/ or player/), so the
  // same relative path works from all of them.
  const CAMPAIGN_PATH = '../data/magers-campaign.json';
  const FIXTURE_PATH  = '../tests/fixtures/test-campaign.json';

  /**
   * config() — the CHRONICLE_CONFIG object, or {} when config.js is absent.
   *
   * Why: read at call time rather than once at load so a page (or a test)
   * that sets CHRONICLE_CONFIG after this file loads still gets the right
   * values. Returning {} keeps every caller free of null checks.
   * What breaks if changed to a load-time read: the Node tests, which swap
   * the config between cases, would all see the first config.
   */
  function config() {
    return window.CHRONICLE_CONFIG || {};
  }

  /**
   * isSafeTestMode() — true when config.js has safeTestMode switched on.
   *
   * Why: the single switch for test mode. Pages ask the module rather than
   * reading the flag so the test-mode rule lives in one place.
   * What breaks if removed: Delta Review's test-mode banner and confirmation
   * panel cannot tell whether test mode is on.
   */
  function isSafeTestMode() {
    return config().safeTestMode === true;
  }

  /**
   * fetchJson(path) — same-origin GET of a JSON file, throwing on HTTP errors.
   *
   * Why: CLAUDE.md requires a failed load to show an error, never to fall
   * back silently, so a 404 must throw rather than resolve to undefined.
   */
  async function fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' loading ' + path);
    return res.json();
  }

  /**
   * loadCampaign() → raw campaign JSON (not normalised).
   *
   * What: fetches data/magers-campaign.json from the repo, or the test
   * fixture in Safe Test Mode.
   * Why: the copy every page displays and checks against. Pages normalise the
   * result themselves because each page needs a different shape.
   * What breaks if changed: every page's initial load. Phase 7 replaces the
   * fetch with an API call; the return value must stay the raw v4 JSON.
   */
  async function loadCampaign() {
    return fetchJson(isSafeTestMode() ? FIXTURE_PATH : CAMPAIGN_PATH);
  }

  // ── Drive proxy plumbing ──────────────────────────────────────────────────
  // Moved here from identical copies in delta-review.html and versions.html.
  // Drive is a temporary store: #97 replaces the publish write with a repo
  // commit, and phase 7 replaces the backups. Remove these helpers when the
  // last Drive call below is gone.

  /**
   * driveSetup() → { proxy, fileId } for the Drive proxy calls.
   *
   * Why: Drive needs config.js, which is absent on GitHub Pages. Failing here
   * with a plain message is clearer than a fetch to "undefined?action=…".
   * The file ID follows Safe Test Mode so test runs never touch the live file.
   */
  function driveSetup() {
    const cfg = config();
    if (!cfg.proxyUrl) {
      throw new Error('Drive is not configured — shared/config.js is missing or has no proxyUrl');
    }
    return {
      proxy:  cfg.proxyUrl,
      fileId: isSafeTestMode() ? cfg.testCampaignFileId : cfg.campaignFileId,
    };
  }

  /**
   * driveGet(params) — GET request to the Drive proxy, returning its JSON.
   *
   * Why GET: a GET with query parameters is a CORS "simple" request, so the
   * browser sends no OPTIONS preflight, which the Apps Script proxy cannot
   * answer. Throws when the proxy reports { ok: false }.
   */
  async function driveGet(params) {
    const { proxy } = driveSetup();
    const query = Object.keys(params)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
      .join('&');
    const res = await fetch(proxy + '?' + query);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Drive error');
    return data;
  }

  /**
   * driveWrite(campaign) — overwrites the Drive campaign file.
   *
   * Why POST with text/plain: the body is too large for a URL, and text/plain
   * is a CORS "simple" content type, so this still avoids a preflight.
   */
  async function driveWrite(campaign) {
    const { proxy, fileId } = driveSetup();
    const res = await fetch(proxy, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({ action: 'write', fileId: fileId, data: campaign }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Drive write error');
    return data;
  }

  /**
   * loadPublishBase() → raw campaign JSON that a publish should build on.
   *
   * What: today, the Drive campaign file; in Safe Test Mode, the test fixture.
   * Why separate from loadCampaign(): publish has always applied deltas to
   * the Drive copy, which can differ from the repo copy until the DM syncs
   * them by hand. Keeping that behaviour here means publish works exactly as
   * before. #97 makes publish commit to the repo; this then becomes the same
   * as loadCampaign() and can be folded into it.
   */
  async function loadPublishBase() {
    if (isSafeTestMode()) return loadCampaign();
    const { fileId } = driveSetup();
    const data = await driveGet({ action: 'read', id: fileId });
    // The proxy returns the file as a string: { ok: true, raw: "<json>" }.
    return JSON.parse(data.raw);
  }

  /**
   * publishSession(campaign, summary, options) → result
   *
   * What: stores a campaign that already has the session's approved deltas
   * applied. Today: backs up the Drive file, then overwrites it. In Safe Test
   * Mode: downloads the result as test-campaign.json, because a browser
   * cannot write to the local fixture.
   *
   * campaign — the full updated campaign JSON
   * summary  — { sessionId, label } describing the publish; label names the
   *            Drive backup. #97 will use the same fields for the commit message.
   * options  — { onProgress(message) } for the page's status line (optional)
   *
   * Returns { mode: 'drive', backup } or { mode: 'test-download', filename }
   * so the page can word its success message.
   *
   * Why the backup comes just before the write: the Drive file is unchanged
   * until the write, so the backup captures the same pre-publish state it did
   * when it ran before the read. Doing both here keeps the page free of
   * storage steps. #97 reimplements this function to commit to the repo.
   */
  async function publishSession(campaign, summary, options) {
    const progress = (options && options.onProgress) || function() {};
    const label    = (summary && summary.label) || 'pre-publish';

    if (isSafeTestMode()) {
      const filename = 'test-campaign.json';
      const blob = new Blob([JSON.stringify(campaign, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return { mode: 'test-download', filename: filename };
    }

    progress('Creating backup…');
    const backup = await createBackup(label);

    progress('Writing to Drive…');
    await driveWrite(campaign);

    return { mode: 'drive', backup: backup };
  }

  /**
   * createBackup(label) → { ok, backupId, name }
   *
   * What: asks the proxy to copy the Drive campaign file into the backup set.
   * Why: used before every publish and by the Versions pre-session backup.
   */
  async function createBackup(label) {
    const { fileId } = driveSetup();
    return driveGet({ action: 'backup', id: fileId, label: label || '' });
  }

  /**
   * listBackups() → { ok, backups: [{ id, name, modified, size }] }
   *
   * Why: the Versions page syncs its local ledger from this list.
   */
  async function listBackups() {
    const { fileId } = driveSetup();
    return driveGet({ action: 'listBackups', id: fileId });
  }

  /**
   * loadBackup(backupId) → the backup's campaign JSON.
   *
   * Why: the Versions page downloads a backup for a manual restore. The proxy
   * serves a file by bare ID (no action parameter) as { ok, data }.
   */
  async function loadBackup(backupId) {
    const data = await driveGet({ id: backupId });
    return data.data;
  }

  // ── Saved review drafts ───────────────────────────────────────────────────
  // Saving a half-finished review needs a server-side store; the repo and
  // Drive cannot hold per-user working state safely. The design defers drafts
  // to the Postgres move (phase 7). These stubs fix the interface now so
  // pages can be written against it; replace them in phase 7.

  const DRAFTS_UNAVAILABLE = 'Saved review drafts are not available until Chronicle moves to Postgres (rebuild phase 7).';

  /**
   * saveDraft() — not available yet; always rejects with an explanation.
   * Why it exists: reserves the interface so phase 7 changes only this file.
   */
  async function saveDraft() {
    throw new Error(DRAFTS_UNAVAILABLE);
  }

  /**
   * loadDraft() — not available yet; always rejects with an explanation.
   * Why it exists: reserves the interface so phase 7 changes only this file.
   */
  async function loadDraft() {
    throw new Error(DRAFTS_UNAVAILABLE);
  }

  return {
    loadCampaign,
    loadPublishBase,
    publishSession,
    createBackup,
    listBackups,
    loadBackup,
    saveDraft,
    loadDraft,
    isSafeTestMode,
  };

})();
