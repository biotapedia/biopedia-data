// Pure rules for scripts/auto-species.mjs: no network and no SDK, so they can be unit tested.
import { TOXICITY_LEVELS } from './catalog.mjs';

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

// Reproducible sample from a GBIF candidate list when the user specified a taxon but no selection preference.
// Hashing names avoids preferring the API's first page order or familiar species memorized by the model.
export function stableSpeciesSample(species, count) {
  const hash = name => {
    let value = 2166136261;
    for (const char of name.toLowerCase()) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
    return value >>> 0;
  };
  return [...species].sort((a, b) => hash(a.canonicalName) - hash(b.canonicalName)
    || a.canonicalName.localeCompare(b.canonicalName)).slice(0, count);
}

// The GBIF record a taxon was taken from, read from its source_url, or null.
export const gbifKeyOf = taxon => String(taxon.source_url ?? '').match(/^https:\/\/www\.gbif\.org\/species\/(\d+)$/)?.[1] ?? null;

// Finds where a GBIF species record joins the existing tree: the deepest existing taxon with the same rank and name.
// Everything below it on the GBIF lineage must be created.
export function planLineage(taxa, record) {
  const lower = value => value.toLowerCase();
  if ([...taxa.values()].some(taxon => lower(taxon.scientific_name) === lower(record.canonicalName))) {
    throw new Error(`${record.canonicalName} is already in the catalog`);
  }
  // Editors may file a species under a newer name than GBIF's (Felis manul as Otocolobus manul); it keeps its GBIF record.
  const renamed = [...taxa.values()].find(taxon => gbifKeyOf(taxon) === String(record.key));
  if (renamed) {
    throw new Error(`${record.canonicalName} is in the catalog as ${renamed.scientific_name} (${renamed.id}), classified apart from GBIF; edit it by hand`);
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

// Text that is placed inside Markdown link syntax or a caption must not be able to break out of it.
export const clean = text => String(text ?? '').replace(/[\[\]()<>`]/g, ' ').replace(/\s+/g, ' ').trim();

// Author and license of a Commons file. The caption on the cover stays short; the license link goes in the sources list.
export function imageAttribution(meta) {
  const license = clean(htmlToText(meta.LicenseShortName) || meta.License);
  const licenseUrl = /^https:\/\/creativecommons\.org\//.test(meta.LicenseUrl ?? '') ? meta.LicenseUrl : null;
  return { author: clean(htmlToText(meta.Artist) || htmlToText(meta.Credit)).slice(0, 80), license, licenseUrl };
}

export const imageCredit = ({ author, license }) => `作者：${author} · 许可：${license} · 来源：Wikimedia Commons`;

export function imageSourceNote({ author, license, licenseUrl }) {
  return `作者 ${author}，${licenseUrl ? `[${license}](${licenseUrl})` : license}`;
}

// Latin letters are dropped as well: the prose is Chinese, and a scientific name alone (Ailuropoda melanoleuca) is long
// enough to look like a copied passage.
const normalizeForCopy = text => text.replace(/[\s\p{P}\p{S}a-z]/giu, '');

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

// Parentheses in a URL would end a Markdown link early; their percent-encoded forms address the same page.
export const linkUrl = url => url.replace(/\(/g, '%28').replace(/\)/g, '%29');

export function composeBody(description, sources) {
  const lines = sources.map(({ label, title, url, note }) => `- ${label}：[${clean(title)}](${linkUrl(url)})${note ? `（${note}）` : ''}`);
  return `${description.trim()}\n\n## 资料来源\n\n${lines.join('\n')}\n\n> 本条目文字由 AI 撰写，并对照上述资料自动核查，待编辑审核。`;
}

// ---- Reference text ------------------------------------------------------------------------------------------------

const SKIPPED_SECTIONS = /^(参见|参考文献|参考资料|外部链接|延伸阅读|注释|注解|备注|脚注|腳註|相关作品|See also|References|External links|Further reading|Notes|Footnotes|In popular culture)$/i;

// The part of an encyclopedia article worth reading: boilerplate sections dropped, cut at a paragraph.
export function referenceText(text, limit = 10000) {
  let skipping = false;
  const kept = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const top = line.match(/^==(?!=)\s*(.+?)\s*==\s*$/);
    if (top) skipping = SKIPPED_SECTIONS.test(top[1]);
    if (!skipping) kept.push(line);
  }
  const joined = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (joined.length <= limit) return joined;
  const cut = joined.lastIndexOf('\n', limit);
  return joined.slice(0, cut > limit / 2 ? cut : limit).trimEnd();
}

// ---- Prose ---------------------------------------------------------------------------------------------------------

export function plainTextProblem(text) {
  if (/https?:|www\.|\]\(|!\[|<[a-z/!]/i.test(text)) return 'must not contain links, images or HTML';
  if (/^\s*(#|>|```)/m.test(text)) return 'must not contain headings, quotes or code blocks';
  return null;
}

export function headingProblem(heading) {
  if (typeof heading !== 'string' || heading.trim().length < 2 || heading.trim().length > 12) return '小标题需要 2–12 个字';
  if (/[#\[\]()<>`*_\n]|https?:/i.test(heading)) return '小标题不能含标记或链接';
  return null;
}

// Everything wrong with one entry's paragraphs: missing text or headings, links or markup, and length.
export function paragraphProblems(paragraphs, { kind, min, max }) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return ['没有段落'];
  const problems = [];
  const texts = [];
  paragraphs.forEach((paragraph, index) => {
    if (kind === 'species') {
      const problem = headingProblem(paragraph?.heading);
      if (problem) problems.push(`第 ${index + 1} 段：${problem}`);
    }
    const text = typeof paragraph?.text === 'string' ? paragraph.text.trim() : '';
    if (text) texts.push(text);
    else problems.push(`第 ${index + 1} 段没有正文`);
  });
  const problem = descriptionProblem(texts.join(''), { min, max });
  if (problem) problems.push(`正文${problem}`);
  return problems;
}

export function renderParagraphs(paragraphs, { headings }) {
  return paragraphs.map(paragraph => {
    const body = paragraph.text.trim();
    return headings && paragraph.heading?.trim() ? `## ${paragraph.heading.trim()}\n\n${body}` : body;
  }).join('\n\n');
}

// A toxicity label is accepted only with a verbatim passage from a reference the model actually read.
export function sourceBackedToxicity(value, references) {
  if (!value || !TOXICITY_LEVELS.has(value.level) || typeof value.evidence !== 'string') return null;
  const evidence = value.evidence.trim();
  if (evidence.length < 8 || evidence.length > 200) return null;
  if (value.level === 'high' && !/(?:deadly|lethal|fatal|death|剧毒|致命|致死|死亡)/i.test(evidence)) return null;
  const source = references.find(reference => reference.text.includes(evidence));
  return source ? { level: value.level, evidence, source: source.source } : null;
}

// ---- Fact check: the reviewing model names exact passages to replace, so every change is small and listed in the PR ----

// Punctuation left dangling where a clause was deleted.
const tidy = text => text.replace(/[，、；：]\s*([。！？])/g, '$1').replace(/([。！？；，])\s*[，、；]/g, '$1')
  .replace(/^[\s，、；。]+/, '').replace(/[ \t]{2,}/g, ' ').trim();

// Applies corrections of the form { original, replacement, reason } to one entry's paragraphs. A correction is skipped
// when its passage is not found exactly once or when `check(newText)` names a problem with the result.
// Paragraphs left empty are dropped.
export function applyCorrections(paragraphs, corrections, check = () => null) {
  let result = paragraphs.map(paragraph => ({ ...paragraph, text: paragraph.text.trim() }));
  const applied = [];
  const skipped = [];
  for (const correction of corrections) {
    const { original, replacement } = correction;
    if (typeof original !== 'string' || !original.trim() || typeof replacement !== 'string') {
      skipped.push({ ...correction, why: '格式不完整' });
      continue;
    }
    const hits = result.flatMap((paragraph, index) => {
      const found = [];
      for (let at = paragraph.text.indexOf(original); at !== -1; at = paragraph.text.indexOf(original, at + 1)) found.push({ index, at });
      return found;
    });
    if (hits.length !== 1) {
      skipped.push({ ...correction, why: hits.length ? '原文片段出现了不止一次' : '原文中找不到这段文字' });
      continue;
    }
    const [{ index, at }] = hits;
    const before = result[index].text;
    let head = before.slice(0, at);
    // Deleting the end of a sentence that began after a comma: the comma's clause now ends the sentence.
    if (!replacement && /[。！？]$/.test(original)) head = head.replace(/[，、；：]\s*$/, original.at(-1));
    const text = tidy(head + replacement + before.slice(at + original.length));
    const problem = text ? check(text) : null;
    if (problem) {
      skipped.push({ ...correction, why: problem });
      continue;
    }
    result = result.map((paragraph, position) => (position === index ? { ...paragraph, text } : paragraph));
    applied.push(correction);
  }
  return { paragraphs: result.filter(paragraph => paragraph.text), applied, skipped };
}

// ---- Distribution: source-backed native regions when possible; otherwise clearly labeled observation regions -------

// Land regions that have GBIF records, from per-country counts. `isoToRegions` maps an ISO country code to region ids.
export function regionCandidates(counts, isoToRegions, regionNames, countryName) {
  const found = new Map();
  for (const [iso, records] of counts) {
    for (const id of isoToRegions.get(iso) ?? []) {
      if (!found.has(id)) found.set(id, { id, name: regionNames.get(id) ?? id, records: 0, countries: [] });
      const region = found.get(id);
      region.records += records;
      region.countries.push({ iso, name: countryName(iso), records });
    }
  }
  return [...found.values()].sort((a, b) => b.records - a.records);
}

// A level-1 region replaces its children when all of them are listed, as the contribution form's map does.
export function collapseRegions(regions, parents) {
  const chosen = new Set(regions);
  for (const parent of new Set([...chosen].map(id => parents[id]).filter(Boolean))) {
    const children = Object.keys(parents).filter(id => parents[id] === parent);
    if (children.every(id => chosen.has(id))) {
      for (const id of children) chosen.delete(id);
      chosen.add(parent);
    }
  }
  return [...chosen];
}

// Keep supported native regions independently. If none are supported, show all observed regions as records, not range.
export function selectDistribution(value, candidates, parents) {
  if (!candidates.length) return { regions: [], basis: null, note: 'GBIF 没有可用的陆地观察记录' };
  const regions = [...new Set(Array.isArray(value?.regions) ? value.regions : [])];
  const supported = new Set(candidates.map(candidate => candidate.id));
  const native = value?.confidence === 'high' ? regions.filter(id => supported.has(id)) : [];
  const unsupported = regions.filter(id => !supported.has(id));
  if (native.length) {
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    return { regions: collapseRegions(native, parents), basis: 'native',
      note: `${reason || '模型认为这些地区属于原生分布'}${unsupported.length ? `；已排除无 GBIF 记录支持的地区：${unsupported.join('、')}` : ''}` };
  }
  return { regions: collapseRegions([...supported], parents), basis: 'records',
    note: `原生范围未能确认，展示 GBIF 有记录地区${unsupported.length ? `；已排除无记录地区：${unsupported.join('、')}` : ''}` };
}

// ---- Batches ---------------------------------------------------------------------------------------------------------

// Scientific names from any mix of lists: one per line or separated by commas or semicolons, `#` starts a comment.
export function parseSpeciesList(...texts) {
  const seen = new Set();
  const names = [];
  for (const text of texts) {
    const lines = String(text ?? '').split('\n').map(line => line.replace(/#.*$/, '')).join('\n');
    for (const raw of lines.split(/[\n,;，；]+/)) {
      const name = raw.replace(/\s+/g, ' ').trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
  }
  return names;
}

// The GBIF candidates the model picked, in its order, each once. Names that are not candidates (misspelt, invented, or
// already in the catalog) are returned separately so they can be reported, never added.
export function chosenCandidates(names, candidates) {
  const byName = new Map(candidates.filter(item => item.canonicalName).map(item => [item.canonicalName.toLowerCase(), item]));
  const chosen = [];
  const unknown = [];
  for (const name of names) {
    const candidate = byName.get(String(name).replace(/\s+/g, ' ').trim().toLowerCase());
    if (!candidate) unknown.push(name);
    else if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  return { chosen, unknown };
}

export const IDS_MARKER =/<!-- auto-species-ids: ([a-z0-9,-]+) -->/;

// Species ids already proposed by earlier automated pull requests: from the branch name, and from the marker that a
// batch pull request carries for all of its species.
export function proposedFromPulls(pulls) {
  const ids = new Set();
  for (const pull of pulls) {
    if (!pull.headRefName?.startsWith('auto/')) continue;
    ids.add(pull.headRefName.slice(5));
    for (const id of pull.body?.match(IDS_MARKER)?.[1].split(',') ?? []) ids.add(id);
  }
  return ids;
}
