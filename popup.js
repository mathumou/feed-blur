/* Feed Blur — popup.js
 *
 * Writes go straight to chrome.storage; chrome.storage.onChanged is the event
 * bus that keeps every context (all Facebook tabs, the options page, this
 * popup, the worker's badge) consistent — no custom messaging for settings.
 *
 * Slider write discipline (chrome.storage.sync quotas:
 * MAX_WRITE_OPERATIONS_PER_MINUTE = 120, MAX_WRITE_OPERATIONS_PER_HOUR =
 * 1800; a drag fires 30-60 input events/second, and held arrow keys fire
 * 'change' per keystroke): 'input' updates the UI and the on-page preview
 * plus a 250ms trailing debounce for abandoned drags; 'change' commits. Both
 * paths funnel through fbMakeSyncWriter (settings.js), which writes
 * immediately when idle (a release must persist before the popup can close)
 * and collapses key-repeat storms to ~1 write/s with retry-on-error.
 */

const $ = (id) => document.getElementById(id);

// Keep in sync with background.js: apex + subdomains + optional explicit
// port (content scripts inject regardless of port), lookalike hosts rejected.
const FB_URL_RE = /^https?:\/\/(?:[^./]+\.)*facebook\.com(?::\d+)?\//;

const ui = {
  settings: fbValidateSettings(null),
  tab: null,
  isFb: false,
  contentAlive: false,
  override: undefined
};

function tabKey(tabId) {
  return 'tabState:' + tabId;
}

function renderSettings() {
  $('enabled').checked = ui.settings.enabled;
  $('blurRadius').value = ui.settings.blurRadius;
  renderRadius(ui.settings.blurRadius);
  $('coverOpacity').value = ui.settings.coverOpacity;
  renderCover(ui.settings.coverOpacity);
}

function renderRadius(v) {
  $('radiusOut').textContent = v + ' px';
  $('preview').style.setProperty('--r', v);
}

function renderCover(v) {
  $('coverOpacityOut').textContent = v + ' %';
  $('preview').style.setProperty('--c', v / 100);
}

function renderTabState() {
  const section = $('tabSection');
  const btn = $('tabToggle');
  const label = $('tabStateLabel');
  if (!ui.isFb || !ui.contentAlive) {
    section.classList.add('inert');
    btn.disabled = true;
    label.textContent = 'Not available';
    return;
  }
  section.classList.remove('inert');
  btn.disabled = false;
  if (ui.override === undefined) label.textContent = 'Following global setting';
  else if (ui.override) label.textContent = 'Blur forced ON for this tab';
  else label.textContent = 'Blur forced OFF for this tab';
}

function showWarn(text) {
  const el = $('warn');
  el.textContent = text;
  el.hidden = false;
}

const writeSetting = fbMakeSyncWriter();

/* Live on-page preview during drags — messages have no storage quota. */
function previewOnPage(fields) {
  if (ui.isFb && ui.contentAlive && ui.tab) {
    chrome.tabs.sendMessage(ui.tab.id, { type: 'FB_PREVIEW', ...fields })
      .catch(() => {});
  }
}

/* input = UI + on-page preview + trailing debounce; change = commit.
   Both write paths funnel through the throttled writer. */
function bindSlider(key, render) {
  let timer = 0;
  $(key).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    render(v);
    previewOnPage({ [key]: v });
    clearTimeout(timer);
    timer = setTimeout(() => writeSetting(key, v), 250);
  });
  $(key).addEventListener('change', (e) => {
    clearTimeout(timer);
    writeSetting(key, Number(e.target.value));
  });
}

bindSlider('blurRadius', renderRadius);
bindSlider('coverOpacity', renderCover);

$('enabled').addEventListener('change', (e) => {
  writeSetting('enabled', e.target.checked);
});

/* Same flip logic as the worker's Alt+B handler. The popup is a trusted
 * context, so it reads/writes storage.session directly — no messaging. */
$('tabToggle').addEventListener('click', async () => {
  if (!ui.isFb || !ui.tab) return;
  const effective = ui.override !== undefined ? ui.override : ui.settings.enabled;
  const next = !effective;
  if (next === ui.settings.enabled) {
    await chrome.storage.session.remove(tabKey(ui.tab.id));
  } else {
    await chrome.storage.session.set({ [tabKey(ui.tab.id)]: next });
  }
  // The storage.onChanged listener below re-renders.
});

$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (!(key in FB_SETTINGS_SCHEMA)) continue;
      ui.settings[key] = fbValidateValue(key, changes[key].newValue);
      touched = true;
    }
    if (touched) {
      renderSettings();
      renderTabState();
    }
  } else if (area === 'session' && ui.tab && tabKey(ui.tab.id) in changes) {
    // Fires for popup writes AND for Alt+B pressed while the popup is open.
    ui.override = changes[tabKey(ui.tab.id)].newValue;
    renderTabState();
  }
});

(async function init() {
  ui.settings = await fbLoadSettings();
  renderSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ui.tab = tab || null;
  // tab.url is undefined off-Facebook (host_permissions gate it; no "tabs"
  // permission) — that's the "not a Facebook tab" signal, not an error.
  ui.isFb = !!(tab && tab.url && FB_URL_RE.test(tab.url));

  if (!ui.isFb) {
    showWarn('Open facebook.com to use per-tab controls.');
  } else {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'FB_PING' });
      ui.contentAlive = true;
    } catch (e) {
      // Tab was open before the extension was installed/updated.
      showWarn('Reload this Facebook tab to activate Feed Blur.');
    }
    try {
      const got = await chrome.storage.session.get(tabKey(tab.id));
      ui.override = got[tabKey(tab.id)];
    } catch (e) {
      /* session storage unreadable — treat as no override */
    }
  }
  renderTabState();
})();
