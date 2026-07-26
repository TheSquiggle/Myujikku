<div align="center">

# ミュージック! (Myujikku)

### *An anime-inspired 4-key rhythm game for the web.*

[![Mode](https://img.shields.io/badge/Mode-4K%20Mania-ff3d8b?style=for-the-badge)](https://github.com/)
[![Dependencies](https://img.shields.io/badge/Dependencies-0-38e8ff?style=for-the-badge)](https://github.com/)
[![Node](https://img.shields.io/badge/Node.js-18+-5FA04E?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Web Audio](https://img.shields.io/badge/Web_Audio-API-orange?style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)

*Inspired by **osu!mania**, built entirely with vanilla JavaScript.*

**No frameworks • No dependencies • No build step • No bundled assets**

</div>

---

## ✨ Features

- 🎵 Classic **4-key mania** gameplay
- 🎯 osu!mania-style OD judgement windows
- 🟢 Hold notes, HP drain, combo, grading, and score calculation
- 📊 Full results screen with accuracy breakdown
- ⭐ Automatic star rating generation
- 🌐 Beatmaps streamed from a **separate repository** — no downloads to host here
- 📦 Drag-and-drop `.mjk` beatmaps
- 🎨 Every graphic is procedurally rendered at runtime
- 🔊 Every sound effect is synthesized using the Web Audio API
- 💾 Local score saving with autoplay protection
- ⚡ Zero external dependencies

---

## 📸 Highlights

Everything you see is generated at runtime.

- Logo
- Notes
- Receptors
- Hit effects
- Fallback cover art
- Menu sound effects
- Hitsounds
- Applause
- Failure jingle

No spritesheets. No audio files. No asset pipeline.

---

# 🚀 Quick Start

### Clone the repository

```bash
git clone <repository-url>
cd myujikku
```

### Start the server

```bash
node server.js
```

Then visit:

```
http://localhost:8080
```

Beatmaps are fetched from the [beatmap repository](#-beatmap-library), so there's
nothing to place locally first.

### Custom port / local beatmap folder

```bash
node server.js --port 9000 --songs "path/to/beatmaps"
```

The server is only a static host plus an optional local index — the game itself
runs perfectly well from any static host.

---

## 📚 Beatmap Library

Beatmaps live in their own repository so this one stays small and the game can be
hosted anywhere static:

### 👉 [TheSquiggle/myujikku-beatmaps](https://github.com/TheSquiggle/myujikku-beatmaps)

The song list is built at runtime from that repository's file listing. Every
`.mjk` file is picked up automatically; anything else — the repository's own
`README.md`, for instance — is ignored. **Adding a beatmap is just committing a
`.mjk` to that repo.** No rebuild, no redeploy, nothing to change here.

### Reading charts without downloading them

A `.mjk` is mostly audio and video, but the song list only needs `chart.mjc` and
the cover. Since a ZIP keeps its index at the *end* of the file, the game uses
**HTTP range requests** to read just the directory and pull out the two entries
it wants.

| | Transferred |
|---|---|
| Whole archives | 33.6 MB |
| Charts only *(list is usable here)* | ~236 KB |
| Charts + cover art | ~1.6 MB |

Cover art loads after the list is already on screen and fades in as it arrives.
The full archive is downloaded only when you press **Play**.

### Caching

Nothing is downloaded twice. Chart metadata is kept in `localStorage`, and cover
art and played archives go into the **Cache API**, so they survive reloads and
browser restarts.

| Visit | Requests | Transferred |
|---|---|---|
| First | 21 | 5.9 MB |
| Every visit after | **1** *(the repo listing)* | **5 KB** |

Replaying a song loads it from storage in ~0.4 s with **zero** network traffic.
Entries are keyed by URL *and* file size, so replacing a beatmap in the
repository invalidates its cache automatically, and the newest 12 archives are
kept while older ones are evicted.

**Settings → キャッシュ / Downloaded beatmaps** shows what's stored and clears it.

### Pointing at a different repository

Edit `BEATMAP_REPO` at the top of `src/beatmaps.js`:

```js
export const BEATMAP_REPO = {
  owner: 'TheSquiggle',
  name: 'myujikku-beatmaps',
  branch: 'main',
  path: '',        // subfolder within the repo, '' for the root
};
```

### Offline / local beatmaps

If the repository can't be reached, the game falls back to whatever `files.js`
lists. Drop `.mjk` files into a `songs/` folder and regenerate it:

```bash
python generate_files.py
```

Beatmaps aren't kept in this repository — that's what the beatmaps repo is for —
so `files.js` ships empty by default.

You can also skip everything and open `index.html` directly, then drag a `.mjk`
archive into the window.

> **Note:** GitHub's unauthenticated API allows 60 listing requests per hour per
> IP. That's one request per page load, so it only matters if you're reloading
> constantly — and the `files.js` fallback covers you if you hit it.

---

# 🎮 Controls

| Key | Action |
|------|--------|
| **D F J K** | Hit lanes 1–4 *(rebindable)* |
| **Esc** | Pause / Resume • Open settings |
| **`** | Quick retry |
| **↑ ↓** | Previous / Next song |
| **← →** | Change difficulty |
| **Enter** | Start |
| **/** | Search |

---

# 🏆 Scoring

Judgement timing follows the official **osu!mania** Overall Difficulty (OD) formula.

| Judgement | Window | Accuracy | Score |
|------------|--------|----------|------:|
| 極 MAX | 16.5 ms | 100% | 320 |
| 完璧 PERFECT | 64 − 3×OD | 100% | 300 |
| グレート GREAT | 97 − 3×OD | 66.7% | 200 |
| グッド GOOD | 127 − 3×OD | 33.3% | 100 |
| メー MEH | 151 − 3×OD | 16.7% | 50 |
| ミス MISS | 188 − 3×OD | 0% | 0 |

### Score Formula

Maximum score is **1,000,000**.

- **700,000** → Hit values
- **300,000** → Combo progression

A perfect Full Combo awards exactly **1,000,000** points.

### Hold Notes

- One judgement per hold note
- Head determines the initial grade
- Early release becomes a MISS
- Late release (within **1.5× MEH**) uses the worse of head and release

### Grades

| Grade | Requirement |
|--------|-------------|
| **SS** | ≥99% with no GOOD / MEH / MISS |
| **S** | ≥95% |
| **A** | ≥90% |
| **B** | ≥80% |
| **C** | ≥70% |
| **D** | Clear |
| **F** | HP depleted |

Personal bests are stored per song and difficulty using `localStorage`.

Autoplay and failed runs are never saved.

---

# 📦 Beatmap Format (`.mjk`)

A `.mjk` file is simply a ZIP archive.

```
audio.mp3     Required
chart.mjc     Required
BG.jpg        Optional
video.mp4     Optional
```

## `chart.mjc`

```jsonc
{
  "format": "mjc",
  "version": 1,
  "meta": {
    "title": "...",
    "titleUnicode": "...",
    "artist": "...",
    "artistUnicode": "...",
    "creator": "...",
    "source": "...",
    "tags": "...",
    "audio": "audio.mp3",
    "video": "video.mp4",
    "background": "BG.jpg"
  },
  "difficulties": {
    "Insane": {
      "keys": 4,
      "od": 8,
      "hp": 6,
      "noteCount": 476,
      "notes": [
        {
          "t": 3941,
          "lane": 2,
          "type": "tap"
        },
        {
          "t": 4901,
          "lane": 2,
          "type": "hold",
          "end": 5141
        }
      ]
    }
  }
}
```

- `t` and `end` are milliseconds from the beginning of the song.
- `lane` values are **1-based**.

---

## ⭐ Difficulty Rating

Every chart receives a star rating based on:

- Notes per second
- Per-column strain
- Chord density

The algorithm is implemented in:

```
src/chart.js
```

and mirrored inside

```
server.js
```

allowing beatmaps to be indexed without loading the audio.

---

# 📂 Project Structure

```
.
├── index.html          # Application entry point
├── server.js           # Static server + optional local beatmap indexing
├── files.js            # Generated offline beatmap list (fallback)
├── generate_files.py   # Regenerates files.js from songs/
├── src/
│   ├── audio.js        # Audio engine + synthesized SFX
│   ├── beatmaps.js     # Remote beatmap repository + ranged metadata reads
│   ├── cache.js        # Persistent metadata + archive caching
│   ├── chart.js        # Beatmap loading + star rating
│   ├── game.js         # Gameplay engine
│   ├── main.js         # Menus, library, settings
│   ├── skin.js         # Procedural graphics
│   ├── store.js        # Settings + local records
│   ├── style.css       # Entire UI
│   └── zip.js          # ZIP reader (whole-file and ranged) via DecompressionStream
```

---

# ⏱ Timing

Gameplay timing is driven directly by

```
AudioContext.currentTime
```

instead of `requestAnimationFrame`, allowing judgement timing to remain sample-accurate even when rendering slows down.

A two-second silent lead-in is synchronized using `performance.now()` before audio playback begins.

---

# 🖥 Requirements

- Node.js **18+**
- Browser supporting **DecompressionStream**

| Browser | Version |
|----------|---------|
| Chrome | 80+ |
| Edge | 80+ |
| Firefox | 113+ |
| Safari | 16.4+ |

---

# ❤️ Credits

Beatmaps hosted in [**TheSquiggle/myujikku-beatmaps**](https://github.com/TheSquiggle/myujikku-beatmaps) were converted from community osu! mapsets.

All music, artwork, and chart credits belong to their original creators and are preserved inside each beatmap's `meta` block.

The game engine, UI, procedural renderer, synthesized audio system, and generated assets are original to this project.
