# Feed Blur

A Chrome extension that blurs photos and videos in your Facebook feed while
you scroll — move your mouse over anything to reveal it (keyboard focus
reveals too). Manifest V3, vanilla JS, no build step, no frameworks, no npm.
No network requests, no analytics, no remote code; the only permission is
`storage`, host-limited to `*.facebook.com`.

## Install (load unpacked)

1. (Only if `icons/` is missing) generate the placeholder icons:
   `python3 tools/make_icons.py`
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open or reload any facebook.com tab. Tabs that were already open before the
   install need one reload — the popup will tell you.

Keyboard shortcut: **Alt+B** toggles blur for the current tab (a per-tab
override on top of the global switch; the toolbar badge shows `ON`/`OFF` while
an override is active). Customize it at `chrome://extensions/shortcuts`.

## Settings

Stored in `chrome.storage.sync`, validated and clamped on every read. All
changes apply live to every open Facebook tab — no reload.

| Key | Type | Default | Range | Meaning |
|---|---|---|---|---|
| `enabled` | bool | `true` | — | Master switch (global; Alt+B overrides per tab) |
| `blurRadius` | number | `8` | 1–40 | Blur strength in px (`--feedblur-radius`) |
| `blurVideos` | bool | `true` | — | Blur `<video>`, incl. Reels/autoplay |
| `blurAvatars` | bool | `false` | — | Blur `<svg><image>` profile pictures |
| `unblurOnHover` | bool | `true` | — | Off = media stays blurred under the pointer |
| `revealDelayMs` | number | `0` | 0–1000 | Hold hover this long before revealing |
| `minSize` | number | `100` | 0–600 | Media smaller than this (either dimension) is never blurred |
| `coverOpacity` | number | `0` | 0–100 | Fade blurred media into the page background; at 100 it vanishes completely |

The popup has the master switch, the strength slider (with live preview), and
the per-tab state; `options.html` exposes everything.

## How detection works (and why there are no class selectors)

Facebook's class names are obfuscated and **rotate between builds**
(`x15mokao x1ga7v0g …`), so any selector keyed off them dies silently within
weeks. Feed Blur never reads a class name. It uses three stable signals:

1. **Source host.** Real content images are served from
   `scontent-*.fbcdn.net` (link-preview thumbnails from
   `external-*.fbcdn.net`). UI sprites live under `/rsrc.php` and emoji on
   `static.xx.fbcdn.net`. The exclusion list is small and stable; unknown
   hosts (blob: video, data:, third-party CDNs) are **included** — a privacy
   tool should fail toward blurring.
