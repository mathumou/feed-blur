/* Feed Blur — options.js
 *
 * Same live-apply model as the popup: writes go to chrome.storage.sync,
 * chrome.storage.onChanged fans them out to every Facebook tab (and back to
 * this page when edited elsewhere). Same slider write discipline too — sync
 * allows 120 writes/min and held arrow keys fire 'change' per keystroke, so
 * all writes funnel through fbMakeSyncWriter (settings.js): immediate when
 * idle, key-repeat storms collapsed to ~1 write/s, retry on error.
 */

const $ = (id) => document.getElementById(id);

const BOOLS = ['enabled', 'blurVideos', 'blurAvatars', 'unblurOnHover'];
const NUM_UNITS = { blurRadius: ' px', coverOpacity: ' %', revealDelayMs: ' ms', minSize: ' px' };
const timers = {};

function renderNum(key, value) {
  $(key + 'Out').textContent = value + NUM_UNITS[key];
  if (key === 'blurRadius') $('preview').style.setProperty('--r', value);
  if (key === 'coverOpacity') $('preview').style.setProperty('--c', value / 100);
}

function render(settings) {
  for (const key of BOOLS) $(key).checked = settings[key];
  for (const key of Object.keys(NUM_UNITS)) {
    $(key).value = settings[key];
    renderNum(key, settings[key]);
  }
}

const writeSetting = fbMakeSyncWriter();

for (const key of BOOLS) {
  $(key).addEventListener('change', (e) => writeSetting(key, e.target.checked));
}

for (const key of Object.keys(NUM_UNITS)) {
  $(key).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    renderNum(key, v);
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => writeSetting(key, v), 250);
  });
  $(key).addEventListener('change', (e) => {
    clearTimeout(timers[key]);
    writeSetting(key, Number(e.target.value));
  });
}

$('restore').addEventListener('click', () => {
  chrome.storage.sync.set(fbSettingsDefaults(), () => {
    void chrome.runtime.lastError;
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const key of Object.keys(changes)) {
    if (!(key in FB_SETTINGS_SCHEMA)) continue;
    const v = fbValidateValue(key, changes[key].newValue);
    if (BOOLS.includes(key)) $(key).checked = v;
    else if (key in NUM_UNITS) {
      $(key).value = v;
      renderNum(key, v);
    }
  }
});

fbLoadSettings().then(render);
