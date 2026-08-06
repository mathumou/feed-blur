/* Feed Blur — settings.js
 *
 * Shared settings schema + validation, loaded as a plain classic script in all
 * four contexts:
 *   - content scripts: listed first in the manifest content_scripts js[] array
 *     (all content scripts of one extension share one isolated world, so these
 *     globals are visible to boot.js and content.js);
 *   - popup/options:   <script src="settings.js"> before their own script;
 *   - service worker:  importScripts('settings.js') in background.js.
 *
 * Must therefore contain no import/export and assume nothing beyond
 * chrome.storage. Never add "type": "module" to the background entry.
 */

const FB_SETTINGS_SCHEMA = {
  enabled:       { type: 'boolean', default: true },
  blurRadius:    { type: 'number',  default: 8,   min: 1, max: 40 },
  blurVideos:    { type: 'boolean', default: true },
  blurAvatars:   { type: 'boolean', default: false },
  unblurOnHover: { type: 'boolean', default: true },
  revealDelayMs: { type: 'number',  default: 0,   min: 0, max: 1000 },
  minSize:       { type: 'number',  default: 100, min: 0, max: 600 },
  coverOpacity:  { type: 'number',  default: 0,   min: 0, max: 100 }
};

function fbSettingsDefaults() {
  const out = {};
  for (const key of Object.keys(FB_SETTINGS_SCHEMA)) {
    out[key] = FB_SETTINGS_SCHEMA[key].default;
  }
  return out;
}

/* Coerce/clamp one value against its spec. Storage contents are never trusted
 * (hand-edited storage, values synced from other extension versions): wrong
 * type or non-finite numbers fall back to the default; numbers are rounded
 * and clamped into range. Unknown keys return undefined. */
function fbValidateValue(key, value) {
  const spec = FB_SETTINGS_SCHEMA[key];
  if (!spec) return undefined;
  if (spec.type === 'boolean') {
    return typeof value === 'boolean' ? value : spec.default;
  }
  if (typeof value !== 'number' || !isFinite(value)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

/* Validate a whole raw object: unknown keys dropped, missing keys defaulted. */
function fbValidateSettings(raw) {
  const out = {};
  for (const key of Object.keys(FB_SETTINGS_SCHEMA)) {
    out[key] = fbValidateValue(key, raw ? raw[key] : undefined);
  }
  return out;
}

/* The one read path every context uses. Clamping happens on every read. */
async function fbLoadSettings() {
  const raw = await chrome.storage.sync.get(fbSettingsDefaults());
  return fbValidateSettings(raw);
}

/* Throttled writer for chrome.storage.sync, shared by the popup and options
 * sliders. Range inputs fire 'change' PER KEYSTROKE when arrow keys are held
 * (unlike mouse drags, where 'change' fires once at release), so writing
 * synchronously on every 'change' runs at key-repeat rate and exhausts the
 * sync quota (MAX_WRITE_OPERATIONS_PER_MINUTE = 120) — after which the FINAL
 * value of the interaction can be silently rejected and never persisted.
 *
 * This writer: (a) writes immediately when the key hasn't been written within
 * windowMs — mouse releases and single key taps persist instantly, which
 * matters in the popup, whose timers die the moment it closes; (b) collapses
 * faster repeats into one trailing write (~1/s, far under quota); (c) on a
 * write error, retries the latest intended value with a long backoff (a
 * per-minute quota won't clear in milliseconds), and a newer successful write
 * cancels the retry. */
function fbMakeSyncWriter(windowMs, retryMs) {
  windowMs = windowMs || 1000;
  retryMs = retryMs || 5000;
  const lastWrite = {};   // key -> timestamp of last attempted write
  const timers = {};      // key -> pending trailing/retry timer
  const latest = {};      // key -> latest intended (validated) value
  function flush(key) {
    lastWrite[key] = Date.now();
    chrome.storage.sync.set({ [key]: latest[key] }, () => {
      if (chrome.runtime.lastError) {
        clearTimeout(timers[key]);
        timers[key] = setTimeout(() => flush(key), retryMs);
      }
    });
  }
  return function write(key, value) {
    latest[key] = fbValidateValue(key, value);
    clearTimeout(timers[key]);
    const elapsed = Date.now() - (lastWrite[key] || 0);
    if (elapsed >= windowMs) {
      flush(key);
    } else {
      timers[key] = setTimeout(() => flush(key), windowMs - elapsed);
    }
  };
}
