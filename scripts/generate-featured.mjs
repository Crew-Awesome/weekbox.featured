import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const GAME_ID = 8694;
// Only query the explicitly supported FNF mod-folder categories. The legacy
// category root (43772) and old legacy root (3833) are intentionally omitted.
const CATEGORY_ROOTS = [
  29202, // Base Game / V-Slice
  28367, // Psych Engine
  34764, // Codename Engine
  3827, // Executables
  43798, // P-Slice
  44037, // ALE Psych
  43850, // FPS Plus
  43788, // Psych Online
  43774 // Legacy Base/Full Mods (direct links only)
];
// These entries are engine distributions rather than playable mods.
const EXCLUDED_MOD_IDS = new Set([309789]);
const API_URL = 'https://gamebanana.com/apiv11/Mod/Index';
const ENGINE_BY_CATEGORY = {
  29202: { id: 'vslice', name: 'Base Game', icon: 'vslice.png', categoryName: 'Base Game Mod Folders' },
  28367: { id: 'psych', name: 'Psych Engine', icon: 'psych.png', categoryName: 'Psych Engine Mod Folders' },
  34764: { id: 'codename', name: 'Codename Engine', icon: 'codename.png', categoryName: 'Codename Engine Mod Folders' },
  3827: { id: 'executable', name: 'Executable', icon: 'exe.png', categoryName: 'Executable Mod Folders' },
  43798: { id: 'pslice', name: 'P-Slice', icon: 'pslice.png', categoryName: 'P-Slice Mod Folders' },
  44037: { id: 'alepsych', name: 'ALE Psych', icon: 'alepsych.png', categoryName: 'ALE Psych Mod Folders' },
  43850: { id: 'fpsplus', name: 'FPS Plus', icon: 'fpsplus.png', categoryName: 'FPS Plus Mod Folders' },
  43788: { id: 'psychonline', name: 'Psych Online', icon: 'psychonline.png', categoryName: 'Psych Online Mod Folders' },
  43774: { id: 'vslice', name: 'Base Game', icon: 'vslice.png', categoryName: 'Originals / Full Mods (Base)' }
};
const PERIODS = [
  ['day', 'Best of Today', 24 * 60 * 60],
  ['week', 'Best of This Week', 7 * 24 * 60 * 60],
  ['month', 'Best of This Month', 30 * 24 * 60 * 60],
  ['three-months', 'Best of 3 Months', 90 * 24 * 60 * 60],
  ['six-months', 'Best of 6 Months', 180 * 24 * 60 * 60],
  ['year', 'Best of This Year', 365 * 24 * 60 * 60],
  ['all-time', 'Best of All Time', 0]
];
const RECENT_NEW_MOD_SLOTS = 3;
const RANKING_SIZE = 5;
const MAX_MODS_PER_ENGINE = 2;

function recordsFrom(response) {
  return Array.isArray(response?._aRecords) ? response._aRecords : [];
}

function score(mod) {
  return (mod._nLikeCount || 0) * 1_000_000 + (mod._nDownloadCount || 0) * 1_000 + (mod._nViewCount || 0);
}

function recentScore(mod, cutoff, periodSeconds) {
  // Log scaling stops established mods from overwhelming newer, lower-volume
  // releases, while still rewarding community approval most strongly.
  const quality =
    Math.log2(1 + (mod._nLikeCount || 0)) * 4 +
    Math.log2(1 + (mod._nDownloadCount || 0)) * 2 +
    Math.log2(1 + (mod._nViewCount || 0));
  const activityAt = Math.max(mod._tsDateAdded || 0, mod._tsDateUpdated || 0);
  const freshness = Math.min(1, Math.max(0, (activityAt - cutoff) / periodSeconds));
  return quality + freshness * 3;
}

function imageUrl(mod) {
  const image = mod._aPreviewMedia?._aImages?.[0];
  return image ? `${image._sBaseUrl}/${image._sFile}` : 'https://images.gamebanana.com/img/ss/mods/default.jpg';
}

function toFeaturedMod({ mod, categoryId }) {
  const engine = ENGINE_BY_CATEGORY[categoryId] || null;
  return {
    id: mod._idRow,
    title: mod._sName,
    author: mod._aSubmitter?._sName || 'Unknown',
    image: imageUrl(mod),
    likes: mod._nLikeCount || 0,
    downloads: mod._nDownloadCount || 0,
    views: mod._nViewCount || 0,
    publishedAt: mod._tsDateAdded || 0,
    updatedAt: mod._tsDateUpdated || 0,
    url: mod._sProfileUrl || `https://gamebanana.com/mods/${mod._idRow}`,
    engine: engine && { id: engine.id, name: engine.name, icon: engine.icon },
    category: { id: categoryId, name: engine?.categoryName || 'Unknown category' }
  };
}

async function fetchCategory(categoryId, sort, pageLimit) {
  const mods = [];

  for (let page = 1; page <= pageLimit; page++) {
    const params = new URLSearchParams({ _sSort: sort, _nPage: String(page), _nPerpage: '50' });
    params.set('_aFilters[Generic_Game]', String(GAME_ID));
    params.set('_aFilters[Generic_Category]', String(categoryId));

    const response = await fetch(`${API_URL}?${params}`);
    if (!response.ok) throw new Error(`GameBanana returned ${response.status} for category ${categoryId}`);

    const records = recordsFrom(await response.json());
    mods.push(...records);
    if (records.length < 50) break;
  }

  return mods.map((mod) => ({ mod, categoryId }));
}

