/* Feed Blur — content.js
 *
 * run_at: document_idle — rationale:
 *   - content.css is injected by Chrome BEFORE first paint regardless of
 *     run_at (css files in content_scripts have their own, earlier injection
 *     point), and its fail-closed selectors blur content media with zero JS.
 *     This script is therefore never on the no-FOUC critical path; it only
 *     REFINES: confirming matches, opting out false positives, and covering
 *     media types CSS can't see (class-based background images).
 *   - Facebook is a client-side SPA: at document_start/document_end the DOM
 *     is an empty shell; all feed media arrives later via page JS, which the
 *     MutationObserver below sees regardless of run_at.
 *   - document_idle guarantees document.body exists and avoids competing with
 *     Facebook's own startup for main-thread time. boot.js (document_start)
 *     stamps settings early so a disabled extension doesn't blur-flash.
 *
 * Pipeline: MutationObserver (triage only) → pending Set → one
 * requestIdleCallback flush → IntersectionObserver (geometry + near-viewport
 * gate) → classify → mark. All size checks read entry.boundingClientRect,
 * which the browser computes post-layout — plain property reads, zero forced
 * reflows anywhere in the pipeline.
 */

const CONFIG = {
  // Marking scope: [role="main"] when present (falls back to the whole
  // document when absent — logged-out pages, transient SPA states). Media
  // outside the scope is opted out. Add ',[role="complementary"]' to also
  // treat right-rail ads as in-scope content (see README).
  SCOPE_SELECTOR: '[role="main"]',

  // Ancestor contexts whose media is never blurred. [role="dialog"] is
  // deliberately NOT excluded: the photo lightbox and the comment popup obey
  // the universal hover-to-reveal rule (add '[role="dialog"]' back here to
  // reveal dialog media on click instead). aria-hidden wrappers are handled
  // separately (deferred, not opted out) because carousels toggle aria-hidden
  // as slides move in and out of view.
  EXCLUDE_ROLES_SELECTOR: '[role="banner"],[role="navigation"],[role="menu"]',

  // What the pipeline classifies. Background images are discovered via the
  // inline-style prefilter only — class-based CSS backgrounds are a documented
  // blind spot (Facebook sets feed-relevant backgrounds inline). Class names
  // are never used: they're obfuscated and rotate.
  CANDIDATE_SELECTOR: 'img,video,canvas,svg image,div[style*="background-image"]',

  // Source policy: a small, stable EXCLUSION list; unknown hosts (blob:,
  // data:, external CDNs in link previews) default-INCLUDE — a privacy tool
  // fails toward blurring. scontent*/external*.fbcdn.net are "definitely
  // content" (used for the fail-closed re-blur fast path on recycled nodes).
  CONTENT_HOST_RE: /(?:^|\/\/)(?:scontent|external)[^/]*\.fbcdn\.net/i,
  UI_HOST_RE: /static\.xx\.fbcdn\.net|\/rsrc\.php/i,
  BG_URL_RE: /url\((['"]?)(.*?)\1\)/,

  // alt text counts as emoji-only iff BOTH match. EMOJI_ONLY alone would
  // classify alt="123" as emoji: 0-9, # and * are Emoji_Component (keycap
  // bases), so a true pictograph must also be present.
  EMOJI_ONLY_RE: /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u,
  HAS_PICTOGRAPH_RE: /\p{Extended_Pictographic}/u,

  // svg-image avatars render at ~32-40px — below any sane minSize — so the
  // blurAvatars toggle uses its own, lower size floor.
  AVATAR_MIN_SIZE: 20,

  // Classification runs one full viewport ahead of scroll in both directions,
  // so refinement completes before elements become visible.
  IO_ROOT_MARGIN: '100% 0px 100% 0px',
  IDLE_TIMEOUT_MS: 250,

  // How long after the last popup FB_PREVIEW message before snapping the
  // radius back to stored settings (covers the popup dying mid-drag before
  // its debounced storage write ever fires).
  PREVIEW_REVERT_MS: 1500,

  // Hover-scope walk: Facebook stacks video controls / photo overlays as
  // SIBLINGS above the media, often several wrappers up, so the reveal scope
  // must be stamped on the player/photo root — found by walking up while the
  // ancestor still has roughly the media's own footprint. The slack absorbs
  // padding and control bars; feed/grid containers exceed it and stop the
  // walk (stamping those would reveal every tile in a collage at once).
  SCOPE_SLACK_W: 64,
  SCOPE_SLACK_H: 120,
  SCOPE_MAX_UP: 8,

  // 'style' is deliberately absent: Facebook mutates style attributes
  // constantly and observing it over the whole subtree is pathological;
  // inline-bg divs are already blurred by the fail-closed CSS regardless.
  // 'aria-hidden' re-arms carousel slides as they unhide.
  MO_ATTR_FILTER: ['src', 'srcset', 'href', 'aria-hidden']
};

const state = {
  settings: fbValidateSettings(null),
  tabId: null,
  override: undefined,        // per-tab Alt+B override; undefined = follow global
  lastHref: location.href,
  scopeRoot: null,
  mo: null,
  io: null,
  ro: null,
  pending: new Set(),
  idleHandle: 0,
  previewTimer: 0,
  cardSampled: false,
  usedIdleCb: false,
  observing: false,
  listenersAttached: false,
  // Element -> 'queued' | 'deferred' | 'small' | 'marked' | 'off'
  // ('marked'/'off' are terminal unless a source attribute changes;
  //  'deferred'/'small' re-arm via ResizeObserver or attribute mutations.)
  seen: new WeakMap()
};

/* ------------------------------- helpers -------------------------------- */

/* svg <image> candidates are handled via their <svg> root: the marker on the
 * root survives React replacing inner nodes, and hover geometry is sane. */
function canonical(el) {
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
    return el.localName === 'svg' ? el : el.ownerSVGElement;
  }
  return el;
}

function isSvgRoot(el) {
  return el.localName === 'svg' && el.namespaceURI === 'http://www.w3.org/2000/svg';
}

function mediaUrl(el) {
  const tag = el.localName;
  if (tag === 'img') return el.currentSrc || el.src || '';
  if (tag === 'video') return el.currentSrc || el.src || el.poster || '';
  if (isSvgRoot(el)) {
    const im = el.querySelector('image');
    if (!im) return '';
    return (im.href && im.href.baseVal) ||
      im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
  }
  return '';
}

function getScopeRoot() {
  if (state.scopeRoot && state.scopeRoot.isConnected) return state.scopeRoot;
  state.scopeRoot = document.querySelector(CONFIG.SCOPE_SELECTOR);
  return state.scopeRoot;
}

/* ------------------------------ discovery ------------------------------- */

function addPending(el, rearm) {
  el = canonical(el);
  if (!el) return;
  const st = state.seen.get(el);
  if (st !== undefined && !rearm) return;                    // already tracked
  if (isSvgRoot(el) && !state.settings.blurAvatars) return;  // avatars off: never enroll
  state.pending.add(el);
  state.seen.set(el, 'queued');
}

function triage(node, rearm) {
  if (node.matches && node.matches(CONFIG.CANDIDATE_SELECTOR)) addPending(node, rearm);
  if (node.firstElementChild) {
    const found = node.querySelectorAll(CONFIG.CANDIDATE_SELECTOR);
    for (const el of found) addPending(el, rearm);
  }
}

/* A src/srcset/href change on a tracked element: React recycles DOM nodes
 * between posts, so a node classified "off" (UI sprite) can become content.
 * If the new source is definitely content, drop the marker immediately — the
 * fail-closed coarse CSS re-blurs it in the same rendering update — then
 * re-classify. */
function onSourceChanged(target) {
  if (!target || target.nodeType !== 1) return;
  const tag = target.localName;
  if (tag !== 'img' && tag !== 'video' && tag !== 'image') return;
  const el = canonical(target);
  if (!el) return;
  const st = state.seen.get(el);
  if (st === 'off' || st === 'small') {
    const url = mediaUrl(el);
    if (url && CONFIG.CONTENT_HOST_RE.test(url)) el.removeAttribute('data-feedblur');
  }
  addPending(el, true);
}

function onMutations(records) {
  checkNav();
  for (const rec of records) {
    if (rec.type === 'childList') {
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1) triage(node);
      }
    } else if (rec.type === 'attributes') {
      if (rec.attributeName === 'aria-hidden') {
        // A wrapper was hidden/unhidden (carousel slide): re-evaluate its
        // candidate descendants, whose deferred state may now be resolvable.
        if (rec.target.nodeType === 1) triage(rec.target, true);
      } else {
        onSourceChanged(rec.target);
      }
    }
  }
  scheduleFlush();
}

