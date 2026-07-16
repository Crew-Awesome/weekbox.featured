import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const GAME_ID = 8694;
// Only submissions in these FNF mod-folder trees are eligible. The legacy
// category roots (43772 and 3833) remain deliberately unsupported.
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
const WHITELISTED_CATEGORY_IDS = new Set(CATEGORY_ROOTS);
// These entries are engine distributions rather than playable mods.
const EXCLUDED_MOD_IDS = new Set([309789]);
const TOP_SUBS_URL = `https://gamebanana.com/apiv12/Game/${GAME_ID}/TopSubs`;
const PROFILE_URL = 'https://gamebanana.com/apiv11/Mod';
const MOD_INDEX_URL = 'https://gamebanana.com/apiv11/Mod/Index';
const FEATURED_PER_PERIOD = 5;
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
  ['today', 'day', 'Best of Today', 24 * 60 * 60],
  ['week', 'week', 'Best of This Week', 7 * 24 * 60 * 60],
  ['month', 'month', 'Best of This Month', 30 * 24 * 60 * 60],
  ['3month', 'three-months', 'Best of 3 Months', 90 * 24 * 60 * 60],
  ['6month', 'six-months', 'Best of 6 Months', 180 * 24 * 60 * 60],
  ['year', 'year', 'Best of This Year', 365 * 24 * 60 * 60],
  ['alltime', 'all-time', 'Best of All Time', 0]
];

function recordsFrom(response) {
  return Array.isArray(response?._aRecords) ? response._aRecords : [];
}

function imageUrl(mod) {
  if (mod._sImageUrl) return mod._sImageUrl;
  const image = mod._aPreviewMedia?._aImages?.[0];
  return image
    ? `${image._sBaseUrl}/${image._sFile}`
    : 'https://images.gamebanana.com/img/ss/mods/default.jpg';
}

async function fetchTopSubs() {
  const response = await fetch(TOP_SUBS_URL);
  if (!response.ok) throw new Error(`GameBanana returned ${response.status} for TopSubs`);

  const mods = await response.json();
  if (!Array.isArray(mods)) throw new Error('GameBanana returned an invalid TopSubs response');
  return mods;
}

async function fetchProfile(modId) {
  const response = await fetch(`${PROFILE_URL}/${modId}/ProfilePage`);
  if (!response.ok) throw new Error(`GameBanana returned ${response.status} for mod ${modId}`);
  return response.json();
}

async function fetchCategory(categoryId, sort, pageLimit) {
  const mods = [];
  for (let page = 1; page <= pageLimit; page++) {
    const params = new URLSearchParams({ _sSort: sort, _nPage: String(page), _nPerpage: '50' });
    params.set('_aFilters[Generic_Game]', String(GAME_ID));
    params.set('_aFilters[Generic_Category]', String(categoryId));
    const response = await fetch(`${MOD_INDEX_URL}?${params}`);
    if (!response.ok) throw new Error(`GameBanana returned ${response.status} for category ${categoryId}`);
    const records = recordsFrom(await response.json());
    mods.push(...records);
    if (records.length < 50) break;
  }
  return mods.map((mod) => ({ mod, categoryId }));
}

function score(mod) {
  return (mod._nLikeCount || 0) * 1_000_000 + (mod._nDownloadCount || 0) * 1_000 + (mod._nViewCount || 0);
}

function activeSince(mod, cutoff) {
  return (mod._tsDateAdded || 0) >= cutoff || (mod._tsDateUpdated || mod._tsDateModified || 0) >= cutoff;
}

function uniqueMods(mods) {
  return [...new Map(mods.map((entry) => [entry.mod._idRow, entry])).values()]
    .filter(({ mod }) => !EXCLUDED_MOD_IDS.has(mod._idRow));
}

