#!/usr/bin/env node
// Convert every .osz sitting in Downloads into .mjk, publish anything new to
// myujikku-beatmaps, and file the originals away. Run it by hand whenever
// you've got fresh downloads — it does not fetch anything itself and does not
// keep running once the current batch is done.
//
//   node scripts/convert-and-commit.mjs [--dry-run] [--no-push]
//
// Layout (override with flags if yours differs):
//   Downloads/                 …/Downloads          .osz files to process
//   Desktop/osu! beatmaps/     archive for processed .osz originals
//   Desktop/myujikku beatmaps/ local copy of every .mjk this script has made
//   ~/.cache/myujikku-beatmaps-repo/   persistent clone of the beatmaps repo
//
// Dedup: a beatmap already published under its converted name is skipped —
// checked against the repo's real file listing, not a private ledger, so it
// stays correct even if this script runs from a different machine.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { convertOsz, packMjk } from '../src/osz.js';

const HOME = os.homedir();
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const DOWNLOADS_DIR = opt('--downloads', path.join(HOME, 'Downloads'));
const OSZ_ARCHIVE_DIR = opt('--osz-archive', path.join(HOME, 'Desktop', 'osu! beatmaps'));
const MJK_LOCAL_DIR = opt('--mjk-local', path.join(HOME, 'Desktop', 'myujikku beatmaps'));
const REPO_DIR = opt('--repo-dir', path.join(HOME, '.cache', 'myujikku-beatmaps-repo'));
const REPO_URL = 'https://github.com/TheSquiggle/myujikku-beatmaps.git';

const DRY_RUN = flag('--dry-run');
const NO_PUSH = flag('--no-push') || DRY_RUN;

const git = (cmd, cwd) => execFileSync('git', cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function ensureRepo() {
  fs.mkdirSync(path.dirname(REPO_DIR), { recursive: true });
  if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
    console.log(`repo: pulling latest into ${REPO_DIR}`);
    git(['pull', '--ff-only'], REPO_DIR);
  } else {
    console.log(`repo: cloning into ${REPO_DIR}`);
    execFileSync('git', ['clone', REPO_URL, REPO_DIR], { stdio: 'inherit' });
  }
}

function repoFileNames() {
  return new Set(
    fs.readdirSync(REPO_DIR)
      .filter(f => f.toLowerCase().endsWith('.mjk'))
      .map(f => f.toLowerCase()),
  );
}

function uniqueName(base, taken) {
  let name = base, n = 2;
  while (taken.has(name.toLowerCase())) {
    name = base.replace(/\.mjk$/i, ` (${n}).mjk`);
    n++;
  }
  return name;
}

function moveAside(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(src));
  if (fs.existsSync(dest)) {
    const base = path.basename(src, '.osz');
    let n = 2;
    while (fs.existsSync(dest)) { dest = path.join(destDir, `${base} (${n}).osz`); n++; }
  }
  fs.renameSync(src, dest);
  return dest;
}

async function main() {
  const files = fs.existsSync(DOWNLOADS_DIR)
    ? fs.readdirSync(DOWNLOADS_DIR).filter(f => f.toLowerCase().endsWith('.osz'))
    : [];

  if (!files.length) {
    console.log(`No .osz files in ${DOWNLOADS_DIR}.`);
    return;
  }
  console.log(`Found ${files.length} .osz file(s) in Downloads.\n`);

  ensureRepo();
  const known = repoFileNames();

  const added = [];
  const skipped = [];
  const failed = [];

  for (const file of files) {
    const full = path.join(DOWNLOADS_DIR, file);
    process.stdout.write(`${file} ... `);
    try {
      const buf = fs.readFileSync(full);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const { chart, media, suggestedName } = await convertOsz(ab, () => {});

      if (known.has(suggestedName.toLowerCase())) {
        console.log(`SKIP — already in the repo as ${suggestedName}`);
        skipped.push({ file, name: suggestedName });
        if (!DRY_RUN) moveAside(full, OSZ_ARCHIVE_DIR);
        continue;
      }

      const name = uniqueName(suggestedName, known);
      known.add(name.toLowerCase());

      const diffCount = Object.keys(chart.difficulties).length;
      const noteCount = Object.values(chart.difficulties).reduce((a, d) => a + d.notes.length, 0);

      if (DRY_RUN) {
        console.log(`WOULD ADD -> ${name} (${diffCount} diffs, ${noteCount} notes)`);
        added.push({ file, name, diffCount, noteCount });
        continue;
      }

      const blob = await packMjk(chart, media, () => {});
      const outBuf = Buffer.from(await blob.arrayBuffer());

      fs.writeFileSync(path.join(REPO_DIR, name), outBuf);
      fs.mkdirSync(MJK_LOCAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(MJK_LOCAL_DIR, name), outBuf);
      moveAside(full, OSZ_ARCHIVE_DIR);

      console.log(`OK -> ${name} (${diffCount} diffs, ${noteCount} notes, ${(outBuf.length / 1048576).toFixed(1)} MB)`);
      added.push({ file, name, diffCount, noteCount });
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed.push({ file, error: err.message });
    }
  }

  console.log(`\n${added.length} added, ${skipped.length} already published, ${failed.length} failed.`);
  if (failed.length) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.file}: ${f.error}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing was written, moved, or committed.');
    return;
  }
  if (!added.length) {
    console.log('\nNothing new to commit.');
    return;
  }

  const titles = added.map(a => `- ${a.name} (${a.diffCount} diffs, ${a.noteCount} notes)`).join('\n');
  git(['add', '-A'], REPO_DIR);
  git(['-c', 'user.name=TheSquiggle', '-c', 'user.email=silas.fierro@gmail.com',
       'commit', '-m', `Add ${added.length} beatmap(s) converted from osu! mapsets\n\n${titles}`], REPO_DIR);
  console.log(`\nCommitted ${added.length} beatmap(s).`);

  if (NO_PUSH) {
    console.log('--no-push: commit left local, not pushed.');
  } else {
    git(['push', 'origin', 'main'], REPO_DIR);
    console.log('Pushed to TheSquiggle/myujikku-beatmaps.');
  }
}

main().catch(err => {
  console.error(`\nconvert-and-commit crashed: ${err.stack || err.message}`);
  process.exit(1);
});