/* Images whose src is set without an attribute mutation we observed (e.g.
 * srcset resolution picking a new resource) still fire load events; capture
 * phase because load/loadedmetadata don't bubble. */
function onMediaLoad(e) {
  const t = e.target;
  if (!t || t.nodeType !== 1) return;
  const tag = t.localName;
  if (tag !== 'img' && tag !== 'video') return;
  onSourceChanged(t);
  scheduleFlush();
}

function scheduleFlush() {
  if (state.idleHandle || state.pending.size === 0 || !state.observing) return;
  if (typeof requestIdleCallback === 'function') {
    state.usedIdleCb = true;
    state.idleHandle = requestIdleCallback(flushQueue, { timeout: CONFIG.IDLE_TIMEOUT_MS });
  } else {
    state.usedIdleCb = false;
    state.idleHandle = setTimeout(() => flushQueue(null), 50);
  }
}

/* Hand pending candidates to the IntersectionObserver. unobserve+observe
 * forces a fresh initial record even for already-observed targets — an async,
 * reflow-free geometry query. All marking happens in the IO callback. */
function flushQueue(deadline) {
  state.idleHandle = 0;
  for (const el of state.pending) {
    state.pending.delete(el);
    if (!el.isConnected) { state.seen.delete(el); continue; }
    state.io.unobserve(el);
    state.io.observe(el);
    if (deadline && deadline.timeRemaining() < 1 && state.pending.size) {
      scheduleFlush();
      return;
    }
  }
}

