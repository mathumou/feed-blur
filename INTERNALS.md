# Internals

Notes on how detection works, why it's built this way, and what to tune when
Facebook changes their DOM.

## Why no class selectors

Facebook's class names are obfuscated and rotate between builds
(`x15mokao x1ga7v0g …`), so any selector keyed off them dies within weeks.
This extension never reads a class name. It uses three stable signals:

1. **Source host.** Content images come from `scontent-*.fbcdn.net`
   (link-preview thumbnails from `external-*.fbcdn.net`). UI sprites live
   under `/rsrc.php` and emoji on `static.xx.fbcdn.net`. Unknown hosts
   (blob: video, data:, third-party CDNs) are included — better to blur too
   much than too little.
2. **ARIA roles.** Scanning is scoped to `[role="main"]`, plus
   `[role="dialog"]` (lightbox, comment popups — they mount at body level).
   Media inside `[role="banner"]`, `[role="navigation"]` and `[role="menu"]`
   is skipped. `[aria-hidden="true"]` subtrees are deferred until they
   unhide, because carousels toggle that attribute.
3. **Rendered size.** Both dimensions must be ≥ `minSize` (default 100px),
   which excludes stickers, reactions and most chrome regardless of host.
   Images whose `alt` text is purely emoji are also skipped.

## The no-flash design

Chrome injects `content_scripts.css` before the page's first paint, and
`content.css` is written fail-closed: coarse attribute selectors
(`img[src*="scontent"]`, bare `video`, …) blur likely content media by
default, with zero JavaScript. Attribute matching is atomic with respect to
paint — when Facebook lazily sets `src` on an `<img>`, style recalc happens
in the same rendering update — so there is no frame where a content image
renders unblurred, no matter how slow script execution is.

`content.js` (at `document_idle`) only refines: a MutationObserver feeds an
idle-batched queue into an IntersectionObserver (rootMargin one full
viewport, so classification finishes before elements become visible; all
geometry comes from `entry.boundingClientRect`, zero forced reflows).
Confirmed elements get `data-feedblur="media|video|avatar"`, false positives
get `data-feedblur="off"`. Every coarse selector carries
`:not([data-feedblur])`, so it retires per element once classified.

Consequences worth knowing:

- With the extension disabled, the page can blur for a few milliseconds at
  load until `boot.js` (document_start) stamps the off switch on `<html>`.
  A brief unwanted blur is safe; a brief unwanted reveal is not.
- Small scontent images (stickers) blur briefly until classification marks
  them off, usually before they're in the viewport.

Hover reveal, reveal delay and re-blur are pure CSS (`:hover`,
`transition-delay`), so there's no JS on the hover path. Keyboard focus
(`:focus-visible` on the element or an ancestor) reveals too, with no delay.
Settings are gated by attributes on `<html>` plus CSS custom properties, so
changes restyle instantly with no re-scan (exceptions: `minSize` and
enabling `blurAvatars` trigger one cheap re-sweep).

## The cover mode

Cover fades media toward the page background inside the same filter chain:
`contrast(1 − c)` collapses pixels toward gray, `brightness()` steers that
gray to the sampled surface luminance, and the blur radius scales down as
cover rises (`radius × (1 − c)`).

The radius scaling is load-bearing, found the hard way on the live site:
Chrome's compositor lets contrast's +0.5 intercept interact with the blur's
semi-transparent edge band regardless of the declared filter order, painting
a bright halo ring about one radius wide around covered media. At full cover
the blur is gone (a flat patch needs none) and the ring with it. Don't
"simplify" this back to a constant radius.

The target color (`--feedblur-cover-lum`) is sampled from the post card
surface behind real marked media — the outermost near-opaque ancestor
background, preferring large post photos over odd tiles like "Create story"
(whose only painted ancestor is a translucent white wash that once got
sampled as solid white). Falls back to `body`. Re-sampled on navigation,
system theme changes and tab re-focus.

