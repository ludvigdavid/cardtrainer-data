// Builds the cardtrainer.io card feed: one small JSON file per set (cards, pictures, euro prices)
// plus index.json with facts about every set. The app reads these instead of a card API.
//
// Sources (all free, ~3 downloads a day in total):
//   - Card lists: the open TCGdex card database (MIT licence), cloned from GitHub.
//   - Which pictures exist: TCGdex's asset list (assets.tcgdex.net/datas.json).
//   - Prices: Cardmarket's public daily price guide (euros).
//
// Run:  node build.mjs   (env: TCGDEX_DIR=path to a clone of github.com/tcgdex/cards-database,
//                         OUT=output folder, DATAS / PRICES = a local file or URL to use instead)
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TCGDEX_DIR = process.env.TCGDEX_DIR || join(HERE, 'cards-database');
const OUT = process.env.OUT || join(HERE, 'site');
const DATAS = process.env.DATAS || 'https://assets.tcgdex.net/datas.json';
const PRICES = process.env.PRICES || 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json';
const ASSETS = 'https://assets.tcgdex.net';
// Where this feed is published (set symbols are kept here too, see saveSymbols).
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://ludvigdavid.github.io/cardtrainer-data';
// The old card database's symbol pictures, copied once into the feed while they still exist.
const OLD_SYMBOL = (id) => `https://images.pokemontcg.io/${id}/symbol.png`;

// The app's sets (its own ids are kept, so saved progress still matches) → TCGdex's id.
const APP_SETS = JSON.parse(readFileSync(join(HERE, 'sets.json'), 'utf8'));
const TCGDEX_ID = {
  base6: 'lc', pgo: 'swsh10.5', sm35: 'sm3.5', sm75: 'sm7.5',
  sv1: 'sv01', sv2: 'sv02', sv3: 'sv03', sv3pt5: 'sv03.5', sv4: 'sv04', sv4pt5: 'sv04.5', sv5: 'sv05',
  sv6: 'sv06', sv6pt5: 'sv06.5', sv7: 'sv07', sv8: 'sv08', sv8pt5: 'sv08.5', sv9: 'sv09',
  swsh12pt5: 'swsh12.5', swsh35: 'swsh3.5', swsh45: 'swsh4.5',
};

/** Reads one TCGdex data file (a TypeScript object literal) without needing a TypeScript compiler. */
function loadTs(file) {
  let src = readFileSync(file, 'utf8');
  const names = [];
  src = src.replace(/^import\s+(?:\{[^}]*\}|(\w+))\s+from\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*');?[ \t]*$/gm, (_, name) => {
    if (name) names.push(name);
    return '';
  });
  src = src.replace(/^export default \w+;?\s*$/m, '');
  src = src.replace(/^const (\w+)\s*:\s*[\w<>[\]., ]+\s*=\s*/m, 'return ');
  return new Function(...names, src)(...names.map(() => null));
}

async function loadJson(src) {
  if (!/^https?:/.test(src)) return JSON.parse(readFileSync(src, 'utf8'));
  for (const wait of [0, 5000, 20000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(120000) });
      if (res.ok) return await res.json();
      console.warn(`${src}: status ${res.status}`);
    } catch (e) {
      console.warn(`${src}: ${e.message}`);
    }
  }
  return null;
}

/**
 * Keeps a copy of every set's symbol picture in the feed (symbols/<set>.png), so it doesn't depend on
 * anyone else's server. Downloaded once; files already there are kept. Returns the sets that have one.
 */
async function saveSymbols(ids, tcgdexUrls) {
  const dir = join(OUT, 'symbols');
  mkdirSync(dir, { recursive: true });
  const have = new Set();
  const todo = [];
  for (const id of ids) (existsSync(join(dir, `${id}.png`)) ? have.add(id) : todo.push(id));
  let fetched = 0;
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(
      todo.slice(i, i + 8).map(async (id) => {
        for (const url of [OLD_SYMBOL(id), tcgdexUrls[id]].filter(Boolean)) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            const type = res.headers.get('content-type') ?? '';
            if (!res.ok || !type.startsWith('image/')) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 100) continue; // not a real picture
            writeFileSync(join(dir, `${id}.png`), buf);
            have.add(id);
            fetched++;
            return;
          } catch {
            /* try the next source */
          }
        }
      }),
    );
  }
  console.log(`Set symbols: ${have.size}/${ids.length} saved in the feed (${fetched} new).`);
  return have;
}

