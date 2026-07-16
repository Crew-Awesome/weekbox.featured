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
  ['today', 'day', 'Best of Today'],
  ['week', 'week', 'Best of This Week'],
  ['month', 'month', 'Best of This Month'],
  ['3month', 'three-months', 'Best of 3 Months'],
  ['6month', 'six-months', 'Best of 6 Months'],
  ['year', 'year', 'Best of This Year'],
  ['alltime', 'all-time', 'Best of All Time']
];

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

function toFeaturedMod({ topSub, profile, categoryId }) {
  const engine = ENGINE_BY_CATEGORY[categoryId];
  return {
    id: topSub._idRow,
    title: topSub._sName,
    author: topSub._aSubmitter?._sName || 'Unknown',
    image: imageUrl(topSub),
    likes: topSub._nLikeCount || profile._nLikeCount || 0,
    downloads: profile._nDownloadCount || 0,
    views: profile._nViewCount || 0,
    publishedAt: profile._tsDateAdded || 0,
    updatedAt: profile._tsDateModified || 0,
    url: topSub._sProfileUrl || profile._sProfileUrl || `https://gamebanana.com/mods/${topSub._idRow}`,
    engine: { id: engine.id, name: engine.name, icon: engine.icon },
    category: { id: categoryId, name: engine.categoryName }
  };
}

async function buildFeaturedData() {
  const topSubs = await fetchTopSubs();
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
  const rankings = PERIODS.map(([apiPeriod, id, label]) => ({
    id,
    label,
    // Preserve GameBanana's period-specific rank and order exactly. We only
    // remove entries outside our whitelist or explicit exclusion list.
    mods: eligibleMods
      .filter((topSub) => topSub._sPeriod === apiPeriod)
      .map((topSub) => {
        const profile = profiles.get(topSub._idRow);
        return toFeaturedMod({ topSub, profile, categoryId: profile._aSuperCategory._idRow });
      })
  }));

  const content = { gameId: GAME_ID, categoryRoots: CATEGORY_ROOTS, rankings };
  const revision = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
  return { schemaVersion: 4, generatedAt: new Date().toISOString(), revision, ...content };
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
