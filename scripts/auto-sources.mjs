// Open data sources for scripts/auto-species.mjs. Facts come from here, never from the language model:
// GBIF Backbone Taxonomy (CC BY 4.0) for names and classification, IUCN categories as served by GBIF,
// Wikidata (CC0) for Chinese names, and Wikimedia Commons for freely licensed images.
import { CONSERVATION_STATUSES, isHttpsUrl } from './catalog.mjs';
import { imageCredit, imageLicenseProblem } from './auto-rules.mjs';

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

// The Wikidata item that carries this GBIF taxon id (property P846), with its Chinese name, images and zhwiki title.
export async function wikidataForGbif(key) {
  const search = await getJson(`https://www.wikidata.org/w/api.php?${query({
    action: 'query', list: 'search', srsearch: `haswbstatement:P846=${key}`, srlimit: '1', format: 'json'
  })}`);
  const qid = search?.query?.search?.[0]?.title;
  if (!qid) return null;
  const entity = (await getJson(`https://www.wikidata.org/w/api.php?${query({
    action: 'wbgetentities', ids: qid, props: 'labels|claims|sitelinks', languages: ZH_LABELS.join('|'), sitefilter: 'zhwiki', format: 'json'
  })}`))?.entities?.[qid];
  if (!entity) return null;
  const language = ZH_LABELS.find(code => entity.labels?.[code]?.value);
  return {
    qid,
    url: `https://www.wikidata.org/wiki/${qid}`,
    name_zh: language ? entity.labels[language].value : null,
    name_language: language ?? null,
    images: (entity.claims?.P18 ?? []).map(claim => claim.mainsnak?.datavalue?.value).filter(Boolean),
    zhwiki: entity.sitelinks?.zhwiki?.title ?? null
  };
}

// The first Commons image whose license allows hotlinking with attribution. Rejections are returned for the PR.
export async function freeImage(filenames) {
  const rejected = [];
  for (const filename of filenames.slice(0, 5)) {
    const page = (await getJson(`https://commons.wikimedia.org/w/api.php?${query({
      action: 'query', titles: `File:${filename}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1280',
      iiextmetadatafilter: 'License|LicenseShortName|LicenseUrl|Artist|Credit|NonFree|Restrictions',
      format: 'json', formatversion: '2'
    })}`))?.query?.pages?.[0];
    const info = page?.imageinfo?.[0];
    if (!info) { rejected.push({ filename, reason: 'not found on Commons' }); continue; }
    const meta = Object.fromEntries(Object.entries(info.extmetadata ?? {}).map(([key, entry]) => [key, entry?.value]));
    const problem = imageLicenseProblem(meta);
    const url = new URL(info.thumburl || info.url);
    url.search = '';
    if (problem || !isHttpsUrl(url.href)) { rejected.push({ filename, reason: problem ?? 'not an HTTPS URL' }); continue; }
    return { image: { url: url.href, page: info.descriptionurl, license: meta.LicenseShortName, credit: imageCredit(meta, info.descriptionurl) }, rejected };
  }
  return { image: null, rejected };
}

// Plain text of the Chinese Wikipedia article in Simplified script. Only used to detect copied text: it is never
// sent to the model, so the generated description cannot be an adaptation of it.
export async function zhwikiText(title) {
  if (!title) return '';
  const page = (await getJson(`https://zh.wikipedia.org/w/api.php?${query({
    action: 'query', prop: 'extracts', explaintext: '1', titles: title, variant: 'zh-cn', format: 'json', formatversion: '2'
  })}`))?.query?.pages?.[0];
  return page?.extract ?? '';
}
