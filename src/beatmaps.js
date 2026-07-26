// Beatmap sources.
//
// Charts live in their own repository (TheSquiggle/myujikku-beatmaps) so this
// one stays small and the game can be hosted anywhere static. The list comes
// from GitHub's contents API; anything that isn't a .mjk — the repo's README,
// for instance — is ignored.
//
// Metadata is read with HTTP range requests (see openRemoteZip), so building the
// song list costs a few hundred KB rather than the tens of megabytes the full
// archives weigh. The whole file is only downloaded when you press play.

import { openRemoteZip, bytesToText, bytesToURL } from './zip.js';
import { parseChart } from './chart.js';

export const BEATMAP_REPO = {
  owner: 'TheSquiggle',
  name: 'myujikku-beatmaps',
  branch: 'main',
  path: '',                       // subfolder within the repo, '' for the root
};

const contentsApi = ({ owner, name, path, branch }) =>
  `https://api.github.com/repos/${owner}/${name}/contents/${path}?ref=${branch}`;

const rawUrl = ({ owner, name, branch }, file) =>
  `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${file.split('/').map(encodeURIComponent).join('/')}`;

/**
 * List the .mjk files published in the beatmap repository.
 * @returns {Promise<Array<{name:string, url:string, bytes:number}>>}
 */
export async function listRepoBeatmaps(repo = BEATMAP_REPO) {
  const res = await fetch(contentsApi(repo), {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('GitHub rate limit reached — try again in a few minutes.');
    }
    if (res.status === 404) {
      throw new Error(`Beatmap repository not found: ${repo.owner}/${repo.name}`);
    }
    throw new Error(`GitHub returned ${res.status}`);
  }

  const listing = await res.json();
  if (!Array.isArray(listing)) throw new Error('Unexpected response from GitHub.');

  return listing
    .filter(f => f.type === 'file' && f.name.toLowerCase().endsWith('.mjk'))
    .map(f => ({
      name: f.name,
      bytes: f.size,
      url: f.download_url || rawUrl(repo, f.path),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read a remote beatmap's chart without downloading its audio or video.
 * `size` is the archive's total length, which the listing already tells us —
 * it lets the zip directory be located with one explicit range request.
 * `withCover: true` also pulls the background image (a few hundred KB).
 */
export async function peekRemoteBeatmap(url, { size, withCover = false } = {}) {
  const zip = await openRemoteZip(url, size);

  const chartBytes = await zip.read('chart.mjc');
  if (!chartBytes) throw new Error('chart.mjc missing from archive.');
  const chart = parseChart(bytesToText(chartBytes));

  let bgURL = null;
  if (withCover) bgURL = await readCover(zip, chart.meta);

  return { meta: chart.meta, difficulties: chart.difficulties, bgURL, zip };
}

/** Pull the background image out of an already-opened remote archive. */
export async function readCover(zip, meta) {
  const name = [meta?.background, 'BG.jpg', 'bg.jpg'].find(n => n && zip.entries.has(n));
  if (!name) return null;
  const bytes = await zip.read(name);
  return bytes ? bytesToURL(bytes, 'image/jpeg') : null;
}
