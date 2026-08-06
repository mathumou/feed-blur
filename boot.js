/* Feed Blur — boot.js (run_at: document_start)
 *
 * The blur CSS is fail-closed: it blurs likely content media by default, so
 * that no JS latency can ever produce an unblurred first frame. The flip side
 * is that a *disabled* extension (or a tab with blur toggled off via Alt+B)
 * would briefly blur the page until settings load. This script's only job is
 * to shrink that window to near zero: it reads settings and stamps the gate
 * attributes + custom properties onto <html> at document_start — single-digit
 * milliseconds, essentially always before Facebook's slow, JS-rendered first
 * paint. It also performs the one-time handshake with the service worker to
 * learn this tab's id and per-tab override (content scripts cannot read their
 * own tab id directly — only the worker can, via sender.tab.id).
 *
 * No DOM queries, no observers. content.js (document_idle) does the rest and
 * awaits FB_BOOT.ready before taking over.
 */

/* Stamp settings state onto <html>. Shared with content.js (same isolated
 * world). Absence of an attribute is always the fail-closed default. */
function fbApplyRootState(settings, override) {
  const root = document.documentElement;
  const on = override !== undefined ? override : settings.enabled;
  root.toggleAttribute('data-feedblur-off', !on);
  root.toggleAttribute('data-feedblur-nohover', !settings.unblurOnHover);
  root.toggleAttribute('data-feedblur-novideos', !settings.blurVideos);
  root.toggleAttribute('data-feedblur-avatars', settings.blurAvatars);
  root.style.setProperty('--feedblur-radius', settings.blurRadius + 'px');
  root.style.setProperty('--feedblur-reveal-delay', settings.revealDelayMs + 'ms');
  // 0..1 unitless: how far the filter chain fades media toward the page
  // background color (see content.css section 2). The target color itself is
  // --feedblur-cover-lum, owned by content.js's theme sampler — deliberately
  // NOT written here so repeated settings applies can't clobber the sample.
  root.style.setProperty('--feedblur-cover', String(settings.coverOpacity / 100));
}

/* Initial theme guess before the page has painted anything to sample:
 * prefers-color-scheme needs no DOM and Facebook usually follows it.
 * content.js replaces this with the real body-background luminance at idle. */
try {
  document.documentElement.style.setProperty('--feedblur-cover-lum',
    window.matchMedia('(prefers-color-scheme: dark)').matches ? '0.1' : '0.95');
} catch (e) { /* keep the stylesheet default */ }

/* Answer the popup's liveness probe from document_start. content.js's fuller
 * listener only attaches at document_idle — seconds later on Facebook — and
 * an unanswered ping would make the popup claim the extension isn't active
 * ("reload this tab") while the page is already being blurred. Both listeners
 * answering FB_PING is fine: the first synchronous sendResponse wins. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'FB_PING') sendResponse({ ok: true });
});

var FB_BOOT = {
  tabId: null,
  override: undefined,   // true | false | undefined (undefined = follow global)
  settings: null,
  ready: null
};

FB_BOOT.ready = (async () => {
  try {
    FB_BOOT.settings = await fbLoadSettings();
  } catch (e) {
    FB_BOOT.settings = fbValidateSettings(null);
  }
  // Stamp global settings immediately; don't wait on the worker round-trip.
  fbApplyRootState(FB_BOOT.settings, FB_BOOT.override);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'FB_GET_TAB_STATE' });
    if (resp && typeof resp.tabId === 'number') {
      FB_BOOT.tabId = resp.tabId;
      FB_BOOT.override = resp.override;
    }
  } catch (e) {
    /* Worker unreachable (e.g. extension updating) — follow the global setting. */
  }
  fbApplyRootState(FB_BOOT.settings, FB_BOOT.override);
})();