Why not a real overlay: pseudo-elements don't render on replaced elements
like `img`/`video`, and an `opacity` fade lets Facebook's own dark
letterbox/placeholder backdrops show through as wrong-colored boxes.

## Settings storage

`chrome.storage.sync`, flat keys, clamped on every read:

| Key | Default | Range |
|---|---|---|
| `enabled` | `true` | — |
| `blurRadius` | `8` | 1–40 px |
| `blurVideos` | `true` | — |
| `blurAvatars` | `false` | — |
| `unblurOnHover` | `true` | — |
| `revealDelayMs` | `0` | 0–1000 ms |
| `minSize` | `100` | 0–600 px |
| `coverOpacity` | `0` | 0–100 % |

The per-tab Alt+B override lives in `chrome.storage.session` keyed by tab id
(survives service-worker restarts and page reloads, wiped on browser exit).
Slider writes are throttled: sync allows 120 writes/min, and a held arrow
key fires a `change` event per keystroke.

## When Facebook changes their DOM

All tunables live in the `CONFIG` object at the top of `content.js`, and the
coarse selectors at the top of `content.css` (keep both in sync).

| Symptom | Knob |
|---|---|
| Feed media unblurred everywhere | `CONTENT_HOST_RE` / the `src*="scontent"` selectors — check what host FB serves images from now |
| One surface unblurred | `SCOPE_SELECTOR` — check whether it still lives inside `[role="main"]` |
| Right-rail ads should blur too | add `,[role="complementary"]` to `SCOPE_SELECTOR` |
| Nav/menus getting blurred | `EXCLUDE_ROLES_SELECTOR`, `UI_HOST_RE` |
| Visible media stuck blurred in a hidden-marked wrapper | drop the `[aria-hidden="true"]` deferral in `classify()` |
| Stickers/story tray blurred or not | `minSize`; story-tray cards are ~112px |
| Avatars ignored with blurAvatars on | `AVATAR_MIN_SIZE` (avatars are 32–40px) |
| New posts blur late on fast scroll | `IO_ROOT_MARGIN`, `IDLE_TIMEOUT_MS` |
| Hovering video controls doesn't reveal | `SCOPE_SLACK_W/H`, `SCOPE_MAX_UP` — the hover scope is stamped on the nearest ancestor still matching the media's footprint |
| Want dialog media revealed on click instead of hover | add `[role="dialog"]` to `EXCLUDE_ROLES_SELECTOR` |
| Background-image tiles unblurred | only inline-style backgrounds are detected; class-based CSS backgrounds are a known blind spot |

Known gaps: Picture-in-Picture leaks unblurred frames (CSS filters can't
reach that window), and chat/right-rail media outside `[role="main"]` is
left alone by scope design.

## Manual test checklist

1. No-flash: DevTools Performance, 6× CPU + Fast 3G, hard reload, record
   with screenshots, scrub frame by frame — no feed image ever sharp before
   blurred.
2. Fling-scroll 10+ posts; media arrives already blurred.
3. Hover reveals ~150ms, re-blurs on mouse-out; with `revealDelayMs: 500`
   quick passes never reveal a frame.
4. Drag the strength slider with a feed tab visible: instant restyle, no
   quota errors after a minute of dragging.
5. Nav icons, reactions, emoji, avatars stay sharp; `blurAvatars` on blurs
   avatars.
6. Click a blurred photo: the lightbox opens with the photo also blurred;
   hover reveals it; Esc back, the thumbnail is blurred again.
7. Reels autoplay stays blurred while playing; hover reveals live video;
   fullscreen unblurs.
8. SPA navigation (feed → profile → back → group) keeps everything blurred
   with no reload.
9. Tab to a post link wrapping media: it reveals, re-blurs when focus moves.
10. Alt+B: badge shows, tab unblurs, survives reload, works right after the
    service worker is killed; other tabs unaffected.
11. Two tabs + popup + options open at once stay consistent.
12. Cover at 100%: photo areas melt into the post card background in both
    themes; hover still reveals.