2. **Structure.** Scanning is scoped to `[role="main"]` (falling back to the
   whole document when it's absent). Media inside `[role="banner"]`,
   `[role="navigation"]`, `[role="menu"]`, `[role="dialog"]` is skipped, and
   `[aria-hidden="true"]` subtrees are deferred until they unhide (carousels
   toggle this). ARIA roles are accessibility contract, not styling — they
   survive Facebook's DOM churn far better than any structural selector.
3. **Rendered size.** Both dimensions must be ≥ `minSize` (default 100px),
   which excludes stickers, reaction icons, and most chrome regardless of
   host. Images whose `alt` text is purely emoji are also skipped.

### The no-FOUC design (the important part)

Chrome injects `content_scripts.css` **before the page's first paint**, and
`content.css` is written *fail-closed*: coarse attribute selectors
(`img[src*="scontent"]`, bare `video`, …) blur likely content media **by
default, with zero JavaScript**. Attribute matching is atomic with respect to
paint — when Facebook lazily sets `src` on an `<img>`, style recalc happens in
the same rendering update that would paint the pixels — so there is no
possible frame where a content image renders unblurred, no matter how slow
script execution is.

`content.js` (at `document_idle`) then *refines*: a MutationObserver feeds an
idle-batched queue into an IntersectionObserver (rootMargin one full viewport,
so classification finishes before elements become visible; all geometry comes
from `entry.boundingClientRect` — zero forced reflows). Confirmed elements get
`data-feedblur="media|video|avatar"`; false positives get
`data-feedblur="off"`. Every coarse selector carries `:not([data-feedblur])`,
so it self-retires per element once classified — "off" simply matches nothing.

Consequences of fail-closed worth knowing:

- With the extension **disabled**, the page can blur for a few milliseconds at
  load until `boot.js` (at `document_start`) stamps `data-feedblur-off` on
  `<html>` — a brief unwanted blur is safe; a brief unwanted reveal is not.
- Small scontent images (stickers) blur briefly until classification marks
  them off — usually before they're ever in the viewport.

The **cover** setting fades blurred media toward the page background inside
the same CSS filter chain: `contrast(1 − c)` collapses the pixels toward
gray, `brightness()` steers that gray to the sampled surface luminance, and
the blur radius **scales down as cover rises** (`radius × (1 − c)`). The
scaling is load-bearing, verified live on facebook.com: Chrome's compositor
lets contrast's +0.5 intercept interact with the blur's semi-transparent
edge band regardless of the declared function order, painting a bright halo
ring ~radius wide around covered media — at full cover the blur is gone (a
flat patch needs none) and the ring with it. `--feedblur-cover-lum` is
sampled from the post **card** surface behind real marked media (cards are a
few shades lighter than the page background in dark mode), falling back to
`body`; re-sampled on navigation, system-theme changes, and tab re-focus. At
100% the media renders as an opaque card-colored patch, which also covers
Facebook's own dark letterbox/placeholder backdrops behind the media — an
`opacity` fade would let those show through as wrong-colored boxes, and true
overlay DOM is impossible (pseudo-elements don't render on replaced elements
like `img`/`video`). Hovering or focusing reveals covered media exactly like
blurred media — `filter: none` clears blur and cover in one transition.

Hover reveal, reveal delay, and re-blur are **pure CSS**
(`:hover`/`transition-delay`), so there is zero JS on the hover path.
Keyboard focus (`:focus-visible` on the element or an ancestor) also reveals,
with no delay. All settings are gated by attributes on `<html>` and two CSS
custom properties, so every settings change restyles instantly with no
re-scan (exceptions: changing `minSize` or enabling `blurAvatars` triggers
one cheap re-sweep).

## If Facebook changes their DOM, tune these constants

Everything tunable lives in the `CONFIG` object at the top of `content.js`
(and the coarse selectors at the top of `content.css` — keep them in sync).

| Symptom | Knob |
|---|---|
| Feed media unblurred everywhere | `CONTENT_HOST_RE` / the `src*="scontent"` selectors in content.css — check what host FB serves images from now (`DevTools → Network → Img`) |
| Media in one surface unblurred | `SCOPE_SELECTOR` — check whether that surface still lives inside `[role="main"]`; broaden or add a selector |
| Right-rail ads should blur too | `SCOPE_SELECTOR: '[role="main"],[role="complementary"]'` |
| Nav/menus/chrome getting blurred | `EXCLUDE_ROLES_SELECTOR`, `UI_HOST_RE` |
| Visible media stays unblurred inside a hidden-marked wrapper | drop the `[aria-hidden="true"]` deferral in `classify()` |
| Stickers/story tray blurred (or not) | `minSize` setting; story-tray cards are ~112px, so `minSize ≥ 113` unblurs the tray |
| Avatars ignored with blurAvatars on | `AVATAR_MIN_SIZE` (avatars are 32–40px, below any sane `minSize`) |
| New posts blur late on fast scroll | `IO_ROOT_MARGIN` (default one full viewport), `IDLE_TIMEOUT_MS` |
| Hovering video controls/overlays doesn't reveal | `SCOPE_SLACK_W`/`SCOPE_SLACK_H`/`SCOPE_MAX_UP` — the hover scope is stamped on the nearest ancestor still matching the media's footprint; raise the slack if FB's player root grows padding |
| Cover color slightly off from the cards | Cover matches the sampled `body` background; FB cards are a touch lighter/darker than the page behind them. Cosmetic — tune `sampleThemeLuminance()` if it bothers you |
| Background-image tiles unblurred | They're only detected via inline `style` (`div[style*="background-image"]`); class-based CSS backgrounds are a known blind spot |
| Want dialog media (lightbox, comment popup) revealed on click instead of hover | add `[role="dialog"]` to `EXCLUDE_ROLES_SELECTOR` |

## Known-weak layouts

| Layout | Expected behavior |
|---|---|
| Photo lightbox / theater / comment popup | **Blurred like everything else** — hover-to-reveal is the universal rule, including inside `[role="dialog"]`. (The original spec excluded dialogs; overridden by explicit user preference. One CONFIG string restores it.) |
| Marketplace grid | Should work — detection keys off hosts + size, not feed structure. Product tiles are scontent imgs inside `[role="main"]`. |
| Stories tray (top of feed) | Blurred at default `minSize`; fragile above ~113px (cards are ~112px on the short side). |
| Stories / Reels fullscreen viewers | Blurred if mounted inside `[role="main"]`; unblurred if Facebook mounts them as dialogs (same intent argument as the lightbox). Verify after FB updates. |
| Comment-attached photos | Blurred (comments are `[role="article"]`, which is *not* excluded). Some render just under 100px — lower `minSize` if missed. |
| Class-based CSS background images | Not detected (documented blind spot; inline-style backgrounds are). |
| Picture-in-Picture | Leaks unblurred frames — CSS filters cannot reach the PiP window. Unfixable without mutating page behavior. |
| Chat / right rail | Outside `[role="main"]`, so unblurred by scope design (see tuning table). |

## Spec notes / deliberate deviations

- `[role="dialog"]` media (photo lightbox, comment popups) **is blurred** —
  the original spec excluded dialogs, but hover-to-reveal-everywhere was
  preferred in testing. Dialogs count as in-scope even though they mount
  outside `[role="main"]`.
- The emoji-only `alt` check requires **both** "every char is emoji-ish" *and*
  "contains at least one pictograph": `\p{Emoji_Component}` alone matches
  `0-9`, `#`, `*` (keycap bases), which would wrongly exclude `alt="123"`.
- `blurAvatars` uses its own `AVATAR_MIN_SIZE` (20px) — under the main
  `minSize` gate the toggle would be a silent no-op.
- `settings.js` (shared schema, loaded in all four contexts) and `boot.js`
  (document_start settings stamp) are two files beyond the original
  deliverables list; both exist to avoid drift/flash, not to add features.

## Manual test checklist

1. **No-flash on fresh load** — DevTools → Performance, CPU 6× + Fast 3G,
   hard reload; record a trace with Screenshots and scrub frame-by-frame: no
   above-the-fold feed image may ever appear sharp before blurring.
2. **Infinite scroll** — fling through 10+ posts; every image/video is already
   blurred when it enters the viewport.
3. **Hover** — reveal ~150ms, smooth re-blur on mouse-out (instant for media
   the pipeline hasn't classified yet — the fail-safe direction); with
   `revealDelayMs: 500`, quick pass-overs never reveal a frame.
4. **Live slider** — drag strength with a feed tab visible: instant restyle;
   drag continuously for 60s: no quota errors in the popup console.
5. **Chrome untouched** — top nav, sidebar icons, reactions, inline emoji all
   sharp.
6. **Avatars** — sharp by default; toggle `blurAvatars` → comment/post
   avatars blur; toggle back → sharp.
7. **Click-through** — click a blurred photo: the lightbox opens with the
   full-size photo also blurred; hover reveals it; Esc back: the feed
   thumbnail is blurred again.
8. **Video** — feed Reels autoplay stays blurred while playing; hover reveals
   live video; fullscreen unblurs.
9. **SPA nav** — feed → profile → back → group, no reloads: media blurred in
   every view.
10. **Keyboard** — Tab until focus lands on a post link wrapping media: it
    reveals; blur returns when focus moves on.
11. **Alt+B** — tab unblurs, badge shows `OFF`, popup shows "forced OFF";
    survives reload; other FB tabs unaffected; works right after killing the
    service worker (`chrome://serviceworker-internals`).
12. **Consistency** — two FB tabs + popup + options open at once: every
    change propagates everywhere with no reload.
13. **Cover** — set Cover to 100%: photo areas melt into the post card
    background (try both light and dark theme); hover still reveals; setting
    it back to 0% restores plain blur.
