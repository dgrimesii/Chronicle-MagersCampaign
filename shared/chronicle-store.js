/**
 * shared/chronicle-store.js
 *
 * The one place Chronicle reads and writes campaign data.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Where campaign data is stored is going to change twice: phase 2 of the
 * rebuild moves publish from Google Drive to the local campaign file in the
 * DM's clone (#97), and phase 7 moves everything to an API backed by Postgres
 * (docs/intake-redesign.md, "Build order"). Before this module, every page
 * had its own fetch() of the campaign JSON and two pages carried their own
 * copy of the Drive proxy code. With every read and write routed through
 * here, each of those moves changes only this file.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Exports window.ChronicleStore:
 *   loadCampaign()            — the repo copy every page displays
 *   loadPublishBase()         — the copy a publish builds on: the campaign
 *                               file read from disk in the DM's clone (#97)
 *   publishSession(c, s, o)   — writes the published campaign to that file;
 *                               the DM commits it in VS Code (#97)
 *   createBackup(label)       — Drive backup copy of the Drive campaign file
 *   listBackups()             — Drive backups of that file
 *   loadBackup(backupId)      — reads one Drive backup
 *   saveDraft() / loadDraft() — stubs; saved review drafts arrive in phase 7
 *   isSafeTestMode()          — whether Safe Test Mode is on
 *
 * Safe Test Mode is resolved here and nowhere else. When
 * CHRONICLE_CONFIG.safeTestMode is true, publish builds on the test fixture
 * and writes tests/output/test-campaign.published.json (never the fixture or
 * the campaign file), page reads show that output once it exists and the
 * fixture until then, and backups target testCampaignFileId.
 *
 * WHAT WOULD BREAK IF REMOVED
 * ----------------------------
 * Every admin page except glossary.html and drive-test.html, and the player
 * view, load their campaign data through this module. Without it none of
 * them can load, Delta Review cannot publish, and Versions cannot reach Drive.
 *
 * LOAD ORDER
 * ----------
 * Load after config.js and before any other shared module or page script:
 *   config.js → chronicle-store.js → chronicle-integrity.js → chronicle-ai.js
 *   → chronicle-narrative.js → page script
 * config.js is optional. It is gitignored and absent on GitHub Pages, so
 * loadCampaign() must work without it. Publishing needs no settings from it
 * (only safeTestMode); the Drive backups need proxyUrl.
 */

