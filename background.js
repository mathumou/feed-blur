/* Feed Blur — background.js (MV3 service worker, classic — not a module,
 * because importScripts is how settings.js is shared with no build step).
 *
 * Owns: the per-tab blur override (chrome.storage.session, key
 * tabState:<tabId>; absent = follow the global `enabled` setting), the Alt+B
 * command, the FB_GET_TAB_STATE handshake (content scripts cannot learn their
 * own tab id any other way), and the action badge. Entirely event-driven —
 * the worker being killed after ~30s idle is fine because all state lives in
 * chrome.storage.session, which survives worker restarts and is wiped on
 * browser exit (exactly the lifetime a "this tab, this session" toggle wants).
 *
 * No network requests, no analytics, no remote code.
 */

importScripts('settings.js');

// Must run on EVERY worker start — the access level is not persisted. Without
// it, content scripts cannot read storage.session (default TRUSTED_CONTEXTS)
// and would never see per-tab override changes.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// Anchored host match: apex + any subdomain depth + optional explicit port
// (match patterns ignore ports, so the content scripts DO inject on e.g.
// facebook.com:8443 — this predicate must agree). Rejects lookalike hosts
// like notfacebook.com: a prefix label must end with a dot.
const FB_URL_RE = /^https?:\/\/(?:[^./]+\.)*facebook\.com(?::\d+)?\//;

function tabKey(tabId) {
  return 'tabState:' + tabId;
}

async function getOverride(tabId) {
  const key = tabKey(tabId);
  const got = await chrome.storage.session.get(key);
  return got[key];   // true | false | undefined
}

/* Tab-scoped badge text is cleared by Chrome on navigation, but the override
 * (keyed by tabId in session storage) survives — so the badge is re-stamped
 * from storage wherever it might have drifted. */
async function updateBadge(tabId) {
  let override;
  try {
    override = await getOverride(tabId);
  } catch (e) {
    return;
  }
  try {
    if (override === undefined) {
      await chrome.action.setBadgeText({ tabId, text: '' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: override ? 'ON' : 'OFF' });
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: override ? '#2e7d32' : '#c62828'
      });
    }
  } catch (e) {
    /* tab already closed */
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-blur') return;
  if (!tab || tab.id === undefined) {
    // The tab argument can be absent on older Chrome versions.
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  // tab.url is visible for facebook.com thanks to host_permissions and
  // undefined elsewhere — no "tabs" permission involved.
  if (!tab || tab.id === undefined || !tab.url || !FB_URL_RE.test(tab.url)) return;
  const settings = await fbLoadSettings();
  const override = await getOverride(tab.id);
  const effective = override !== undefined ? override : settings.enabled;
  const next = !effective;
  if (next === settings.enabled) {
    // Override became redundant: drop it so the tab tracks the global
    // setting again — the least surprising behavior.
    await chrome.storage.session.remove(tabKey(tab.id));
  } else {
    await chrome.storage.session.set({ [tabKey(tab.id)]: next });
  }
  updateBadge(tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'FB_GET_TAB_STATE' && sender.tab && sender.tab.id !== undefined) {
    const tabId = sender.tab.id;
    getOverride(tabId)
      .then((override) => sendResponse({ tabId, override }))
      .catch(() => sendResponse({ tabId, override: undefined }));
    return true;   // async sendResponse
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});

// Re-stamp the badge after navigations (Chrome clears tab-scoped badges).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') updateBadge(tabId);
});

// Keep badges honest when the override changes elsewhere (the popup writes
// storage.session directly). storage.onChanged also wakes this worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const key of Object.keys(changes)) {
    if (key.startsWith('tabState:')) {
      updateBadge(Number(key.slice('tabState:'.length)));
    }
  }
});
