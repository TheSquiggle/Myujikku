# ミュージック! (Myujikku)

An anime-flavoured 4-key rhythm game in the spirit of **osu!mania** — falling notes,
long notes, OD-based judgement windows, combo, HP drain and a full results screen.

Runs in the browser. **No dependencies, no build step, no bundled art or sound files** —
every graphic (logo, notes, receptors, hit bursts, fallback cover art) is drawn
procedurally on a canvas at runtime, and every sound effect (hitsounds, menu blips,
applause, fail jingle) is synthesised with the Web Audio API.

![4K mania](https://img.shields.io/badge/mode-4K%20mania-ff3d8b) ![deps](https://img.shields.io/badge/dependencies-0-38e8ff)

---

## Quick start

```bash
node server.js
```

Then open <http://localhost:8080>.

Options:

```bash
node server.js --port 9000 --songs "path/to/beatmaps"
```

The server indexes every `.mjk` archive in the songs folder (default:
`ミュージック！ beatmaps/`), extracts the chart metadata and background art into
`.cache/`, and serves the song list at `GET /api/songs`. Hit `GET /api/reload`
after adding new beatmaps.

You can also open `index.html` directly from disk and drag a `.mjk` file onto the
window — the whole archive is unpacked client-side.

---

## Controls

| Key | Action |
| --- | --- |
| `D` `F` `J` `K` | lanes 1–4 (rebindable in settings) |
| `Esc` | pause / resume · settings from song select |
| `` ` `` | quick retry |
| `↑` `↓` | change song |
| `←` `→` | change difficulty |
| `Enter` | play |
| `/` | focus search |

---

## Scoring

Judgement windows follow osu!mania's OD formula (ms):

| Judgement | Window | Accuracy weight | Value |
| --- | --- | --- | --- |
| 極 MAX | 16.5 | 100% | 320 |
| 完璧 PERFECT | 64 − 3·OD | 100% | 300 |
| グレート GREAT | 97 − 3·OD | 66.7% | 200 |
| グッド GOOD | 127 − 3·OD | 33.3% | 100 |
| メー MEH | 151 − 3·OD | 16.7% | 50 |
| ミス MISS | 188 − 3·OD | 0% | 0 |

Score is out of **1,000,000**: 700k weighted by hit value, 300k by combo
progression — an unbroken full combo of perfect hits scores exactly 1,000,000.

Long notes are one judgement each: the head sets the grade, and releasing early
downgrades it to a miss. Releasing late (within 1.5× the MEH window) is judged on
the worse of head and release.

Grades: `SS` (≥99% with no GOOD/MEH/MISS) · `S` ≥95% · `A` ≥90% · `B` ≥80% ·
`C` ≥70% · `D` · `F` (HP depleted).

Personal bests are stored per song+difficulty in `localStorage`. Autoplay runs and
failed runs are never submitted.

---

## Beatmap format — `.mjk`

A `.mjk` file is a plain zip archive:

```
audio.mp3    the track                     (required)
chart.mjc    the chart, JSON               (required)
BG.jpg       still background              (optional)
video.mp4    background video              (optional)
```

`chart.mjc`:

```jsonc
{
  "format": "mjc",
  "version": 1,
  "meta": {
    "title": "…", "titleUnicode": "…",
    "artist": "…", "artistUnicode": "…",
    "creator": "…", "source": "…", "tags": "…",
    "audio": "audio.mp3", "video": "video.mp4", "background": "BG.jpg"
  },
  "difficulties": {
    "Insane": {
      "keys": 4, "od": 8, "hp": 6, "noteCount": 476,
      "notes": [
        { "t": 3941, "lane": 2, "type": "tap" },
        { "t": 4901, "lane": 2, "type": "hold", "end": 5141 }
      ]
    }
  }
}
```

`t`/`end` are milliseconds from the start of the audio; `lane` is **1-based**.

### Difficulty rating

Charts are rated in stars from notes-per-second, per-column strain (how often one
finger is asked to repeat) and chord density — see `starRating()` in
[`src/chart.js`](src/chart.js). The same function is mirrored in `server.js` so the
song list can be indexed without opening the audio.

---

## Project layout

```
index.html        markup for every screen
server.js         zero-dependency static server + beatmap indexer
src/style.css     the whole UI
src/main.js       screens, song library, settings, results
src/game.js       the mania engine: timing, judgement, scoring, rendering
src/chart.js      .mjk loading + star rating
src/skin.js       procedural graphics (notes, receptors, logo, cover art)
src/audio.js      song clock + synthesised hitsounds and SFX
src/zip.js        zip reader built on DecompressionStream
src/store.js      settings + local score records
```

### Timing

The song clock reads directly from the Web Audio context
(`AudioContext.currentTime`) rather than `requestAnimationFrame`, so judgement
stays sample-accurate even when frames drop. A 2-second silent lead-in runs off
`performance.now()` before the audio starts.

---

## Requirements

Node 18+ and a browser with `DecompressionStream` (Chrome/Edge 80+, Firefox 113+,
Safari 16.4+).

## Credits

Beatmaps in `ミュージック！ beatmaps/` were converted from community osu! mapsets;
song, art and chart credits belong to their original creators, listed in each
chart's `meta` block. The engine, UI and all generated assets are part of this
project.