/** Whether a picture exists (a light HEAD request). Used for set symbols the picture list doesn't mention. */
async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    return res.ok;
  } catch {
    return false;
  }
}

const good = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** One euro price from Cardmarket's guide: the middle of trend / 30-day / 7-day average (a lone trend can be way off). */
function eurPrice(g, holoOnly) {
  if (!g) return undefined;
  const plain = [g.trend, g.avg30, g.avg7].filter(good);
  const holo = [g['trend-holo'], g['avg30-holo'], g['avg7-holo']].filter(good);
  const pick = plain.length ? plain : holoOnly ? holo : [];
  return pick.length ? Math.round(median(pick) * 100) / 100 : undefined;
}

/** "001" → "1" (the old card ids had no leading zeros); "TG01", "RC5", "SV001" stay as they are. */
const cardNumber = (localId) => (/^\d+$/.test(localId) ? String(Number(localId)) : localId);

const variantInfo = (v) => {
  if (!v) return { holo: false, normal: true, cardmarket: undefined };
  if (Array.isArray(v)) {
    const types = new Set(v.map((x) => x.type));
    return { holo: types.has('holo'), normal: types.has('normal'), cardmarket: v.find((x) => x.thirdParty?.cardmarket)?.thirdParty.cardmarket };
  }
  return { holo: !!v.holo, normal: v.normal !== false && !v.holo ? true : !!v.normal, cardmarket: undefined };
};

const CATEGORY = { Pokemon: 'P', Trainer: 'T', Energy: 'E' };