/* ---------------------------- classification ----------------------------- */

function mark(el, value, rect) {
  el.setAttribute('data-feedblur', value);
  state.seen.set(el, value === 'off' ? 'off' : 'marked');
  state.io.unobserve(el);
  state.ro.unobserve(el);
  if (value !== 'off') {
    stampScope(el, rect);
    if (!state.cardSampled) {
      // First confirmed media: re-sample the cover color from its card
      // surface (boot's sample ran before any cards were marked).
      state.cardSampled = true;
      setTimeout(sampleThemeLuminance, 50);
    }
  }
}

/* Stamp the hover-reveal scope on the media's enclosing player/photo root
 * (see CONFIG.SCOPE_*): hovering overlay controls that are siblings of the
 * media — Facebook's standard video-player structure — must still reveal.
 * Walk up while ancestors keep the media's footprint; the direct parent is
 * the floor. Reading ancestor rects here is reflow-free: this runs inside
 * IntersectionObserver delivery, right after layout. */
function stampScope(el, rect) {
  let scope = el.parentElement;
  if (!scope) return;
  if (!rect) rect = el.getBoundingClientRect();
  let node = scope.parentElement;
  for (let depth = 0; node && node !== document.body && depth < CONFIG.SCOPE_MAX_UP; depth++) {
    const r = node.getBoundingClientRect();
    if (r.width - rect.width > CONFIG.SCOPE_SLACK_W ||
        r.height - rect.height > CONFIG.SCOPE_SLACK_H) break;
    scope = node;
    node = node.parentElement;
  }
  scope.setAttribute('data-feedblur-scope', '');
}

function onIntersections(entries) {
  const scopeRoot = getScopeRoot();
  for (const entry of entries) {
    const el = entry.target;
    const st = state.seen.get(el);
    if (st === 'marked' || st === 'off') { state.io.unobserve(el); continue; }
    if (!entry.isIntersecting) continue;   // far from viewport; fires again on approach
    classify(el, entry.boundingClientRect, scopeRoot);
  }
}

