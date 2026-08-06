# Feed Blur

Blurs photos and videos in your Facebook feed. Move your mouse over anything
to reveal it; move away and it blurs again. New posts get blurred as you
scroll, with no flash of unblurred content.

No tracking, no network requests, no build step. The only permission is
`storage`, limited to facebook.com.

## Install

1. Clone or download this repo
2. Open `chrome://extensions` and turn on Developer mode
3. Click "Load unpacked" and pick this folder
4. Reload any Facebook tabs that were already open

## Use

The toolbar icon has the on/off switch and blur strength. The options page
has the rest:

- blur strength and toggles for videos and profile pictures
- reveal delay, so quick mouse passes don't reveal anything
- cover, which fades media into the page background (100% hides it completely)
- minimum size, so icons and stickers are left alone

Everything applies to open tabs immediately, no reload needed.

`Alt+B` toggles blurring for the current tab only; the toolbar badge shows
when a tab is overridden. You can change the shortcut at
`chrome://extensions/shortcuts`.

If Facebook changes their markup and something stops working, see
[INTERNALS.md](INTERNALS.md) — detection is based on hosts, roles and sizes
(never class names), and all tunable constants sit at the top of
`content.js`.

MIT license.
