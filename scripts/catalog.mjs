import fs from 'node:fs';
import path from 'node:path';

export const PAGE_SIZE = 48;
export const RANKS = new Set([
  'domain', 'kingdom', 'subkingdom', 'phylum', 'subphylum', 'class',
  'subclass', 'order', 'suborder', 'family', 'subfamily', 'tribe',
  'genus', 'subgenus', 'species', 'subspecies', 'variety', 'form',
  'clade', 'unranked'
]);
const REQUIRED = ['id', 'parent_id', 'rank', 'scientific_name', 'name_zh'];
const OPTIONAL = ['image_url', 'image_credit', 'source_url', 'distribution', 'distribution_basis', 'conservation_status', 'toxicity'];
// IUCN Red List categories. Only species-level taxa carry an assessment.
export const CONSERVATION_STATUSES = new Set(['EX', 'EW', 'CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'NE']);
export const CONSERVATION_RANKS = new Set(['species', 'subspecies']);
// A descriptive editorial label, not a standardized hazard assessment. Omit when evidence is absent.
export const TOXICITY_LEVELS = new Set(['none', 'mild', 'toxic', 'high']);
// Detect direct lethal-risk claims about this taxon, excluding remarks about poisonous lookalikes.
export function highToxicityClaim(paragraphs, names) {
  const subjects = [...names.filter(Boolean), '该物种', '本种', '该菌', '这种真菌'];
  const danger = /^(?:是|为|具有|有|属于|含有|所含)?[\s，、的]{0,3}(?:剧毒|致命毒性|可致命|能致死)/;
  for (const paragraph of paragraphs) {
    for (const sentence of String(paragraph.text ?? '').split(/[。！？\n]/)) {
      const trimmed = sentence.trim();
      for (const subject of subjects) {
        const position = trimmed.indexOf(subject);
        if (position < 0 || (['该物种', '本种', '该菌', '这种真菌'].includes(subject) && position !== 0)) continue;
        if (danger.test(trimmed.slice(position + subject.length))) return trimmed;
      }
    }
  }
  return null;
}
// Region id → parent id. Mirrors src/regions.js in the frontend; the map geometry uses the same ids.
export const REGION_PARENTS = JSON.parse(fs.readFileSync(new URL('./regions.json', import.meta.url), 'utf8'));

export function parseTaxon(markdown, filename = 'unknown.md') {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: missing front matter`);
  const metadata = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const pair = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!pair) throw new Error(`${filename}: invalid metadata line: ${line}`);
    const [, key, raw] = pair;
    if (![...REQUIRED, ...OPTIONAL].includes(key) || key in metadata) {
      throw new Error(`${filename}: unknown or repeated field: ${key}`);
    }
    try {
      metadata[key] = JSON.parse(raw);
    } catch {
      throw new Error(`${filename}: ${key} must be valid JSON`);
    }
  }
  for (const key of REQUIRED) {
    if (!(key in metadata)) throw new Error(`${filename}: missing ${key}`);
  }
  const { id, parent_id: parentId, rank, scientific_name: scientificName, name_zh: nameZh } = metadata;
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`${filename}: invalid id`);
  }
  if (parentId !== null && (typeof parentId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parentId))) {
    throw new Error(`${filename}: invalid parent_id`);
  }
  if (!RANKS.has(rank)) throw new Error(`${filename}: invalid rank: ${rank}`);
  if (typeof scientificName !== 'string' || scientificName.length < 2 || scientificName.length > 160) {
    throw new Error(`${filename}: invalid scientific_name`);
  }
  // An empty string means that no sourced Chinese name has been found yet.
  if (typeof nameZh !== 'string' || nameZh.length > 120) {
    throw new Error(`${filename}: invalid name_zh`);
  }
  for (const key of ['image_url', 'image_credit', 'source_url']) {
    if (metadata[key] !== undefined && typeof metadata[key] !== 'string') {
      throw new Error(`${filename}: ${key} must be a string`);
    }
  }
  for (const key of ['image_url', 'source_url']) {
    if (metadata[key] && !isHttpsUrl(metadata[key])) {
      throw new Error(`${filename}: ${key} must be an HTTPS URL`);
    }
  }
  if (metadata.image_url && !metadata.image_credit) {
    throw new Error(`${filename}: image_credit is required with image_url`);
  }
  if (metadata.distribution !== undefined) {
    const problem = distributionProblem(metadata.distribution);
    if (problem) throw new Error(`${filename}: distribution ${problem}`);
  }
  if (metadata.distribution_basis !== undefined &&
      (!['native', 'records'].includes(metadata.distribution_basis) || !metadata.distribution?.length)) {
    throw new Error(`${filename}: distribution_basis requires a nonempty distribution and must be native or records`);
  }
  if (metadata.conservation_status !== undefined) {
    if (!CONSERVATION_STATUSES.has(metadata.conservation_status)) {
      throw new Error(`${filename}: invalid conservation_status`);
    }
    if (!CONSERVATION_RANKS.has(rank)) throw new Error(`${filename}: conservation_status is only for species or subspecies`);
  }
  if (metadata.toxicity !== undefined) {
    if (!TOXICITY_LEVELS.has(metadata.toxicity)) throw new Error(`${filename}: invalid toxicity`);
    if (!CONSERVATION_RANKS.has(rank)) throw new Error(`${filename}: toxicity is only for species or subspecies`);
  }
  const body = match[2].trim();
  if (body.length < 10) throw new Error(`${filename}: description is too short`);
  if (CONSERVATION_RANKS.has(rank) && metadata.toxicity !== 'high' && highToxicityClaim([{ text: body.split(/\n## 资料来源\n/)[0] }], [nameZh, scientificName])) {
    throw new Error(`${filename}: description directly claims lethal toxicity but toxicity is not high`);
  }
  if (markdownImageUrls(body).some(url => !isHttpsUrl(url))) {
    throw new Error(`${filename}: Markdown image must be an HTTPS URL`);
  }
  return { ...metadata, body };
}

export function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

// Returns why a distribution list is invalid, or null. A region may not appear with one of its ancestors.
export function distributionProblem(value) {
  if (!Array.isArray(value) || value.length > 100) return 'must be an array of at most 100 region ids';
  const ids = new Set(value);
  if (ids.size !== value.length) return 'has repeated regions';
  for (const id of value) {
    if (typeof id !== 'string' || !Object.hasOwn(REGION_PARENTS, id)) return `has unknown region: ${id}`;
    for (let parent = REGION_PARENTS[id]; parent !== null; parent = REGION_PARENTS[parent]) {
      if (ids.has(parent)) return `lists ${id} inside ${parent}`;
    }
  }
  return null;
}

export function markdownImageUrls(source) {
  return [...source.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(match => match[1]);
}

export function loadTaxa(docsDirectory) {
  const directory = path.join(docsDirectory, 'taxa');
  const taxa = new Map();
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.md')).sort()) {
    const taxon = parseTaxon(fs.readFileSync(path.join(directory, filename), 'utf8'), filename);
    if (filename !== `${taxon.id}.md`) throw new Error(`${filename}: filename must match id`);
    if (taxa.has(taxon.id)) throw new Error(`${filename}: repeated id`);
    taxa.set(taxon.id, taxon);
  }
  if (taxa.size === 0) throw new Error('No taxa found');
  validateTree(taxa);
  return taxa;
}

export function validateTree(taxa) {
  for (const taxon of taxa.values()) {
    if (taxon.parent_id !== null && !taxa.has(taxon.parent_id)) {
      throw new Error(`${taxon.id}: unknown parent ${taxon.parent_id}`);
    }
    if (taxon.parent_id === taxon.id) throw new Error(`${taxon.id}: cannot parent itself`);
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`${id}: taxonomy cycle`);
    if (visited.has(id)) return;
    visiting.add(id);
    const parent = taxa.get(id).parent_id;
    if (parent !== null) visit(parent);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of taxa.keys()) visit(id);
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function expectedIndexes(taxa) {
  const children = new Map();
  children.set(null, []);
  for (const taxon of taxa.values()) {
    if (!children.has(taxon.id)) children.set(taxon.id, []);
    if (!children.has(taxon.parent_id)) children.set(taxon.parent_id, []);
    children.get(taxon.parent_id).push(taxon);
  }
  const listing = taxon => ({
    id: taxon.id,
    parent_id: taxon.parent_id,
    rank: taxon.rank,
    scientific_name: taxon.scientific_name,
    name_zh: taxon.name_zh,
    image_url: taxon.image_url || null,
    ...(taxon.conservation_status ? { conservation_status: taxon.conservation_status } : {}),
    ...(taxon.toxicity ? { toxicity: taxon.toxicity } : {}),
    child_count: children.get(taxon.id)?.length || 0
  });
  const sort = (a, b) => a.name_zh.localeCompare(b.name_zh, 'zh-Hans-CN') || a.id.localeCompare(b.id);
  const output = new Map();
  output.set('roots.json', serialize({ items: children.get(null).map(listing).sort(sort) }));
  for (const taxon of taxa.values()) {
    const items = children.get(taxon.id).map(listing).sort(sort);
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    for (let page = 1; page <= pages; page++) {
      output.set(`children/${taxon.id}/${page}.json`, serialize({
        parent_id: taxon.id,
        page,
        total: items.length,
        next: page < pages ? page + 1 : null,
        items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      }));
    }
  }
  return output;
}

function existingIndexFiles(docsDirectory) {
  const found = new Set();
  if (fs.existsSync(path.join(docsDirectory, 'roots.json'))) found.add('roots.json');
  const base = path.join(docsDirectory, 'children');
  if (!fs.existsSync(base)) return found;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.add(path.relative(docsDirectory, full));
    }
  }
  walk(base);
  return found;
}

export function syncIndexes(docsDirectory, { check = false } = {}) {
  const expected = expectedIndexes(loadTaxa(docsDirectory));
  const existing = existingIndexFiles(docsDirectory);
  const errors = [];
  for (const [relative, content] of expected) {
    const target = path.join(docsDirectory, relative);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      if (check) errors.push(`stale or missing ${relative}`);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    }
  }
  for (const relative of existing) {
    if (!expected.has(relative)) {
      if (check) errors.push(`obsolete ${relative}`);
      else fs.unlinkSync(path.join(docsDirectory, relative));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { taxa: loadTaxa(docsDirectory).size, files: expected.size };
}

export function createTaxonMarkdown(input) {
  const metadata = {
    id: input.id,
    parent_id: input.parent_id,
    rank: input.rank,
    scientific_name: input.scientific_name,
    name_zh: input.name_zh,
    image_url: input.image_url || '',
    image_credit: input.image_credit || '',
    source_url: input.source_url || '',
    ...(input.distribution?.length ? { distribution: input.distribution } : {}),
    ...(input.distribution?.length && input.distribution_basis ? { distribution_basis: input.distribution_basis } : {}),
    ...(input.conservation_status ? { conservation_status: input.conservation_status } : {}),
    ...(input.toxicity ? { toxicity: input.toxicity } : {})
  };
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${input.description.trim()}\n`;
}