function classify(el, rect, scopeRoot) {
  // 1. Transiently hidden wrappers (carousel neighbors): leave unmarked —
  //    the coarse CSS keeps them fail-closed-blurred while they're invisible —
  //    and let the aria-hidden mutation path re-arm them when they unhide.
  if (el.closest('[aria-hidden="true"]')) {
    state.seen.set(el, 'deferred');
    return;
  }

  // 2. Excluded UI contexts (nav chrome; dialogs deliberately not excluded).
  if (el.closest(CONFIG.EXCLUDE_ROLES_SELECTOR)) { mark(el, 'off'); return; }

  // 3. Scope: [role="main"] when present — but dialogs (photo lightbox,
  //    comment popup) mount at body level and must still be covered:
  //    hover-to-reveal is the universal rule.
  if (scopeRoot && !scopeRoot.contains(el) && !el.closest('[role="dialog"]')) {
    mark(el, 'off');
    return;
  }

  // 4. Size gate — geometry comes from the IO entry: free, no forced reflow.
  //    Sub-threshold elements are marked "off" (the coarse CSS would blur
  //    small scontent stickers otherwise); zero-size lazy placeholders stay
  //    unmarked and re-arm via ResizeObserver / attribute mutations.
  const svg = isSvgRoot(el);
  const min = svg ? CONFIG.AVATAR_MIN_SIZE : state.settings.minSize;
  const w = rect.width, h = rect.height;
  if (w === 0 && h === 0) {
    state.seen.set(el, 'deferred');
    state.ro.observe(el);
    return;
  }
  if (min > 0 && (w < min || h < min)) {
    mark(el, 'off');
    state.seen.set(el, 'small');
    state.ro.observe(el);
    return;
  }

  // 5. Type + source classification.
  if (svg) { mark(el, 'avatar', rect); return; }
  const tag = el.localName;
  if (tag === 'video') { mark(el, 'video', rect); return; }   // blurVideos gates in CSS
  if (tag === 'canvas') { mark(el, 'media', rect); return; }  // no URL exists to inspect
  if (tag === 'img') {
    const url = el.currentSrc || el.src || '';
    if (!url) { state.seen.set(el, 'deferred'); return; }  // load listener re-arms
    if (CONFIG.UI_HOST_RE.test(url)) { mark(el, 'off'); return; }
    const alt = el.getAttribute('alt') || '';
    if (alt && CONFIG.HAS_PICTOGRAPH_RE.test(alt) && CONFIG.EMOJI_ONLY_RE.test(alt)) {
      mark(el, 'off');
      return;
    }
    mark(el, 'media', rect);
    return;
  }
  // Background-image element — the one place we pay for getComputedStyle,
  // after every cheaper gate has passed.
  const bg = getComputedStyle(el).backgroundImage || '';
  const m = CONFIG.BG_URL_RE.exec(bg);
  if (!m || CONFIG.UI_HOST_RE.test(m[2])) { mark(el, 'off'); return; }
  mark(el, 'media', rect);
}

/* Lazy placeholders that gain size without any attribute change (CSS class
 * flips). Only 'deferred'/'small' elements are ever enrolled, so the set
 * stays small and self-draining. */
function onResizes(entries) {
  for (const entry of entries) {
    const el = entry.target;
    const st = state.seen.get(el);
    if (st !== 'small' && st !== 'deferred') { state.ro.unobserve(el); continue; }
    const w = entry.contentRect.width, h = entry.contentRect.height;
    const min = isSvgRoot(el) ? CONFIG.AVATAR_MIN_SIZE : state.settings.minSize;
    const passes = st === 'deferred' ? (w > 0 || h > 0) : (w >= min && h >= min);
    if (!passes) continue;
    if (st === 'small') el.removeAttribute('data-feedblur'); // fail closed while re-checking
    state.ro.unobserve(el);
    addPending(el, true);
  }
  scheduleFlush();
}

function sweep() {
  const root = document.body;
  if (!root) return;
  for (const el of root.querySelectorAll(CONFIG.CANDIDATE_SELECTOR)) addPending(el);
  scheduleFlush();
}

/* minSize changed: past size decisions are baked into markers, so re-check
 * every marked element. Only 'small' markers are dropped up front (fail
 * closed: content stays blurred while re-checking). */
function resweepForMinSize() {
  for (const el of document.querySelectorAll('[data-feedblur]')) {
    if (state.seen.get(el) === 'small') el.removeAttribute('data-feedblur');
    addPending(el, true);
  }
  scheduleFlush();
}

/* ------------------------------ navigation ------------------------------- */

/* Facebook is a SPA. Content scripts run in an isolated world, so patching
 * history.pushState here would never see the page's own calls (each world has
 * its own wrappers); a MAIN-world shim would work but is page-visible and
 * fragile. Instead: every SPA navigation mutates the DOM, so a URL diff at
 * the top of the MutationObserver callback catches pushState/replaceState
 * navigations for free, popstate covers back/forward, and the Navigation API
 * is attached as belt-and-suspenders where available. */
