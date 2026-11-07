// Builds webos-app/channels.js from the public iptv-org database.
// Keeps only news / kids / movies / music channels from Bangladesh and India, plus
// English-language international news / kids / movies. Adult channels are always
// excluded, and every stream is test-played (playlist fetched) before it is kept.
//
// Usage: node scripts/build-channels.mjs [cacheDir]
//   cacheDir  optional folder that already holds channels/streams/feeds/logos.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'webos-app', 'channels.js');
const API = 'https://iptv-org.github.io/api';
const cacheDir = process.argv[2];

const GROUPS = ['news', 'kids', 'movies', 'music'];
const LOCAL = { BD: 'Bangladesh', IN: 'India' };
const INTERNATIONAL_GROUPS = ['news', 'kids', 'movies'];
const BLOCKED_CATEGORIES = ['xxx', 'religious', 'shop'];
const BLOCKED_WORDS = /\b(adult|xxx|erotic|sexy|hot ?tv|playboy|18\+)\b/i;
const MAX_INTERNATIONAL = 80;
// Well-known channels are listed first in their section (and survive the international cap).
const FEATURED = [
  'SomoyTV.bd', 'JamunaTV.bd', 'IndependentTV.bd', 'EkusheyTV.bd', 'DBCNews.bd',
  'NDTV24x7.in', 'NDTVIndia.in', 'IndiaToday.in', 'AajTak.in', 'ABPAnanda.in', 'ABPNews.in',
  'Zee24Ghanta.in', 'RepublicBangla.in', 'News18Bangla.in', 'DDNews.in', 'WION.in',
  'BBCNews.uk', 'AlJazeera.qa', 'DWEnglish.de', 'France24English.fr', 'SkyNews.uk',
  'CNA.sg', 'ABCNewsLive.us', 'CBSNews247.us', 'NBCNewsNOW.us', 'Euronews.fr', 'TRTWorld.tr',
  'BBCWorldNews.uk', 'NHKWorldJapan.jp', 'CGTN.cn', 'ArirangTV.kr',
  'DurontoTV.bd', 'Pogo.in', 'CartoonNetwork.in', 'DiscoveryKids.in', 'HungamaTV.in',
  'BabyTV.uk', 'PBSKids.us', 'ABCKids.au', 'BabySharkTV.us', 'LegoChannel.us',
];
const TIMEOUT_MS = 10000;
const CONCURRENCY = 32;

async function load(name) {
  if (cacheDir) return JSON.parse(fs.readFileSync(path.join(cacheDir, `${name}.json`), 'utf8'));
  const res = await fetch(`${API}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

function groupOf(categories) {
  const cats = categories.map((c) => (c === 'animation' ? 'kids' : c));
  return GROUPS.find((g) => cats.includes(g));
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    return { text: (await res.text()).slice(0, 200000), url: res.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A stream counts as working when its playlist loads and, for a master playlist,
// its first variant playlist loads too.
async function streamWorks(url) {
  const master = await fetchText(url);
  if (!master || !master.text.includes('#EXTM3U')) return false;
  if (!master.text.includes('#EXT-X-STREAM-INF')) return master.text.includes('#EXTINF');
  const lines = master.text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const variant = lines.slice(idx + 1).find((l) => l.trim() && !l.startsWith('#'));
  if (!variant) return false;
  const media = await fetchText(new URL(variant.trim(), master.url).href);
  return !!media && media.text.includes('#EXTM3U');
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return results;
}

const [channels, streams, feeds, logos] = await Promise.all(
  ['channels', 'streams', 'feeds', 'logos'].map(load));

const languagesOf = new Map();
for (const f of feeds) {
  const langs = languagesOf.get(f.channel) || new Set();
  f.languages.forEach((l) => langs.add(l));
  languagesOf.set(f.channel, langs);
}

const logoOf = new Map();
for (const l of logos) {
  if (l.feed || !l.in_use || logoOf.has(l.channel)) continue;
  if (['PNG', 'JPEG', 'SVG'].includes(l.format)) logoOf.set(l.channel, l.url);
}

const candidates = new Map();
for (const c of channels) {
  if (c.is_nsfw || c.closed || c.replaced_by) continue;
  if (c.categories.some((cat) => BLOCKED_CATEGORIES.includes(cat))) continue;
  if (BLOCKED_WORDS.test(c.name)) continue;
  const group = groupOf(c.categories);
  if (!group) continue;
  let region = LOCAL[c.country];
  if (!region) {
    if (!INTERNATIONAL_GROUPS.includes(group)) continue;
    if (!(languagesOf.get(c.id) || new Set()).has('eng')) continue;
    region = 'International';
  }
  candidates.set(c.id, { id: c.id, name: c.name, group, region, logo: logoOf.get(c.id) || '', urls: [] });
}

for (const s of streams) {
  const ch = candidates.get(s.channel);
  if (!ch || s.referrer || s.user_agent) continue;
  if ((s.labels || []).some((l) => /geo-blocked|not 24\/7/i.test(l))) continue;
  if (!/^https?:\/\/.+/i.test(s.url) || !/\.m3u8?(\?|$)/i.test(s.url)) continue;
  if (ch.urls.length < 3 && !ch.urls.includes(s.url)) ch.urls.push(s.url);
}

const toCheck = [...candidates.values()].filter((c) => c.urls.length);
console.log(`checking ${toCheck.length} channels...`);
let done = 0;
const checked = await pool(toCheck, async (ch) => {
  const ok = [];
  for (const url of ch.urls) if (await streamWorks(url)) ok.push(url);
  if (++done % 50 === 0) console.log(`  ${done}/${toCheck.length}`);
  return ok.length ? { ...ch, urls: ok } : null;
});

const REGION_ORDER = ['Bangladesh', 'India', 'International'];
const sections = new Map();
for (const ch of checked.filter(Boolean)) {
  const key = `${ch.group}|${ch.region}`;
  if (!sections.has(key)) sections.set(key, []);
  sections.get(key).push(ch);
}
const list = [];
for (const group of GROUPS) {
  for (const region of REGION_ORDER) {
    const rank = (c) => (FEATURED.includes(c.id) ? FEATURED.indexOf(c.id) : FEATURED.length);
    const items = (sections.get(`${group}|${region}`) || [])
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, region === 'International' ? MAX_INTERNATIONAL : Infinity);
    list.push(...items);
  }
}

const summary = {};
list.forEach((c) => { summary[`${c.group}/${c.region}`] = (summary[`${c.group}/${c.region}`] || 0) + 1; });
console.table(summary);

fs.writeFileSync(OUT,
  `// Generated by scripts/build-channels.mjs on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.\n` +
  `window.CHANNELS = ${JSON.stringify(list, null, 1)};\n`);
console.log(`wrote ${list.length} channels to ${path.relative(ROOT, OUT)}`);
