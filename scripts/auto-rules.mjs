// Pure rules for scripts/auto-species.mjs: no network and no SDK, so they can be unit tested.

// GBIF Backbone ranks, from the top, as they appear on a GBIF species record.
export const LINEAGE_RANKS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'];
// Commons license codes we can hotlink with attribution: CC0, public domain, CC BY and CC BY-SA (any version or port).
const FREE_LICENSE = /^(?:cc0|pd|cc-by(?:-sa)?-\d\.\d(?:-[a-z]+)?)$/;
// A run of this many identical characters (punctuation and spaces ignored) counts as copied text.
export const COPY_RUN = 20;

export function slugify(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function uniqueId(base, rank, taken) {
  if (!taken.has(base)) return base;
  for (let suffix = 1; ; suffix++) {
    const id = suffix === 1 ? `${base}-${rank}` : `${base}-${rank}-${suffix}`;
    if (!taken.has(id)) return id;
  }
}

// Finds where a GBIF species record joins the existing tree: the deepest existing taxon with the same rank and name.
// Everything below it on the GBIF lineage must be created.
export function planLineage(taxa, record) {
  const lower = value => value.toLowerCase();
  if ([...taxa.values()].some(taxon => lower(taxon.scientific_name) === lower(record.canonicalName))) {
    throw new Error(`${record.canonicalName} is already in the catalog`);
  }
  const lineage = LINEAGE_RANKS.filter(rank => record[rank] && record[`${rank}Key`])
    .map(rank => ({ rank, scientific_name: record[rank], gbif_key: record[`${rank}Key`] }));
  for (let index = lineage.length - 1; index >= 0; index--) {
    const { rank, scientific_name: name } = lineage[index];
    const existing = [...taxa.values()].find(taxon => taxon.rank === rank && lower(taxon.scientific_name) === lower(name));
    if (existing) return { parentId: existing.id, missing: lineage.slice(index + 1) };
  }
  return { parentId: null, missing: lineage };
}

export function htmlToText(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// Returns why a Commons file may not be used, or null. `meta` is its extmetadata reduced to plain values.
export function imageLicenseProblem(meta) {
  if (String(meta.NonFree).toLowerCase() === 'true') return 'marked non-free';
  if (htmlToText(meta.Restrictions)) return `has restrictions: ${htmlToText(meta.Restrictions)}`;
  const license = String(meta.License ?? '').toLowerCase();
  if (!FREE_LICENSE.test(license)) return `license not allowed: ${license || 'none'}`;
  if (!htmlToText(meta.Artist) && !htmlToText(meta.Credit)) return 'no author to credit';
  return null;
}

export function imageCredit(meta, pageUrl) {
  const author = htmlToText(meta.Artist) || htmlToText(meta.Credit);
  const license = htmlToText(meta.LicenseShortName) || meta.License;
  const licenseUrl = meta.LicenseUrl ? `（${meta.LicenseUrl}）` : '';
  return `作者：${author}；许可：${license}${licenseUrl}；来源：Wikimedia Commons ${pageUrl}`.slice(0, 1000);
}

const normalizeForCopy = text => text.replace(/[\s\p{P}\p{S}]/gu, '');

// Returns the first passage of `text` that also appears verbatim in `reference`, or null.
export function copiedPassage(text, reference, length = COPY_RUN) {
  const source = normalizeForCopy(reference);
  if (source.length < length) return null;
  const shingles = new Set();
  for (let index = 0; index + length <= source.length; index++) shingles.add(source.slice(index, index + length));
  const target = normalizeForCopy(text);
  for (let index = 0; index + length <= target.length; index++) {
    const passage = target.slice(index, index + length);
    if (shingles.has(passage)) return passage;
  }
  return null;
}

// Generated prose must be plain paragraphs: links, images, headings and HTML are added by the script or not at all,
// so a model cannot invent a URL or an image.
export function descriptionProblem(text, { min, max }) {
  if (typeof text !== 'string') return 'is missing';
  const value = text.trim();
  if (value.length < min || value.length > max) return `must be ${min}–${max} characters, got ${value.length}`;
  if (/https?:|www\.|\]\(|!\[|<[a-z/!]/i.test(value)) return 'must not contain links, images or HTML';
  if (/^\s*(#|>|```)/m.test(value)) return 'must not contain headings, quotes or code blocks';
  return null;
}

export function composeBody(description, sources) {
  const lines = sources.map(({ label, title, url, note }) => `- ${label}：[${title}](${url})${note ? `（${note}）` : ''}`);
  return `${description.trim()}\n\n## 资料来源\n\n${lines.join('\n')}\n\n> 本条目文字由 AI 根据上述公开资料辅助撰写，并经编辑审核。`;
}