async function main() {
  if (!existsSync(join(TCGDEX_DIR, 'data'))) throw new Error(`No TCGdex data at ${TCGDEX_DIR} (clone github.com/tcgdex/cards-database there)`);
  const [datas, priceGuide] = await Promise.all([loadJson(DATAS), loadJson(PRICES)]);
  if (!datas) console.warn('! picture list unavailable – assuming every card has a picture');
  if (!priceGuide?.priceGuides) console.warn('! price guide unavailable – building without prices');
  const prices = new Map((priceGuide?.priceGuides ?? []).map((g) => [g.idProduct, g]));

  // Index every TCGdex set: data/<Serie>/<Set>.ts with its cards in data/<Serie>/<Set>/.
  const sets = new Map();
  const dataDir = join(TCGDEX_DIR, 'data');
  for (const serieName of readdirSync(dataDir)) {
    const serieDir = join(dataDir, serieName);
    if (!statSync(serieDir).isDirectory()) continue;
    const serieFile = join(dataDir, `${serieName}.ts`);
    const serieId = existsSync(serieFile) ? loadTs(serieFile).id : undefined;
    for (const f of readdirSync(serieDir)) {
      if (!f.endsWith('.ts')) continue;
      const set = loadTs(join(serieDir, f));
      sets.set(set.id, { ...set, serieId, dir: join(serieDir, f.slice(0, -3)) });
    }
  }

  mkdirSync(join(OUT, 'sets'), { recursive: true });
  const index = { v: 1, updated: new Date().toISOString(), sets: {} };
  let total = 0, priced = 0, missingPics = 0;
  const problems = [];
  for (const app of APP_SETS) {
    const tid = TCGDEX_ID[app.id] ?? app.id;
    const set = sets.get(tid);
    if (!set || !existsSync(set.dir)) {
      problems.push(`${app.id} (${app.name}): no TCGdex set "${tid}"`);
      continue;
    }
    const pics = datas?.en?.[set.serieId]?.[tid];
    const cards = [];
    for (const f of readdirSync(set.dir)) {
      if (!f.endsWith('.ts')) continue;
      const localId = f.slice(0, -3);
      const c = loadTs(join(set.dir, f));
      const name = c.name?.en;
      if (!name) continue; // not printed in English
      const v = variantInfo(c.variants);
      const holoOnly = v.holo && !v.normal;
      let rarity = c.rarity ?? '';
      if (holoOnly && /^rare$/i.test(rarity)) rarity = 'Rare Holo'; // the app's "holos only" setting looks for "holo"
      const cm = c.thirdParty?.cardmarket ?? v.cardmarket;
      const p = cm ? eurPrice(prices.get(cm), holoOnly) : undefined;
      const hasPic = datas ? !!pics?.[localId] : true;
      if (!hasPic) missingPics++;
      if (p !== undefined) priced++;
      cards.push({
        i: `${app.id}-${cardNumber(localId)}`,
        n: name,
        no: cardNumber(localId),
        r: rarity || undefined,
        s: CATEGORY[c.category] ?? c.category,
        a: c.illustrator || undefined,
        p,
        img: hasPic ? `${set.serieId}/${tid}/${localId}` : undefined,
      });
    }
    cards.sort((a, b) => (parseInt(a.no, 10) || 1e9) - (parseInt(b.no, 10) || 1e9) || a.no.localeCompare(b.no));
    total += cards.length;
    const symbolUrl = `${ASSETS}/univ/${set.serieId}/${tid}/symbol.png`;
    const symbol = datas?.univ?.[set.serieId]?.[tid]?.symbol ? symbolUrl : undefined;
    const release = typeof set.releaseDate === 'string' ? set.releaseDate : set.releaseDate?.en;
    const facts = { name: app.name, year: release ? Number(release.slice(0, 4)) : undefined, total: set.cardCount?.official, symbol, count: cards.length };
    index.sets[app.id] = { ...facts, symbolGuess: symbol ? undefined : symbolUrl };
    writeFileSync(join(OUT, 'sets', `${app.id}.json`), JSON.stringify({ v: 1, id: app.id, updated: index.updated, ...facts, cards }));
  }
  // Set symbols: our own saved copy first; otherwise TCGdex's, if their server has it.
  const saved = await saveSymbols(Object.keys(index.sets), Object.fromEntries(Object.entries(index.sets).map(([id, f]) => [id, f.symbol ?? f.symbolGuess])));
  for (const [id, f] of Object.entries(index.sets)) {
    if (saved.has(id)) {
      f.symbol = `${PUBLIC_URL}/symbols/${id}.png`;
      delete f.symbolGuess;
    }
  }
  const unknown = Object.entries(index.sets).filter(([, f]) => !f.symbol && f.symbolGuess);
  let found = 0;
  for (let i = 0; i < unknown.length; i += 8) {
    await Promise.all(
      unknown.slice(i, i + 8).map(async ([, f]) => {
        if (await exists(f.symbolGuess)) {
          f.symbol = f.symbolGuess;
          found++;
        }
      }),
    );
  }
  for (const [id, f] of Object.entries(index.sets)) {
    delete f.symbolGuess;
    if (saved.has(id) || unknown.some(([u]) => u === id)) {
      // write the symbol into that set's own file too
      const file = join(OUT, 'sets', `${id}.json`);
      const j = JSON.parse(readFileSync(file, 'utf8'));
      j.symbol = f.symbol;
      writeFileSync(file, JSON.stringify(j));
    }
  }
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
  const withSymbol = Object.values(index.sets).filter((f) => f.symbol).length;
  console.log(`Picture list: ${datas ? 'ok' : 'UNAVAILABLE'} · prices: ${priceGuide?.priceGuides ? 'ok' : 'UNAVAILABLE'} · set symbols: ${withSymbol}/${Object.keys(index.sets).length} (${found} found by asking directly)`);
  writeFileSync(join(OUT, '.nojekyll'), '');
  console.log(`${Object.keys(index.sets).length} sets, ${total} cards, ${priced} with a price, ${missingPics} without a picture.`);
  if (problems.length) console.warn('Sets not found:\n  ' + problems.join('\n  '));
  // Refuse to publish something clearly broken (keeps yesterday's feed online instead).
  if (Object.keys(index.sets).length < APP_SETS.length * 0.9 || total < 1000) {
    console.error('Feed looks incomplete – not publishing.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