function uniqueMods(mods) {
  return [...new Map(mods.map((entry) => [entry.mod._idRow, entry])).values()]
    .filter(({ mod }) => !EXCLUDED_MOD_IDS.has(mod._idRow));
}

function isRecentlyActive(mod, cutoff) {
  return (mod._tsDateAdded || 0) >= cutoff || (mod._tsDateUpdated || 0) >= cutoff;
}

function engineId(entry) {
  return ENGINE_BY_CATEGORY[entry.categoryId]?.id || 'unknown';
}

function rankAvailable(mods, selectedIds, rank) {
  return mods
    .filter(({ mod }) => !selectedIds.has(mod._idRow))
    .sort((left, right) => rank(right) - rank(left) || right.mod._idRow - left.mod._idRow);
}

function takeBalanced(mods, selectedIds, count, rank, engineCounts) {
  const ranked = rankAvailable(mods, selectedIds, rank);
  const picked = [];
  const pickedIds = new Set();

  for (const entry of ranked) {
    if (picked.length === count) break;
    const id = engineId(entry);
    if ((engineCounts.get(id) || 0) >= MAX_MODS_PER_ENGINE) continue;
    picked.push(entry);
    pickedIds.add(entry.mod._idRow);
    engineCounts.set(id, (engineCounts.get(id) || 0) + 1);
  }

  // Diversity is a preference, never a reason to leave a feature slot empty.
  for (const entry of ranked) {
    if (picked.length === count) break;
    if (pickedIds.has(entry.mod._idRow)) continue;
    picked.push(entry);
    pickedIds.add(entry.mod._idRow);
    const id = engineId(entry);
    engineCounts.set(id, (engineCounts.get(id) || 0) + 1);
  }

  return picked;
}

async function buildFeaturedData() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [recentGroups, allTimeGroups] = await Promise.all([
    // This is GameBanana's new-submission and real-update feed. Its update
    // timestamp excludes ordinary submission/page edits.
    Promise.all(CATEGORY_ROOTS.map((categoryId) => fetchCategory(categoryId, 'Generic_NewAndUpdated', 4))),
    Promise.all(CATEGORY_ROOTS.map((categoryId) => fetchCategory(categoryId, 'Generic_MostLiked', 1)))
  ]);
  const recentMods = uniqueMods(recentGroups.flat());
  const allTimeMods = uniqueMods(allTimeGroups.flat());
  const selectedIds = new Set();
  const rankings = PERIODS.map(([id, label, seconds]) => {
    const candidates = seconds
      ? recentMods.filter(({ mod }) => isRecentlyActive(mod, nowSeconds - seconds))
      : allTimeMods;
    const cutoff = nowSeconds - seconds;
    const newMods = seconds
      ? candidates.filter(({ mod }) => (mod._tsDateAdded || 0) >= cutoff)
      : candidates;
    const updatedMods = seconds
      ? candidates.filter(({ mod }) =>
          (mod._tsDateAdded || 0) < cutoff && (mod._tsDateUpdated || 0) >= cutoff
        )
      : [];
    const rank = seconds
      ? ({ mod }) => recentScore(mod, cutoff, seconds)
      : ({ mod }) => score(mod);
    const engineCounts = new Map();
    // Recent rankings favour new uploads, but reserve room for genuinely
    // updated older mods. Either group can fill any unused slots.
    const mods = takeBalanced(newMods, selectedIds, seconds ? RECENT_NEW_MOD_SLOTS : RANKING_SIZE, rank, engineCounts);
    const modIds = new Set(mods.map(({ mod }) => mod._idRow));
    const reservedIds = new Set([...selectedIds, ...modIds]);
    if (seconds) {
      mods.push(
        ...takeBalanced(updatedMods, reservedIds, RANKING_SIZE - RECENT_NEW_MOD_SLOTS, rank, engineCounts)
      );
    }
    if (mods.length < RANKING_SIZE) {
      mods.push(
        ...takeBalanced(candidates, new Set([...selectedIds, ...mods.map(({ mod }) => mod._idRow)]), RANKING_SIZE - mods.length, rank, engineCounts)
      );
    }
    mods.forEach(({ mod }) => selectedIds.add(mod._idRow));
    return { id, label, mods: mods.map(toFeaturedMod) };
  });

  const content = {
    gameId: GAME_ID,
    categoryRoots: CATEGORY_ROOTS,
    rankings
  };
  const revision = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    revision,
    ...content
  };
}

async function readPreviousFeaturedData() {
  try {
    return JSON.parse(await readFile(new URL('../public/featured.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

const previousFeaturedData = await readPreviousFeaturedData();
const featuredData = await buildFeaturedData();
if (previousFeaturedData?.revision === featuredData.revision) {
  featuredData.generatedAt = previousFeaturedData.generatedAt;
}
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/featured.json', import.meta.url), `${JSON.stringify(featuredData, null, 2)}\n`);
await writeFile(
  new URL('../public/featured-manifest.json', import.meta.url),
  `${JSON.stringify({
    schemaVersion: 1,
    revision: featuredData.revision,
    generatedAt: featuredData.generatedAt,
    featuredUrl: 'featured.json'
  }, null, 2)}\n`
);