function toFeaturedMod({ mod, profile, categoryId }) {
  const engine = ENGINE_BY_CATEGORY[categoryId];
  return {
    id: mod._idRow,
    title: mod._sName,
    author: mod._aSubmitter?._sName || 'Unknown',
    image: imageUrl(mod),
    likes: mod._nLikeCount || profile?._nLikeCount || 0,
    downloads: profile._nDownloadCount || 0,
    views: profile._nViewCount || 0,
    publishedAt: profile._tsDateAdded || 0,
    updatedAt: profile._tsDateUpdated || profile._tsDateModified || 0,
    url: mod._sProfileUrl || profile._sProfileUrl || `https://gamebanana.com/mods/${mod._idRow}`,
    engine: { id: engine.id, name: engine.name, icon: engine.icon },
    category: { id: categoryId, name: engine.categoryName }
  };
}

async function buildFeaturedData() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [topSubs, recentGroups, allTimeGroups] = await Promise.all([
    fetchTopSubs(),
    Promise.all(CATEGORY_ROOTS.map((categoryId) => fetchCategory(categoryId, 'Generic_NewAndUpdated', 4))),
    Promise.all(CATEGORY_ROOTS.map((categoryId) => fetchCategory(categoryId, 'Generic_MostLiked', 1)))
  ]);
  const uniqueTopSubs = [...new Map(topSubs.map((mod) => [mod._idRow, mod])).values()]
    .filter((mod) => !EXCLUDED_MOD_IDS.has(mod._idRow));
  const profiles = new Map(
    await Promise.all(uniqueTopSubs.map(async (mod) => [mod._idRow, await fetchProfile(mod._idRow)]))
  );

  const eligibleMods = topSubs.filter((topSub) => {
    if (EXCLUDED_MOD_IDS.has(topSub._idRow)) return false;
    const categoryId = profiles.get(topSub._idRow)?._aSuperCategory?._idRow;
    return WHITELISTED_CATEGORY_IDS.has(categoryId);
  });
  const recentMods = uniqueMods(recentGroups.flat());
  const allTimeMods = uniqueMods(allTimeGroups.flat());
  // A featured mod belongs to its most immediate qualifying period only.
  // Keeping this set outside the period loop prevents duplicate cards across
  // Today, Week, Month, and the longer rankings.
  const featuredModIds = new Set();
  const rankings = PERIODS.map(([apiPeriod, id, label, seconds]) => {
    // TopSubs is the canonical ranking. It exposes only three entries per
    // period, so use the same unbalanced popularity ordering only to fill the
    // remaining two slots from whitelisted submissions.
    const primary = eligibleMods
      .filter((topSub) => topSub._sPeriod === apiPeriod)
      .filter((topSub) => !featuredModIds.has(topSub._idRow))
      .map((topSub) => ({ mod: topSub, profile: profiles.get(topSub._idRow), categoryId: profiles.get(topSub._idRow)._aSuperCategory._idRow }));
    const selectedIds = new Set([...featuredModIds, ...primary.map(({ mod }) => mod._idRow)]);
    const cutoff = nowSeconds - seconds;
    const fallback = (seconds ? recentMods.filter(({ mod }) => activeSince(mod, cutoff)) : allTimeMods)
      .filter(({ mod }) => !selectedIds.has(mod._idRow))
      .sort((left, right) => score(right.mod) - score(left.mod) || right.mod._idRow - left.mod._idRow)
      .slice(0, FEATURED_PER_PERIOD - primary.length)
      .map(({ mod, categoryId }) => ({ mod, profile: mod, categoryId }));
    const mods = [...primary, ...fallback];
    mods.forEach(({ mod }) => featuredModIds.add(mod._idRow));
    return {
      id,
      label,
      mods: mods.map(toFeaturedMod)
    };
  });

  const content = { gameId: GAME_ID, categoryRoots: CATEGORY_ROOTS, rankings };
  const revision = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
  // Weekbox's FeaturedService currently accepts schema version 3.
  return { schemaVersion: 3, generatedAt: new Date().toISOString(), revision, ...content };
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
    // A revisioned URL prevents clients/CDNs from reusing a prior featured
    // payload after the rankings change.
    featuredUrl: `featured.json?revision=${featuredData.revision}`
  }, null, 2)}\n`
);
