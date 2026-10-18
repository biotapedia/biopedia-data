// Open data sources for scripts/auto-species.mjs. Facts come from here, never from the language model:
// GBIF Backbone Taxonomy (CC BY 4.0) for names and classification, IUCN categories and observation records as
// served by GBIF, Wikidata (CC0) for Chinese names, Wikipedia as the reference the facts are extracted from, and
// Wikimedia Commons for freely licensed images.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONSERVATION_STATUSES, isHttpsUrl } from './catalog.mjs';
import { imageAttribution, imageCredit, imageLicenseProblem } from './auto-rules.mjs';

const GBIF = 'https://api.gbif.org/v1';
const BACKBONE = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';
// Wikimedia asks automated clients to identify themselves: https://meta.wikimedia.org/wiki/User-Agent_policy
const USER_AGENT = 'BiotapediaBot/1.0 (https://github.com/biotapedia/biopedia-data)';
const ZH_LABELS = ['zh-cn', 'zh-hans', 'zh'];

async function getJson(url, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
      if (response.status === 204 || response.status === 404) return null;
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw Object.assign(new Error(`${url}: HTTP ${response.status}`), { final: true });
      return await response.json();
    } catch (error) {
      if (error.final) throw error;
      if (attempt >= retries) {
        throw error.name === 'TimeoutError' ? new Error(`${new URL(url).host} did not answer within 20s (${retries + 1} tries)`) : error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

const query = params => new URLSearchParams(params).toString();

export const gbifSpeciesUrl = key => `https://www.gbif.org/species/${key}`;

export function gbifRecord(key) {
  return getJson(`${GBIF}/species/${key}`);
}

// Resolves a name to an accepted GBIF Backbone record of the given rank, or explains why it cannot.
// Names shared across kingdoms make GBIF answer with a higher rank; the exact candidates are then in `alternatives`.
export async function gbifMatch(name, { rank = 'SPECIES', kingdom } = {}) {
  const match = await getJson(`${GBIF}/species/match?${query({ scientificName: name, rank, strict: 'true', verbose: 'true', ...(kingdom ? { kingdom } : {}) })}`);
  const exact = [match, ...(match?.alternatives ?? [])].filter(candidate => candidate?.matchType === 'EXACT'
    && candidate.rank === rank && candidate.canonicalName?.toLowerCase() === name.toLowerCase()
    && (!kingdom || candidate.kingdom === kingdom));
  const accepted = exact.filter(candidate => candidate.status === 'ACCEPTED');
  if (accepted.length > 1) return { problem: `${name} matches several accepted GBIF ${rank.toLowerCase()} records` };
  if (accepted.length === 1) return { record: await gbifRecord(accepted[0].usageKey) };
  const synonym = exact.find(candidate => candidate.status === 'SYNONYM');
  if (synonym) return { problem: `${name} is a synonym in GBIF; use the accepted name ${synonym.species ?? ''}`.trim() };
  if (exact.length) return { problem: `${name} has GBIF status ${exact[0].status}` };
  return { problem: `GBIF has no exact ${rank.toLowerCase()} match for ${name}` };
}

export async function gbifSpeciesUnder(key, limit = 100) {
  const page = await getJson(`${GBIF}/species/search?${query({
    highertaxonKey: key, rank: 'SPECIES', status: 'ACCEPTED', datasetKey: BACKBONE, limit
  })}`);
  return page?.results ?? [];
}

export async function iucnStatus(key) {
  const result = await getJson(`${GBIF}/species/${key}/iucnRedListCategory`);
  return CONSERVATION_STATUSES.has(result?.code) ? { code: result.code, iucnTaxonID: result.iucnTaxonID ?? null } : null;
}

// Observation records per ISO country code. Captive animals and fossils are left out, but introduced and escaped
// populations and misidentifications remain, so this only shows where a species has been recorded, not where it lives.
export async function gbifCountryCounts(key) {
  const params = new URLSearchParams({
    taxonKey: key, limit: '0', facet: 'country', facetLimit: '250',
    occurrenceStatus: 'PRESENT', hasCoordinate: 'true', hasGeospatialIssue: 'false'
  });
  for (const basis of ['HUMAN_OBSERVATION', 'MACHINE_OBSERVATION', 'OBSERVATION', 'PRESERVED_SPECIMEN', 'MATERIAL_SAMPLE']) {
    params.append('basisOfRecord', basis);
  }
  const result = await getJson(`${GBIF}/occurrence/search?${params}`);
  return new Map((result?.facets?.[0]?.counts ?? []).map(entry => [entry.name, entry.count]));
}

// The Wikidata item that carries this GBIF taxon id (property P846), with its Chinese name, images and article titles.
export async function wikidataForGbif(key) {
  const search = await getJson(`https://www.wikidata.org/w/api.php?${query({
    action: 'query', list: 'search', srsearch: `haswbstatement:P846=${key}`, srlimit: '1', format: 'json'
  })}`);
  const qid = search?.query?.search?.[0]?.title;
  if (!qid) return null;
  const entity = (await getJson(`https://www.wikidata.org/w/api.php?${query({
    action: 'wbgetentities', ids: qid, props: 'labels|claims|sitelinks', languages: ZH_LABELS.join('|'), sitefilter: 'zhwiki|enwiki', format: 'json'
  })}`))?.entities?.[qid];
  if (!entity) return null;
  const language = ZH_LABELS.find(code => entity.labels?.[code]?.value);
  // Editors mark the best picture with preferred rank; deprecated ones are not meant to be used.
  const images = (entity.claims?.P18 ?? []).filter(claim => claim.rank !== 'deprecated')
    .sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'))
    .map(claim => claim.mainsnak?.datavalue?.value).filter(Boolean);
  return {
    qid,
    url: `https://www.wikidata.org/wiki/${qid}`,
    name_zh: language ? entity.labels[language].value : null,
    name_language: language ?? null,
    images,
    articles: { zh: entity.sitelinks?.zhwiki?.title ?? null, en: entity.sitelinks?.enwiki?.title ?? null }
  };
}

const WIKIPEDIA = { zh: 'https://zh.wikipedia.org', en: 'https://en.wikipedia.org' };
// The cover is shown up to about 600 px wide, twice that on high-density screens.
const MIN_IMAGE_WIDTH = 800;

// Plain text of a Wikipedia article (Simplified script for Chinese), or only its lead section. Chinese is preferred.
export async function wikiArticle(articles, { intro = false } = {}) {
  for (const lang of ['zh', 'en']) {
    if (!articles?.[lang]) continue;
    const page = (await getJson(`${WIKIPEDIA[lang]}/w/api.php?${query({
      action: 'query', prop: 'extracts|info', explaintext: '1', exsectionformat: 'wiki', inprop: 'url', titles: articles[lang],
      redirects: '1', ...(intro ? { exintro: '1' } : {}), ...(lang === 'zh' ? { variant: 'zh-cn' } : {}), format: 'json', formatversion: '2'
    })}`))?.query?.pages?.[0];
    if (page?.extract?.trim()) return { lang, title: page.title, url: page.fullurl, text: page.extract };
  }
  return null;
}

// The picture the Wikipedia editors chose to head the article.
async function wikiLeadImage(lang, title) {
  if (!title) return null;
  const page = (await getJson(`${WIKIPEDIA[lang]}/w/api.php?${query({
    action: 'query', prop: 'pageimages', piprop: 'name', titles: title, redirects: '1', format: 'json', formatversion: '2'
  })}`))?.query?.pages?.[0];
  return page?.pageimage?.replace(/_/g, ' ') ?? null;
}

// Cover candidates in order of preference: the article lead pictures, then Wikidata's.
export async function imageCandidates(wikidata) {
  if (!wikidata) return [];
  const leads = [await wikiLeadImage('zh', wikidata.articles.zh), await wikiLeadImage('en', wikidata.articles.en)];
  return [...new Set([...leads, ...wikidata.images].filter(Boolean))];
}

// The first Commons image whose license allows hotlinking with attribution. Rejections are returned for the PR.
export async function freeImage(filenames) {
  const rejected = [];
  for (const filename of filenames.slice(0, 6)) {
    const page = (await getJson(`https://commons.wikimedia.org/w/api.php?${query({
      action: 'query', titles: `File:${filename}`, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1280',
      iiextmetadatafilter: 'License|LicenseShortName|LicenseUrl|Artist|Credit|NonFree|Restrictions',
      format: 'json', formatversion: '2'
    })}`))?.query?.pages?.[0];
    const info = page?.imageinfo?.[0];
    if (!info) { rejected.push({ filename, reason: 'not found on Commons' }); continue; }
    const meta = Object.fromEntries(Object.entries(info.extmetadata ?? {}).map(([key, entry]) => [key, entry?.value]));
    const problem = imageLicenseProblem(meta)
      ?? (info.width < MIN_IMAGE_WIDTH ? `too small to show sharply (${info.width}×${info.height})` : null);
    const url = new URL(info.thumburl || info.url);
    url.search = '';
    if (problem || !isHttpsUrl(url.href)) { rejected.push({ filename, reason: problem ?? 'not an HTTPS URL' }); continue; }
    const attribution = imageAttribution(meta);
    return { image: { url: url.href, page: info.descriptionurl, filename, ...attribution, credit: imageCredit(attribution) }, rejected };
  }
  return { image: null, rejected };
}

// TDWG WGSRPD tables, downloaded on use and cached in the OS temp folder, as the frontend's build-regions script does.
// They are not copied into this repository because the scheme's license is not declared.
const WGSRPD = 'https://raw.githubusercontent.com/tdwg/wgsrpd/master/109-488-1-ED/2nd%20Edition';
const cache = path.join(os.tmpdir(), 'biota-wgsrpd');
// The site follows the China point of view: Taiwan, Hong Kong and Macao belong to tdwg-36.
const CHINA = ['CN', 'TW', 'HK', 'MO'];

async function wgsrpdTable(name) {
  const file = path.join(cache, `${name}.txt`);
  if (!fs.existsSync(file)) {
    const response = await fetch(`${WGSRPD}/${name}.txt`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`WGSRPD ${name}: HTTP ${response.status}`);
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const [header, ...rows] = fs.readFileSync(file, 'latin1').trim().split(/\r?\n/).map(line => line.split('*'));
  return rows.map(row => Object.fromEntries(header.map((key, index) => [key, row[index]])));
}

// ISO country code → ids of the level-2 regions it lies in, and each region's English name.
export async function regionTables() {
  const names = new Map((await wgsrpdTable('tblLevel2')).map(row => [`tdwg-${Number.parseInt(row['L2 code'])}`, row['L2 region']]));
  const level2 = new Map((await wgsrpdTable('tblLevel3')).map(row => [row['L3 code'], `tdwg-${Number.parseInt(row['L2 code'])}`]));
  const isoToRegions = new Map();
  for (const row of await wgsrpdTable('tblLevel4')) {
    const iso = row['L4 ISOcode'];
    if (!iso || !level2.has(row['L3 code'])) continue;
    if (!isoToRegions.has(iso)) isoToRegions.set(iso, new Set());
    isoToRegions.get(iso).add(level2.get(row['L3 code']));
  }
  for (const iso of CHINA) isoToRegions.set(iso, new Set(['tdwg-36']));
  return { isoToRegions, names };
}
