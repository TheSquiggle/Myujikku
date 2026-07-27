#!/usr/bin/env node
// Generates the app icon: a square "sticker" mark matching the game's own
// chunky/bouncy visual language, rendered via a hidden Electron window and
// hand-assembled into a multi-resolution .ico — no image libraries needed,
// Electron itself is the renderer.
//
//   node_modules/.bin/electron scripts/make-icon.js
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'electron', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// A single bold glyph reads at 16px where a wordmark wouldn't. Same palette
// and chunky dark-outline "sticker" language as the in-game redesign.
const ICON_HTML = `
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:512px;height:512px;background:transparent}
  svg{display:block}
</style>
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff3d8b"/>
      <stop offset="55%" stop-color="#9d6bff"/>
      <stop offset="100%" stop-color="#38e8ff"/>
    </linearGradient>
    <linearGradient id="note" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#ffe0ef"/>
    </linearGradient>
  </defs>

  <rect x="20" y="20" width="472" height="472" rx="108" fill="url(#bg)" stroke="#050308" stroke-width="22"/>

  <!-- inner gloss, same top-light treatment as the game's note sprites -->
  <rect x="20" y="20" width="472" height="230" rx="108" fill="#ffffff" opacity=".10"/>

  <!-- a single bold eighth note, thick dark outline, matches the sticker style -->
  <g stroke="#050308" stroke-width="16" stroke-linejoin="round" fill="url(#note)">
    <ellipse cx="190" cy="372" rx="58" ry="46" transform="rotate(-12 190 372)"/>
    <rect x="230" y="120" width="34" height="260" rx="14"/>
    <path d="M264 120 C 330 108, 372 150, 360 210 C 352 176, 320 158, 264 176 Z"/>
  </g>
</svg>`;

async function main() {
  await app.whenReady();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 512, height: 512, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(ICON_HTML));
  await new Promise(r => setTimeout(r, 150));   // let the SVG paint before capturing

  const full = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), full.toPNG());
  console.log(`wrote icon.png (${full.getSize().width}x${full.getSize().height})`);

  const entries = ICO_SIZES.map(size => ({
    size,
    png: full.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(entries));
  console.log(`wrote icon.ico (${entries.map(e => e.size).join(', ')})`);

  win.destroy();
  app.quit();
}

/** Minimal ICO container: PNG-compressed entries, valid per the modern ICO spec. */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const imageDatas = [];
  let offset = 6 + count * 16;

  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(size >= 256 ? 0 : size, 0);   // width, 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, 1);   // height
    dir.writeUInt8(0, 2);                        // palette
    dir.writeUInt8(0, 3);                        // reserved
    dir.writeUInt16LE(1, 4);                     // color planes
    dir.writeUInt16LE(32, 6);                    // bits per pixel
    dir.writeUInt32LE(png.length, 8);             // data size
    dir.writeUInt32LE(offset, 12);                // data offset
    dirEntries.push(dir);
    imageDatas.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...imageDatas]);
}

main().catch(err => { console.error(err); process.exit(1); });