function checkNav() {
  if (location.href === state.lastHref) return;
  state.lastHref = location.href;
  state.scopeRoot = null;   // [role="main"] is often replaced on navigation
  sweep();
  sampleThemeLuminance();
}

/* ------------------------------ theme sample ----------------------------- */

/* The cover effect fades media toward --feedblur-cover-lum (see content.css).
 * Sample the real page instead of guessing the theme: works for both FB
 * themes and for FB-side theme forcing that ignores the OS setting. Covered
 * media sits on post CARDS, which are a few shades lighter than the page
 * background in dark mode (measured live: card rgb(37,39,40) vs body
 * rgb(28,28,29)) — so prefer the OUTERMOST opaque ancestor background of an
 * actual marked media element (the card surface), falling back to body.
 * Re-sampled on SPA navigation, system theme changes, tab re-focus, and once
 * after the first element is marked (cards exist by then). */
/* NEAR-OPAQUE only: translucent tints (e.g. the "Create story" tile's
 * rgba(255,255,255,0.1) hover wash) are washes over a surface, not the
 * surface itself — sampling one as white painted white patches in dark mode. */
function parseColor(bg) {
  const m = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?\s*\)/.exec(bg || '');
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) < 0.99) return null;
  return (Number(m[1]) + Number(m[2]) + Number(m[3])) / 765;
}

function sampleThemeLuminance() {
  if (!document.body) return;
  try {
    let lum = null;
    // Walk up from LARGE marked media (ordinary post photos) — the first
    // marked element in DOM order can be an atypical tile whose ancestry
    // carries no real surface color. Outermost opaque ancestor = the card.
    const media = [...document.querySelectorAll('[data-feedblur="media"], [data-feedblur="video"]')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
      .slice(0, 8);
    for (const { el } of media) {
      let found = null;
      let n = el.parentElement;
      while (n && n !== document.body) {
        const l = parseColor(getComputedStyle(n).backgroundColor);
        if (l !== null) found = l;
        n = n.parentElement;
      }
      if (found !== null) { lum = found; break; }
    }
    if (lum === null) lum = parseColor(getComputedStyle(document.body).backgroundColor);
    if (lum === null) return;      // nothing opaque found: keep current value
    document.documentElement.style.setProperty('--feedblur-cover-lum', lum.toFixed(3));
  } catch (e) { /* keep the current value */ }
}

/* --------------------- will-change performance hint ---------------------- */

function onTransitionRun(e) {
  if (e.propertyName !== 'filter') return;
  const t = e.target;
  if (t && t.nodeType === 1) t.classList.add('feedblur-anim');
}

function onTransitionDone(e) {
  if (e.propertyName !== 'filter') return;
  const t = e.target;
  if (t && t.nodeType === 1) t.classList.remove('feedblur-anim');
}

/* ------------------------- settings & tab state -------------------------- */

function applyRootState() {
  fbApplyRootState(state.settings, state.override);
}

function onStorageChanged(changes, area) {
  if (area === 'sync') {
    let minSizeChanged = false;
    let avatarsTurnedOn = false;
    for (const key of Object.keys(changes)) {
      if (!(key in FB_SETTINGS_SCHEMA)) continue;
      const next = fbValidateValue(key, changes[key].newValue);
      const prev = state.settings[key];
      if (next === prev) continue;
      state.settings[key] = next;
      if (key === 'minSize') minSizeChanged = true;
      if (key === 'blurAvatars' && next) avatarsTurnedOn = true;
    }
    // Root attributes + custom properties: every flip is instant CSS-only.
    // A committed write also supersedes any in-flight popup preview.
    clearTimeout(state.previewTimer);
    applyRootState();
    // The two exceptions that need a (cheap) re-scan: size decisions are
    // baked into markers, and avatars are only enrolled while the setting is on.
    if (minSizeChanged) resweepForMinSize();
    if (avatarsTurnedOn) sweep();
  } else if (area === 'session' && state.tabId !== null) {
    const key = 'tabState:' + state.tabId;
    if (key in changes) {
      state.override = changes[key].newValue;   // undefined = follow global again
      applyRootState();
    }
  }
}

function onRuntimeMessage(msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === 'FB_PING') {
    sendResponse({ ok: true });
  } else if (msg.type === 'FB_PREVIEW') {
    // Ephemeral live preview while a popup slider drags (messages have no
    // storage quota); the committed storage write supersedes it. If the popup
    // dies before its debounced write fires, no onChanged event ever arrives —
    // the revert timer snaps back to stored settings instead of leaving the
    // preview values applied for the rest of the tab session.
    const rootStyle = document.documentElement.style;
    if (msg.blurRadius !== undefined) {
      rootStyle.setProperty('--feedblur-radius',
        fbValidateValue('blurRadius', msg.blurRadius) + 'px');
    }
    if (msg.coverOpacity !== undefined) {
      rootStyle.setProperty('--feedblur-cover',
        String(fbValidateValue('coverOpacity', msg.coverOpacity) / 100));
    }
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(applyRootState, CONFIG.PREVIEW_REVERT_MS);
  }
}

