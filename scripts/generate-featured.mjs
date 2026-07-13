import { mkdir, writeFile } from 'node:fs/promises';

const GAME_ID = 8694;
const CATEGORY_ROOTS = [34764, 28367, 29202];
const API_URL = 'https://gamebanana.com/apiv11/Mod/Index';
const EXPIRY_MS = 60 * 60 * 1000;
const PERIODS = [
  ['day', 'Best of Today', 24 * 60 * 60],
  ['week', 'Best of This Week', 7 * 24 * 60 * 60],
  ['month', 'Best of This Month', 30 * 24 * 60 * 60],
  ['three-months', 'Best of 3 Months', 90 * 24 * 60 * 60],
  ['six-months', 'Best of 6 Months', 180 * 24 * 60 * 60],
  ['year', 'Best of This Year', 365 * 24 * 60 * 60],
  ['all-time', 'Best of All Time', 0]
];

function recordsFrom(response) {
  return Array.isArray(response?._aRecords) ? response._aRecords : [];
}

function score(mod) {
  return (mod._nLikeCount || 0) * 1_000_000 + (mod._nDownloadCount || 0) * 1_000 + (mod._nViewCount || 0);
}

function imageUrl(mod) {
  const image = mod._aPreviewMedia?._aImages?.[0];
  return image ? `${image._sBaseUrl}/${image._sFile}` : 'https://images.gamebanana.com/img/ss/mods/default.jpg';
}

function toFeaturedMod(mod) {
  return {
    id: mod._idRow,
    title: mod._sName,
    author: mod._aSubmitter?._sName || 'Unknown',
    image: imageUrl(mod),
    likes: mod._nLikeCount || 0,
    downloads: mod._nDownloadCount || 0,
    views: mod._nViewCount || 0,
    publishedAt: mod._tsDateAdded || 0,
    url: mod._sProfileUrl || `https://gamebanana.com/mods/${mod._idRow}`
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

  return mods;
}

function uniqueMods(mods) {
  return [...new Map(mods.map((mod) => [mod._idRow, mod])).values()];
}

async function buildFeaturedData() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [recentGroups, allTimeGroups] = await Promise.all([
    Promise.all(CATEGORY_ROOTS.map((categoryId) => fetchCategory(categoryId, 'Generic_Newest', 4))),
    Promise.all(CATEGORY_ROOTS.map((categoryId) => fetchCategory(categoryId, 'Generic_MostLiked', 1)))
  ]);
  const recentMods = uniqueMods(recentGroups.flat());
  const allTimeMods = uniqueMods(allTimeGroups.flat());
  const selectedIds = new Set();
  const rankings = PERIODS.map(([id, label, seconds]) => {
    const candidates = seconds
      ? recentMods.filter((mod) => (mod._tsDateAdded || 0) >= nowSeconds - seconds)
      : allTimeMods;
    const mods = candidates
      .filter((mod) => !selectedIds.has(mod._idRow))
      .sort((left, right) => score(right) - score(left))
      .slice(0, 3);
    mods.forEach((mod) => selectedIds.add(mod._idRow));
    return { id, label, mods: mods.map(toFeaturedMod) };
  });

  const generatedAt = new Date();
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + EXPIRY_MS).toISOString(),
    gameId: GAME_ID,
    categoryRoots: CATEGORY_ROOTS,
    rankings
  };
}

const featuredData = await buildFeaturedData();
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/featured.json', import.meta.url), `${JSON.stringify(featuredData, null, 2)}\n`);