window.ChronicleStore = (function() {

  // Paths are relative to the calling page. Every page that loads this module
  // lives exactly one folder below the repo root (admin/ or player/), so the
  // same relative path works from all of them.
  const CAMPAIGN_PATH = '../data/magers-campaign.json';
  const FIXTURE_PATH  = '../tests/fixtures/test-campaign.json';
  // Written by a Safe Test Mode publish (#97); absent until the first one.
  const TEST_OUTPUT_PATH = '../tests/output/test-campaign.published.json';

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
   * What: fetches data/magers-campaign.json from the repo. In Safe Test Mode
   * it fetches the last test publish (tests/output/test-campaign.published.json)
   * when there is one, and the test fixture otherwise.
   * Why: the copy every page displays and checks against. Pages normalise the
   * result themselves because each page needs a different shape. The test
   * output comes first so the admin log viewer shows what a test publish
   * wrote (the phase 5 gate, #17 test E-08, needs this).
   * What breaks if changed: every page's initial load. Phase 7 replaces the
   * fetch with an API call; the return value must stay the raw v4 JSON.
   */
  async function loadCampaign() {
    if (!isSafeTestMode()) return fetchJson(CAMPAIGN_PATH);
    // no-store: the output file is rewritten by every test publish, and a
    // cached copy would show the previous one.
    const res = await fetch(TEST_OUTPUT_PATH, { cache: 'no-store' });
    if (res.ok) return res.json();
    // 404 only means no test publish has happened yet; anything else is a
    // real failure and must show as one, not as the fixture.
    if (res.status !== 404) throw new Error('HTTP ' + res.status + ' loading ' + TEST_OUTPUT_PATH);
    return fetchJson(FIXTURE_PATH);
  }

  // ── Drive proxy plumbing ──────────────────────────────────────────────────
  // Drive no longer receives publishes (#97 writes them to the local file). It is
  // still used by the Versions page's backups (createBackup, listBackups,
  // loadBackup), which the design retires separately. Remove these helpers
  // when the last of those calls is gone.

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

  // ── Publishing to the local campaign file (issue #97) ─────────────────────
  // Chronicle runs locally from VS Code with Live Server, so publish writes
  // data/magers-campaign.json in the DM's own clone through the browser's
  // File System Access API (Chrome or Edge). The DM then commits and pushes
  // from VS Code on their own schedule; this module never talks to GitHub
  // and needs no token. Phase 7 replaces this section with calls to the
  // Postgres-backed API.

  // Paths inside the repository folder the DM picks. Unlike CAMPAIGN_PATH
  // and FIXTURE_PATH above, these are relative to the repo root, because the
  // folder handle points at the root, not at the calling page.
  const FILE_CAMPAIGN  = ['data', 'magers-campaign.json'];
  // The previous campaign file, kept before each overwrite as a one-step
  // safety net until the DM commits. Git-ignored.
  const FILE_PREVIOUS  = ['data', 'magers-campaign.prev.json'];
  const FILE_FIXTURE   = ['tests', 'fixtures', 'test-campaign.json'];
  // Where a Safe Test Mode publish lands. Git-ignored. The fixture itself is
  // never written: the automated tests depend on its exact content.
  const FILE_TEST_OUTPUT = ['tests', 'output', 'test-campaign.published.json'];

  // IndexedDB names for the remembered folder handle. A directory handle
  // cannot be put in localStorage (it is not a string), and IndexedDB is the
  // only browser store that can hold one. CLAUDE.md allows this one use.
  const HANDLE_DB    = 'chronicle-store';
  const HANDLE_STORE = 'handles';
  const HANDLE_KEY   = 'repo-folder';
  // How long to wait for IndexedDB before giving up on the remembered
  // folder. IndexedDB normally answers in milliseconds; without a limit, a
  // database stuck behind another tab would leave publish waiting forever
  // on "Reading the campaign file…" with no error.
  const HANDLE_DB_TIMEOUT_MS = 5000;

  // What loadPublishBase() last read: whether it was in Safe Test Mode, the
  // folder handle, the path read and the exact text found there.
  // publishSession() compares the file against that text before writing.
  // Cleared after every publish attempt, so each publish starts from a fresh read.
  let publishBase = null;

  /**
   * openHandleDb() → an open IndexedDB database holding the folder handle.
   *
   * Why: the DM should pick the repository folder once, not on every
   * publish. Browsers let a directory handle be stored in IndexedDB and
   * reused across visits (permission still has to be re-granted each new
   * browser session). Returns null when IndexedDB is unavailable, and the
   * DM is then asked for the folder on each publish.
   * Rejects if the open is blocked (another tab holds the database open
   * during a version change) or takes longer than HANDLE_DB_TIMEOUT_MS.
   * Both callers swallow that rejection, so the worst case is the folder
   * picker opening again, never a publish that hangs (#97 gate review).
   * The caller must close() the database it gets back.
   */
  function openHandleDb() {
    const idb = window.indexedDB;
    if (!idb) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let gaveUp = false;
      const timer = setTimeout(() => { gaveUp = true; reject(new Error('IndexedDB did not answer')); }, HANDLE_DB_TIMEOUT_MS);
      const req = idb.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
      req.onsuccess = () => {
        clearTimeout(timer);
        // A database that opens after the timeout has nobody waiting for
        // it, so close it instead of leaving the connection open.
        if (gaveUp) { req.result.close(); return; }
        resolve(req.result);
      };
      req.onerror = () => { clearTimeout(timer); reject(req.error); };
      req.onblocked = () => { clearTimeout(timer); gaveUp = true; reject(new Error('IndexedDB open blocked by another tab')); };
    });
  }

  /**
   * savedFolder() / saveFolder(handle) — read and write the remembered
   * repository folder handle. A failure to remember is not an error for
   * the publish itself: it only means the folder is asked for again later.
   */
  // Each call opens its own connection and closes it when done, so no
  // connection is left open to block a later version change of the
  // database. Before the #97 gate review they were never closed.
  async function savedFolder() {
    let db = null;
    try {
      db = await openHandleDb();
      if (!db) return null;
      const req = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(HANDLE_KEY);
      return await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    } finally {
      if (db) db.close();
    }
  }
  async function saveFolder(handle) {
    let db = null;
    try {
      db = await openHandleDb();
      if (!db) return;
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      /* asked for again next time; nothing else depends on it */
    } finally {
      if (db) db.close();
    }
  }

  /**
   * fileHandle(folder, parts, create) → the file handle at parts under folder.
   *
   * Why: the API walks one folder at a time. create makes missing folders
   * and the file itself, which only the two output files (the .prev copy
   * and the test output) ever need; the campaign file and fixture must
   * already exist, so a wrong folder is caught instead of filled.
   */
  async function fileHandle(folder, parts, create) {
    let dir = folder;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
    }
    return dir.getFileHandle(parts[parts.length - 1], { create: !!create });
  }

  /** readText(folder, parts) → the file's exact text. */
  async function readText(folder, parts) {
    const file = await (await fileHandle(folder, parts, false)).getFile();
    return file.text();
  }

  /**
   * writeText(folder, parts, text) — replaces the file's content with text.
   *
   * Why createWritable: the browser writes to a temporary file and swaps it
   * in on close(), so an interrupted write leaves the old file intact rather
   * than half a campaign.
   */
  async function writeText(folder, parts, text) {
    const writable = await (await fileHandle(folder, parts, true)).createWritable();
    await writable.write(text);
    await writable.close();
  }

  /**
   * repoFolder() → a directory handle for the repository, with read and
   * write permission granted.
   *
   * What: reuses the folder remembered in IndexedDB, or asks the DM to pick
   * it (showDirectoryPicker) the first time. Each new browser session the
   * browser asks the DM once to allow editing it again.
   * Why it must run straight from a click: both the picker and the
   * permission prompt need a recent user gesture. Delta Review calls
   * loadPublishBase() first thing in its Confirm Publish handler.
   * Every way this can fail throws a message ending "Nothing was written",
   * and nothing has been written at that point.
   * A picked folder is checked for data/magers-campaign.json before it is
   * remembered, so picking the wrong folder cannot make publish write into it.
   */
  async function repoFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('This browser cannot write local files. Publish needs Chrome or Edge, with the page served by Live Server. Nothing was written.');
    }
    let folder = await savedFolder();
    const picked = !folder;
    if (picked) {
      try {
        folder = await window.showDirectoryPicker({ id: 'chronicle-repo', mode: 'readwrite' });
      } catch (e) {
        if (e && e.name === 'AbortError') {
          throw new Error('No folder chosen. Publish needs the Chronicle repository folder. Nothing was written.');
        }
        throw new Error('Could not open the folder picker (' + (e && e.message) + '). Nothing was written.');
      }
    }
    // A handle remembered from an earlier session starts as 'prompt'; asking
    // here is the one click per browser session.
    let state = await folder.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted') state = await folder.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted') {
      throw new Error('Permission to edit the folder "' + folder.name + '" was refused. Nothing was written.');
    }
    if (picked) {
      try {
        await fileHandle(folder, FILE_CAMPAIGN, false);
      } catch (e) {
        // The common mistake is picking the data folder itself. The picker
        // reopens in the folder picked last, and going up a level in the
        // Windows dialog leaves that folder highlighted, so "Select Folder"
        // picks data again (this happened at the #97 gate). Say so plainly.
        let pickedData = false;
        try { await folder.getFileHandle(FILE_CAMPAIGN[1]); pickedData = true; } catch (e2) { /* not the data folder */ }
        if (pickedData) {
          throw new Error('You picked the "' + folder.name + '" folder itself. Pick the repository folder that contains it. ' +
            'The picker opens where you last picked, so go up one level and make sure "' + folder.name + '" is not highlighted before Select Folder. Nothing was written.');
        }
        throw new Error('The folder "' + folder.name + '" is not the Chronicle repository (no data/magers-campaign.json in it). Pick the repository folder. Nothing was written.');
      }
      await saveFolder(folder);
    }
    return folder;
  }

  /**
   * loadPublishBase() → raw campaign JSON that a publish builds on.
   *
   * What: reads data/magers-campaign.json from disk through the repository
   * folder handle (the test fixture in Safe Test Mode) and remembers the
   * exact text for publishSession().
   * Why from disk and not from the page's fetch: publish must build on the
   * same bytes it later checks against. Until #97 this read the Drive copy,
   * which drifted from the repo until the DM synced it by hand.
   */
  async function loadPublishBase() {
    publishBase = null;
    const testMode = isSafeTestMode();
    const folder = await repoFolder();
    const readPath = testMode ? FILE_FIXTURE : FILE_CAMPAIGN;
    let text;
    try {
      text = await readText(folder, readPath);
    } catch (e) {
      throw new Error(readPath.join('/') + ' could not be read from "' + folder.name + '" (' + (e && e.message) + '). Nothing was written.');
    }
    const json = JSON.parse(text);
    publishBase = { testMode, folder, readPath, text };
    return json;
  }

  /**
   * publishSession(campaign, summary, options) → result
   *
   * What: writes a campaign that already has the session's approved deltas
   * applied to the local campaign file. The DM commits it from VS Code.
   *
   * campaign — the full updated campaign JSON
   * summary  — { sessionId, sessionRef, title, label }: sessionRef (the
   *            session_NNN the DM knows) and title make the suggested
   *            commit message
   * options  — { onProgress(message) } for the page's status line (optional)
   *
   * Returns { mode: 'local-file', path, previousPath, testMode, commitMessage }.
   * previousPath is null in Safe Test Mode, which writes nothing else.
   *
   * Safety, in order:
   *   1. loadPublishBase() must have run first, in the same mode.
   *   2. The file it read is read again. If the text differs at all (a git
   *      pull, a hand edit, a publish from another tab), publish stops with
   *      nothing written, so it never replaces changes it did not see.
   *   3. Production only: the current file is copied to
   *      data/magers-campaign.prev.json before it is overwritten.
   *   4. The campaign is written exactly as the repo stores it (2-space
   *      indent, final newline), so VS Code's diff shows only what changed.
   * Safe Test Mode reads the fixture and writes only
   * tests/output/test-campaign.published.json.
   */
  async function publishSession(campaign, summary, options) {
    const progress = (options && options.onProgress) || function() {};
    const base = publishBase;
    // One base, one publish: whatever happens below, the next publish reads again.
    publishBase = null;
    if (!base || base.testMode !== isSafeTestMode()) {
      throw new Error('Publish base not loaded — read the campaign with loadPublishBase() first. Nothing was written.');
    }
    const readName = base.readPath.join('/');

    progress('Checking ' + readName + ' has not changed on disk…');
    let current;
    try {
      current = await readText(base.folder, base.readPath);
    } catch (e) {
      throw new Error(readName + ' could not be read again (' + (e && e.message) + '). Nothing was written.');
    }
    if (current !== base.text) {
      throw new Error(readName + ' changed on disk since the campaign was loaded (a git pull, an edit or another tab). ' +
        'Nothing was written. Reload the page and publish again.');
    }

    const s = summary || {};
    const ref = s.sessionRef || s.sessionId || 'session';
    const commitMessage = 'Publish ' + ref + (s.title ? ': ' + s.title : '');
    const text = JSON.stringify(campaign, null, 2) + '\n';

    if (base.testMode) {
      progress('Writing ' + FILE_TEST_OUTPUT.join('/') + '…');
      try {
        await writeText(base.folder, FILE_TEST_OUTPUT, text);
      } catch (e) {
        throw new Error('Could not write ' + FILE_TEST_OUTPUT.join('/') + ' (' + (e && e.message) + '). Nothing else was written.');
      }
      return { mode: 'local-file', path: FILE_TEST_OUTPUT.join('/'), previousPath: null, testMode: true, commitMessage };
    }

    progress('Keeping the previous file as ' + FILE_PREVIOUS.join('/') + '…');
    try {
      await writeText(base.folder, FILE_PREVIOUS, current);
    } catch (e) {
      throw new Error('Could not write ' + FILE_PREVIOUS.join('/') + ' (' + (e && e.message) + '). The campaign file was not written.');
    }
    progress('Writing ' + readName + '…');
    try {
      await writeText(base.folder, FILE_CAMPAIGN, text);
    } catch (e) {
      // writeText only swaps the new file in on close(), so a failure here
      // leaves the old campaign file as it was.
      throw new Error('Could not write ' + readName + ' (' + (e && e.message) + '). The old file is unchanged.');
    }
    return { mode: 'local-file', path: readName, previousPath: FILE_PREVIOUS.join('/'), testMode: false, commitMessage };
  }

  /**
   * createBackup(label) → { ok, backupId, name }
   *
   * What: asks the proxy to copy the Drive campaign file into the backup set.
   * Why: used by the Versions pre-session backup. Publish no longer makes one
   * (#97); git history and data/magers-campaign.prev.json replace it.
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