/* ------------------------------- lifecycle ------------------------------- */

function startObservers() {
  if (state.observing) return;
  state.observing = true;
  state.mo = new MutationObserver(onMutations);
  state.mo.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    // Local names, namespace-agnostic: 'href' also catches xlink:href.
    attributeFilter: CONFIG.MO_ATTR_FILTER
  });
  state.io = new IntersectionObserver(onIntersections, {
    root: null,
    rootMargin: CONFIG.IO_ROOT_MARGIN,
    threshold: 0
  });
  state.ro = new ResizeObserver(onResizes);
  sweep();
}

function stopObservers() {
  if (!state.observing) return;
  state.observing = false;
  state.mo.disconnect();
  state.io.disconnect();
  state.ro.disconnect();
  if (state.idleHandle) {
    if (state.usedIdleCb) cancelIdleCallback(state.idleHandle);
    else clearTimeout(state.idleHandle);
    state.idleHandle = 0;
  }
  state.pending.clear();
}

function attachListeners() {
  if (state.listenersAttached) return;
  state.listenersAttached = true;
  document.addEventListener('load', onMediaLoad, true);
  document.addEventListener('loadedmetadata', onMediaLoad, true);
  document.addEventListener('transitionrun', onTransitionRun, true);
  document.addEventListener('transitionend', onTransitionDone, true);
  document.addEventListener('transitioncancel', onTransitionDone, true);
  window.addEventListener('popstate', checkNav);
  try {
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', sampleThemeLuminance);
  } catch (e) { /* ignore */ }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sampleThemeLuminance();
  });
  if (typeof navigation !== 'undefined' && navigation.addEventListener) {
    try {
      // Not guaranteed to fire in isolated worlds — free extra, never load-bearing.
      navigation.addEventListener('navigate', () => setTimeout(checkNav, 0));
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('pagehide', (e) => {
    // Keep observers alive when entering the back/forward cache: the frozen
    // page costs nothing, and disconnected observers would permanently orphan
    // every 'queued'/'deferred'/'small' element after restore (state.seen
    // survives bfcache, so a plain re-sweep would skip them all).
    if (!e.persisted) stopObservers();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !state.observing) startObservers();
  });
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
}

async function boot() {
  if (typeof FB_BOOT !== 'undefined' && FB_BOOT.ready) {
    try { await FB_BOOT.ready; } catch (e) { /* fall through with defaults */ }
    if (FB_BOOT.settings) state.settings = FB_BOOT.settings;
    state.tabId = FB_BOOT.tabId;
    state.override = FB_BOOT.override;
  } else {
    try { state.settings = await fbLoadSettings(); } catch (e) { /* defaults */ }
  }
  applyRootState();
  attachListeners();
  // Re-read authoritative state now that the storage listener is live: an
  // Alt+B press or a settings change landing between boot.js's document_start
  // snapshot and this point would otherwise be lost forever — onChanged does
  // not replay missed events. Listener first, then read: a write landing in
  // between is seen by both (harmless); the other order leaves a gap. The
  // read also completes before startObservers() so the initial sweep uses
  // fresh minSize/blurAvatars values.
  try { state.settings = await fbLoadSettings(); } catch (e) { /* keep snapshot */ }
  if (state.tabId !== null) {
    try {
      const key = 'tabState:' + state.tabId;
      const got = await chrome.storage.session.get(key);
      state.override = got[key];
    } catch (e) { /* keep snapshot */ }
  }
  applyRootState();
  startObservers();
  sampleThemeLuminance();   // replace boot.js's prefers-color-scheme guess
}

boot();
