// Adds species, each with any missing ancestor taxa, as reviewable changes.
//
//   node scripts/auto-species.mjs [--name "Panthera tigris"]... [--file names.txt] [--ask "眼镜蛇科的20个物种"] [--count N]
//                                 [--plan] [--pr] [--replace]
//
// --name (repeatable; commas and new lines also separate names) and --file (one name per line, `#` comments) say which
// species to add. --count N picks N more automatically: living species from GBIF under the deepest taxa already
// in the catalog. Without any of them one species is picked. --ask describes the species in words instead: the model
// names the taxon to search, GBIF lists the species under it that the catalog lacks, and the model picks from that list
// only; --count then overrides the number in the request. Species are done one after another; one that fails is
// reported and skipped. --plan prints what it gathered and stops before calling the model. --pr commits each species to
// one auto/<id> branch and opens a single pull request (used by .github/workflows/auto-species.yml); otherwise files
// are written to docs/ for review. --replace regenerates species that are already in the catalog (no sub-taxa allowed).
//
// Find reference material before calling the writer; only taxonomic facts are passed to the writer.
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTaxonMarkdown, highToxicityClaim, loadTaxa, parseTaxon, REGION_PARENTS, syncIndexes } from './catalog.mjs';
import {
  ASK_PROMPT, askShapeProblem, chatJson, LLM_SETTINGS, PICK_PROMPT, pickShapeProblem, REVIEW_PROMPT, reviewShapeProblem, WRITE_PROMPT,
  writingShapeProblem
} from './auto-llm.mjs';
import {
  applyCorrections, chosenCandidates, clean, composeBody, copiedPassage, COPY_RUN, gbifKeyOf, imageSourceNote, LINEAGE_RANKS, linkUrl, paragraphProblems,
  planLineage, plainTextProblem, referenceText, parseSpeciesList, proposedFromPulls, regionCandidates, renderParagraphs, selectDistribution, sourceBackedToxicity, stableSpeciesSample, slugify, uniqueId
} from './auto-rules.mjs';
import {
  freeImage, gbifAllSpeciesUnder, gbifCountryCounts, gbifMatch, gbifRecord, gbifSpeciesUnder, gbifSpeciesUrl, imageCandidates, iucnStatus,
  regionTables, speciesReferenceArticles, wikiArticles, wikidataForGbif
} from './auto-sources.mjs';

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDirectory = path.join(repoDirectory, 'docs');
// Local settings may live in an uncommitted .env (see .env.example). Variables already set, as in CI, take precedence.
const envFile = path.join(repoDirectory, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const verifiedChineseNames = JSON.parse(fs.readFileSync(new URL('./verified-chinese-names.json', import.meta.url), 'utf8'));
const chineseName = entry => entry.nameRecord?.name ?? entry.wikidata?.name_zh ?? '';

const MAX_BATCH = 20;
// Species of the asked-for taxon shown to the model; larger taxa are cut, and the model is told the list is partial.
const MAX_ASK_CANDIDATES = 2000;
const MAX_SOURCE_PROBES = 100;
const LENGTHS = { species: { min: 120, max: 1400 }, ancestor: { min: 20, max: 400 } };
// Keep the fact-check input bounded even when several scholarly sources are found.
const REFERENCE_CHARS = { species: { zh: 4000, en: 6000 }, ancestor: { zh: 1500, en: 1500 } };
const SPECIES_REFERENCE_BUDGET = 30000;
const MAX_DISTRIBUTION_CANDIDATES = 30;
const STATUS_ZH = { EX: '灭绝', EW: '野外灭绝', CR: '极危', EN: '濒危', VU: '易危', NT: '近危', LC: '无危', DD: '数据缺乏', NE: '未评估' };
const TOXICITY_ZH = { none: '无毒', mild: '微毒', toxic: '有毒', high: '剧毒' };
const RANK_ZH = { kingdom: '界', phylum: '门', class: '纲', order: '目', family: '科', genus: '属', species: '种' };
const countryNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });

const kindOf = entry => (entry.rank === 'species' ? 'species' : 'ancestor');
const articleName = article => article.kind === 'scholarly' ? `学术论文摘要「${article.title}」`
  : article.kind === 'scholarly-fulltext' ? `开放获取论文物种段落「${article.title}」`
  : article.kind === 'gbif-description' ? `GBIF 物种描述「${article.title}」`
    : `${article.lang === 'zh' ? '中文' : '英文'}维基百科「${article.title}」`;
// What the source checker reads of each entry's reference material.
const references = entry => {
  let remaining = kindOf(entry) === 'species' ? SPECIES_REFERENCE_BUDGET : 3000;
  return entry.articles.map(article => {
    const perSource = article.kind === 'scholarly' ? 2000 : article.kind === 'scholarly-fulltext' ? 2000
      : article.kind === 'gbif-description' ? 2000 : REFERENCE_CHARS[kindOf(entry)][article.lang] ?? 1500;
    const text = referenceText(article.text, Math.min(perSource, remaining));
    remaining -= text.length;
    return { source: articleName(article), text };
  }).filter(reference => reference.text);
};
// The first run of text copied verbatim from any of the entry's articles, or null.
const copiedFrom = (entry, text) => entry.articles.map(article => copiedPassage(text, article.text)).find(Boolean) ?? null;

const speciesSourceCache = new Map();
async function speciesSources(key, scientificName, { enrich = false } = {}) {
  if (!speciesSourceCache.has(key)) speciesSourceCache.set(key, { wikidata: (async () => {
    try { return await wikidataForGbif(key); }
    catch (error) { console.warn(`Wikidata unavailable for ${scientificName}: ${error.message}`); return null; }
  })() });
  const cached = speciesSourceCache.get(key);
  const mode = enrich ? 'enriched' : 'basic';
  if (!cached[mode]) cached[mode] = cached.wikidata.then(async wikidata => ({
    wikidata, articles: await speciesReferenceArticles(key, scientificName, wikidata, { enrich })
  }));
  return cached[mode];
}

function run(program, args) {
  return execFileSync(program, args, {
    cwd: repoDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env
  }).trim();
}

// Species already proposed by this script, merged or not, so a rejected proposal is not offered again.
function proposedIds() {
  return proposedFromPulls(JSON.parse(run('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'headRefName,body'])));
}

// Whether a GBIF species is missing from the catalog and was not proposed by an earlier automated pull request.
function newSpeciesFilter(taxa, proposed) {
  const known = new Set([...taxa.values()].map(taxon => taxon.scientific_name.toLowerCase()));
  const knownKeys = new Set([...taxa.values()].map(gbifKeyOf).filter(Boolean));
  return species => Boolean(species.canonicalName) && !known.has(species.canonicalName.toLowerCase())
    && !knownKeys.has(String(species.key)) && !proposed.has(slugify(species.canonicalName));
}

async function pickCandidate(taxa, proposed) {
  const isNew = newSpeciesFilter(taxa, proposed);
  const ancestry = id => {
    const chain = [];
    for (let taxon = taxa.get(id); taxon; taxon = taxa.get(taxon.parent_id)) chain.push(taxon);
    return chain;
  };
  const groups = [...taxa.values()].filter(taxon => LINEAGE_RANKS.includes(taxon.rank))
    .sort((a, b) => ancestry(b.id).length - ancestry(a.id).length || a.id.localeCompare(b.id));
  for (const group of groups) {
    const root = ancestry(group.id).at(-1);
    const kingdom = root.rank === 'kingdom' ? root.scientific_name : undefined;
    const { record } = await gbifMatch(group.scientific_name, { rank: group.rank.toUpperCase(), kingdom });
    if (!record) continue;
    const candidates = (await gbifSpeciesUnder(record.key)).filter(species => !species.extinct && isNew(species));
    for (const candidate of stableSpeciesSample(candidates, Math.min(candidates.length, MAX_SOURCE_PROBES))) {
      if (!(await speciesSources(candidate.key, candidate.canonicalName)).articles.length) {
        console.warn(`Skipped ${candidate.canonicalName}: no supported species reference retrieved before writing`);
        continue;
      }
      return gbifRecord(candidate.key);
    }
  }
  throw new Error('No candidate found; pass --name');
}

// A model call whose JSON must have a usable shape, asked once more with the problem when it does not.
async function chatChecked(system, user, shapeProblem, label) {
  let feedback = '';
  for (let attempt = 1; ; attempt++) {
    const { output } = await chatJson(system, user + feedback, { label });
    const problem = shapeProblem(output);
    if (!problem) return output;
    if (attempt === 2) throw new Error(`The model did not return usable output to ${label}: ${problem}`);
    feedback = `\n\n上一次的输出不符合格式要求：${problem}。请按要求重新输出。`;
    console.warn(`Output was malformed, retrying: ${problem}`);
  }
}

// --ask: the model turns the request into a taxon, GBIF lists the species under it that the catalog lacks, and the
// model ranks species from that list when the request includes criteria. Without criteria, take a stable sample.
// Names the model makes up are dropped, so every species still comes from GBIF.
async function askSpecies(request, { count, room, taxa, proposed }) {
  const parsed = await chatChecked(ASK_PROMPT, request, askShapeProblem, 'understand the request');
  const group = parsed.group?.trim();
  if (!group) throw new Error(`Could not tell which taxon the request means: ${parsed.problem || 'the model named none'}`);
  const rank = parsed.rank?.trim().toLowerCase();
  if (!LINEAGE_RANKS.includes(rank)) throw new Error(`The model gave ${group} the rank "${parsed.rank}"; expected ${LINEAGE_RANKS.join(', ')}`);
  const wanted = count ?? parsed.count ?? 1;
  if (wanted < 1) throw new Error('--count must be at least 1 with --ask');
  if (wanted > room) throw new Error(`At most ${MAX_BATCH} species per run, got ${wanted + MAX_BATCH - room}`);

  // A wrong kingdom from the model should not hide an otherwise exact match.
  const kingdom = parsed.kingdom?.trim() || undefined;
  let match = await gbifMatch(group, { rank: rank.toUpperCase(), kingdom });
  if (!match.record && kingdom) match = await gbifMatch(group, { rank: rank.toUpperCase() });
  if (match.problem) throw new Error(`The request was read as ${RANK_ZH[rank]} ${group}, but ${match.problem}`);
  const groupName = match.record.canonicalName;
  const { species, complete } = await gbifAllSpeciesUnder(match.record.key, MAX_ASK_CANDIDATES);
  const isNew = newSpeciesFilter(taxa, proposed);
  const candidates = species.filter(item => !item.extinct && isNew(item));
  console.warn(`Read as ${rank} ${groupName}${parsed.criteria ? `, ${parsed.criteria}` : ''}: GBIF lists ${species.length}${complete ? '' : '+'} `
    + `species, ${candidates.length} not in the catalog yet.`);
  if (!candidates.length) throw new Error(`Every species GBIF lists under ${groupName} is already in the catalog or was proposed`);

  let chosen;
  let reason;
  if (parsed.criteria?.trim()) {
    const input = {
      request, criteria: parsed.criteria, count: wanted, max_listed: Math.min(candidates.length, wanted * 2 + 5),
      candidates_complete: complete, candidates: [...new Set(candidates.map(item => item.canonicalName))]
    };
    const picked = await chatChecked(PICK_PROMPT, JSON.stringify(input, null, 1), pickShapeProblem, 'choose the species');
    const ranked = chosenCandidates(picked.species, candidates);
    chosen = ranked.chosen;
    if (ranked.unknown.length) console.warn(`Ignored names that are not candidates: ${ranked.unknown.join(', ')}`);
    reason = picked.reason ?? '';
  } else {
    chosen = stableSpeciesSample(candidates, Math.min(candidates.length, MAX_SOURCE_PROBES));
    reason = '未指定其他筛选条件，从 GBIF 候选名单按学名稳定抽样；写作前检查参考资料，不按知名度或 IUCN 评估筛选';
  }
  const records = [];
  for (const candidate of chosen) {
    if (records.length === wanted) break;
    if (!(await speciesSources(candidate.key, candidate.canonicalName)).articles.length) {
      console.warn(`Skipped ${candidate.canonicalName}: no supported species reference retrieved before writing`);
      continue;
    }
    records.push(await gbifRecord(candidate.key));
  }
  console.warn(`Picked ${records.length} of ${wanted}: ${records.map(record => record.canonicalName).join(', ') || 'none'}`);
  if (reason) console.warn(`Selection: ${reason}`);
  if (!records.length) throw new Error(`No species under ${groupName} matched the request`);
  return {
    records,
    summary: { request, group: groupName, rank, criteria: parsed.criteria ?? '', reason, wanted, found: records.length }
  };
}

// Regions with observation records. Best effort: without them the species simply gets no distribution.
async function distributionCandidates(key) {
  try {
    const [counts, { isoToRegions, names }] = await Promise.all([gbifCountryCounts(key), regionTables()]);
    const countryName = iso => { try { return countryNames.of(iso) ?? iso; } catch { return iso; } };
    return { candidates: regionCandidates(counts, isoToRegions, names, countryName), problem: null };
  } catch (error) {
    console.warn(`Skipping the distribution: ${error.message}`);
    return { candidates: [], problem: `获取分布依据失败：${error.message}` };
  }
}

async function gather(taxa, record, { plan = false } = {}) {
  const lineagePlan = planLineage(taxa, record);
  const taken = new Set(taxa.keys());
  const entries = [...lineagePlan.missing, { rank: 'species', scientific_name: record.canonicalName, gbif_key: record.key }]
    .map(entry => {
      const id = uniqueId(slugify(entry.scientific_name), entry.rank, taken);
      taken.add(id);
      return { ...entry, id };
    });
  for (const entry of [entries.at(-1), ...entries.slice(0, -1)]) {
    if (entry.rank === 'species') {
      ({ wikidata: entry.wikidata, articles: entry.articles } = await speciesSources(entry.gbif_key, entry.scientific_name, { enrich: true }));
      if (!entry.articles.length) throw new Error(`No supported species reference retrieved for ${entry.scientific_name}; skipped before calling the writing model`);
    } else {
      entry.wikidata = await wikidataForGbif(entry.gbif_key);
      try { entry.articles = await wikiArticles(entry.wikidata?.articles, { intro: true }); }
      catch (error) {
        console.warn(`Ancestor references unavailable for ${entry.scientific_name}: ${error.message}`);
        entry.articles = [];
      }
    }
    entry.nameRecord = verifiedChineseNames[entry.scientific_name] ?? null;
  }
  const species = entries.at(-1);
  species.authorship = (record.authorship || '').trim();
  try {
    species.status = await iucnStatus(record.key);
  } catch (error) {
    console.warn(`IUCN status unavailable for ${record.canonicalName}: ${error.message}`);
    species.status = null;
  }
  ({ image: species.image, rejected: species.rejectedImages } = await freeImage(await imageCandidates(species.wikidata)));
  ({ candidates: species.regionCandidates, problem: species.regionProblem } = await distributionCandidates(record.key));
  // Chinese names for the whole lineage; existing taxa use the catalog's own names.
  const classification = LINEAGE_RANKS.filter(rank => record[rank]).map(rank => {
    const existing = [...taxa.values()].find(taxon => taxon.rank === rank && taxon.scientific_name.toLowerCase() === record[rank].toLowerCase());
    const created = entries.find(entry => entry.rank === rank);
    return { rank, scientific_name: record[rank], name_zh: existing?.name_zh ?? (created ? chineseName(created) : null) };
  });
  return { parentId: lineagePlan.parentId, entries, classification };
}

// The authoritative data about the species: name, classification and status.
function speciesFacts({ entries, classification }) {
  const species = entries.at(-1);
  return {
    scientific_name: species.scientific_name, rank: species.rank, name_zh: chineseName(species) || null,
    authorship: species.authorship || null,
    classification: classification.map(item => ({ rank: item.rank, scientific_name: item.scientific_name, name_zh: item.name_zh })),
    conservation_status: species.status ? `${species.status.code}（${STATUS_ZH[species.status.code]}）` : null
  };
}

// The writer sees verified taxonomy but no reference prose, even though sources were located in advance.
function writingInput(gathered) {
  const { entries } = gathered;
  const describe = entry => ({
    scientific_name: entry.scientific_name, rank: entry.rank, name_zh: chineseName(entry) || null
  });
  return {
    species: speciesFacts(gathered),
    ancestors: entries.slice(0, -1).map(describe),
    distribution_candidates: []
  };
}

// Returns every reason the generated prose cannot be used, so a retry can address them all at once.
function proseProblems(output, entries) {
  const shape = writingShapeProblem(output);
  if (shape) return [shape];
  const problems = [];
  const ancestors = entries.slice(0, -1);
  const aligned = output.ancestors.length === ancestors.length
    && output.ancestors.every((item, index) => item.scientific_name.toLowerCase() === ancestors[index].scientific_name.toLowerCase());
  if (!aligned) problems.push(`ancestors 必须依次为：${ancestors.map(entry => entry.scientific_name).join('、') || '（空）'}`);
  const pairs = aligned
    ? entries.map((entry, index) => [entry, index < ancestors.length ? output.ancestors[index] : output.species])
    : [[entries.at(-1), output.species]];
  for (const [entry, item] of pairs) {
    const kind = kindOf(entry);
    problems.push(...paragraphProblems(item.paragraphs, { kind, ...LENGTHS[kind] }).map(problem => `${entry.scientific_name}：${problem}`));
    const text = (item.paragraphs ?? []).map(paragraph => paragraph?.text ?? '').join('');
    const copied = copiedFrom(entry, text);
    if (copied) problems.push(`${entry.scientific_name} 的介绍与参考资料有连续 ${COPY_RUN} 字以上相同：「${copied}」，请换用完全不同的表述`);
  }
  return problems;
}

async function writeProse(gathered) {
  const request = `请为以下条目撰写介绍。\n\n${JSON.stringify(writingInput(gathered), null, 2)}`;
  let feedback = '';
  for (let attempt = 1; ; attempt++) {
    const result = await chatJson(WRITE_PROMPT, request + feedback, { label: 'write the descriptions' });
    // Extra ancestors are irrelevant when the whole lineage already exists. Some models still include one.
    if (gathered.entries.length === 1 && result.output && typeof result.output === 'object') result.output.ancestors = [];
    const problems = proseProblems(result.output, gathered.entries);
    if (!problems.length) return result;
    if (attempt === 3) throw new Error(`Generated text failed checks:\n${problems.join('\n')}`);
    feedback = `\n\n上一次的输出没有通过检查，请按要求重写：\n${problems.map(problem => `- ${problem}`).join('\n')}`;
    console.warn(`Attempt ${attempt} failed checks, retrying:\n${problems.join('\n')}`);
  }
}

// The draft's prose for each entry, in the order of `entries`.
const proseFor = (entries, output) => entries.map((entry, index) => (index === entries.length - 1 ? output.species : output.ancestors[index]));

// Applies the fact check's corrections to a copy of the draft. A correction that would bring in markup or copied text is
// skipped and reported, as is one whose passage cannot be found exactly once.
function applyReview(entries, draft, { output, model }) {
  const reviewed = structuredClone(draft);
  reviewed.distribution = output.distribution ?? { confidence: 'low', regions: [], reason: '' };
  reviewed.species.toxicity = output.toxicity ?? null;
  const applied = [];
  const skipped = [];
  const named = name => entry => name.trim().toLowerCase() === entry.scientific_name.toLowerCase();
  proseFor(entries, reviewed).forEach((prose, index) => {
    const entry = entries[index];
    const check = text => plainTextProblem(text) ?? (copiedFrom(entry, text) ? '改后与参考文章有大段相同文字' : null);
    const result = applyCorrections(prose.paragraphs, output.corrections.filter(item => named(item.scientific_name)(entry)), check);
    const problems = paragraphProblems(result.paragraphs, { kind: kindOf(entry), min: 1, max: LENGTHS[kindOf(entry)].max });
    if (problems.length) throw new Error(`The fact check left ${entry.scientific_name} unusable: ${problems.join('; ')}`);
    prose.paragraphs = result.paragraphs;
    applied.push(...result.applied);
    skipped.push(...result.skipped);
  });
  skipped.push(...output.corrections.filter(item => !entries.some(named(item.scientific_name))).map(item => ({ ...item, why: '没有这个学名的条目' })));
  if (skipped.length) throw new Error(`The source check could not apply ${skipped.length} correction(s): ${skipped.map(item => item.why).join('; ')}`);
  const finalProblems = proseProblems(reviewed, entries);
  if (finalProblems.length) throw new Error(`The source check left unusable prose:\n${finalProblems.join('\n')}`);
  return { output: reviewed, review: { model, applied, skipped, doubts: output.doubts ?? [] } };
}

// A second model call checks the draft against the facts and the same references, and names exact passages to fix,
// including the claims the writer itself was unsure of.
async function reviewProse(gathered, draft) {
  const { entries } = gathered;
  const species = entries.at(-1);
  const input = {
    facts: speciesFacts(gathered),
    references: entries.map(entry => ({ scientific_name: entry.scientific_name, references: references(entry) })),
    distribution_candidates: (entries.at(-1).regionCandidates ?? []).slice(0, MAX_DISTRIBUTION_CANDIDATES).map(region => ({
      id: region.id, name: region.name, records: region.records,
      countries: region.countries.slice(0, 6).map(country => `${country.name} ${country.records}`)
    })),
    drafts: proseFor(entries, draft).map((prose, index) => ({
      scientific_name: entries[index].scientific_name, rank: entries[index].rank, paragraphs: prose.paragraphs
    })),
    writer_doubts: draft.claims_to_verify ?? []
  };
  const request = `请核对以下条目。\n\n${JSON.stringify(input, null, 2)}`;
  let feedback = '';
  for (let attempt = 1; ; attempt++) {
    const result = await chatJson(REVIEW_PROMPT, request + feedback, {
      label: 'fact-check the descriptions', model: process.env.LLM_REVIEW_MODEL || undefined
    });
    let problem = reviewShapeProblem(result.output);
    if (!problem) {
      const checked = applyReview(entries, draft, result);
      const claim = highToxicityClaim(checked.output.species.paragraphs, [chineseName(species), species.scientific_name]);
      const badge = sourceBackedToxicity(checked.output.species.toxicity, references(species));
      if (!claim || badge?.level === 'high') return checked;
      problem = `${species.scientific_name} 正文明确称该物种剧毒或可致命（「${claim.slice(0, 100)}」），但 high 毒性标签缺少该物种参考资料的逐字依据。请给出有原文依据的 high/evidence，或用 corrections 删除无依据的毒性断言`;
    }
    if (attempt === 2) throw new Error(`The fact check did not reconcile the draft: ${problem}`);
    feedback = `\n\n上一次的核查没有通过：${problem}。请按要求重新输出。`;
    console.warn(`Fact check failed checks, retrying: ${problem}`);
  }
}

function referenceSource(article) {
  return {
    label: '参考资料', title: articleName(article), url: article.url,
    note: article.kind === 'wikipedia' ? 'CC BY-SA 4.0；仅作参考，文字为重新撰写' : '仅作事实核查，文字为重新撰写'
  };
}

function buildEntries({ parentId, entries }, output, distribution, toxicity) {
  let parent = parentId;
  return entries.map((entry, index) => {
    const isSpecies = entry.rank === 'species';
    const prose = isSpecies ? output.species : output.ancestors[index];
    const nameZh = chineseName(entry);
    const nameSource = entry.nameRecord?.source ?? (entry.wikidata?.name_zh ? `Wikidata（${entry.wikidata.name_language}）` : '未找到可靠中文名，待查');
    const sources = [{ label: '学名与分类', title: 'GBIF Backbone Taxonomy', url: gbifSpeciesUrl(entry.gbif_key), note: 'CC BY 4.0' }];
    if (entry.nameRecord) sources.push({ label: '中文名', title: entry.nameRecord.source, url: entry.nameRecord.url });
    else if (entry.wikidata?.name_zh) sources.push({ label: '中文名', title: `Wikidata ${entry.wikidata.qid}`, url: entry.wikidata.url, note: 'CC0' });
    for (const article of entry.articles) sources.push(referenceSource(article));
    if (isSpecies && entry.status) {
      sources.push({
        label: '保护等级', title: 'IUCN 红色名录',
        url: entry.status.iucnTaxonID ? `https://www.iucnredlist.org/species/${entry.status.iucnTaxonID}` : gbifSpeciesUrl(entry.gbif_key),
        note: '经 GBIF 获取'
      });
    }
    if (isSpecies && distribution.regions.length) {
      sources.push({
        label: distribution.basis === 'records' ? '地图记录来源' : '地图候选记录',
        title: 'GBIF 观察记录', url: gbifSpeciesUrl(entry.gbif_key),
        note: distribution.basis === 'records' ? '有记录不等于原生分布；区域划分采用 TDWG WGSRPD' : '原生范围参照上列参考资料；区域划分采用 TDWG WGSRPD'
      });
    }
    if (isSpecies && entry.image) {
      sources.push({ label: '封面图片', title: 'Wikimedia Commons', url: entry.image.page, note: imageSourceNote(entry.image) });
    }
    const markdown = createTaxonMarkdown({
      id: entry.id, parent_id: parent, rank: entry.rank, scientific_name: entry.scientific_name, name_zh: nameZh,
      image_url: isSpecies ? entry.image?.url : '', image_credit: isSpecies ? entry.image?.credit : '',
      source_url: gbifSpeciesUrl(entry.gbif_key),
      ...(isSpecies && entry.status ? { conservation_status: entry.status.code } : {}),
      ...(isSpecies && toxicity ? { toxicity: toxicity.level } : {}),
      ...(isSpecies ? { distribution: distribution.regions, distribution_basis: distribution.basis } : {}),
      description: composeBody(renderParagraphs(prose.paragraphs, { headings: isSpecies }), sources)
    });
    parseTaxon(markdown, `${entry.id}.md`);
    parent = entry.id;
    return { ...entry, name_zh: nameZh, name_source: nameSource, markdown };
  });
}

// A corrected or quoted passage, safe to show in the pull request.
const quote = text => `「${clean(text).slice(0, 160) || '（删去）'}」`;

function reviewReport(review) {
  if (!review) return [];
  const applied = review.applied.map(item => `- ${quote(item.original)} → ${quote(item.replacement)}：${clean(item.reason)}`);
  const skipped = review.skipped.map(item => `- 未应用（${item.why}）：${quote(item.original)} → ${quote(item.replacement)}：${clean(item.reason)}`);
  return ['### AI 核查记录', '', ...(applied.length || skipped.length ? [...applied, ...skipped] : ['- 核查没有发现需要改正的地方']), ''];
}

function speciesReport(built, output, distribution, toxicity, review) {
  const species = built.at(-1);
  const rows = built.map(entry =>
    `| \`${entry.id}\` | ${RANK_ZH[entry.rank]} | *${entry.scientific_name}* | ${entry.name_zh || '—'} | ${entry.name_source} |`);
  const image = species.image
    ? `${species.image.license}，[原图页面](${linkUrl(species.image.page)})`
    : '无（未找到许可合格的图片）';
  const skipped = species.rejectedImages.map(item => `  - 已跳过 ${item.filename}：${item.reason}`);
  const regionName = id => species.regionCandidates.find(region => region.id === id)?.name ?? id;
  const map = distribution.regions.length
    ? `${distribution.basis === 'records' ? 'GBIF 有记录地区' : '概略原生分布'}：${distribution.regions.map(id => `\`${id}\` ${regionName(id)}`).join('、')}。${distribution.note}`
    : `未填写：${distribution.note}`;
  const reference = species.articles.length
    ? `初稿未读取参考文章；核查时对照了${species.articles.map(article => `[${articleName(article)}](${linkUrl(article.url)})`).join('和')}`
    : '未找到参考资料；请格外仔细核对';
  const checked = `由 \`${review.model}\` 对照检索到的参考资料检查草稿，改正 ${review.applied.length} 处；仍需人工核实`;
  // After a fact check the writer's doubts have been dealt with; what is left are the ones the check could not settle.
  const claims = [...new Set((review.doubts ?? []).map(claim => claim.trim()).filter(Boolean))];
  return [
    '| 条目 | 级别 | 学名 | 中文名 | 中文名来源 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '### 已自动检查',
    '',
    `- 学名与分类：GBIF Backbone 精确匹配、状态为 ACCEPTED（[GBIF](${gbifSpeciesUrl(species.gbif_key)})）`,
    `- 保护等级：${species.status ? `${species.status.code}（${STATUS_ZH[species.status.code]}），来自 IUCN 红色名录（经 GBIF）` : 'GBIF 未返回 IUCN 等级，未填写'}`,
    `- 毒性：${toxicity ? `${TOXICITY_ZH[toxicity.level]}；依据${toxicity.source}原文 ${quote(toxicity.evidence)}` : output.species.toxicity ? '模型给出的等级或原文依据未通过检查，未填写' : '参考资料无明确依据，未填写'}`,
    `- 封面图片：${image}`,
    ...skipped,
    `- 介绍：${reference}；与参考文章没有连续 ${COPY_RUN} 字以上的相同片段，正文中没有模型生成的链接或图片`,
    `- 事实核查：${checked}`,
    `- 分布地图：${map}`,
    '',
    ...reviewReport(review),
    '### 需人工核实',
    '',
    ...(claims.length ? claims.map(claim => `- [ ] ${claim}`) : ['- [ ] AI 核查未列出遗留疑点；请通读全文']),
    ...(distribution.regions.length ? [`- [ ] 分布地图的“${distribution.basis === 'records' ? 'GBIF 有记录地区' : '概略原生分布'}”标注与所选地区相符`] : []),
    '',
    '### 审核清单',
    '',
    '- [ ] 分类位置正确，新增的上级分类确有必要',
    '- [ ] 中文名来源；标为「待查」的条目需继续检索中文论文或专业名录',
    '- [ ] 图片确为该物种，作者与许可信息完整',
    ...(toxicity ? ['- [ ] 毒性等级适用于这个物种，且正文准确说明中毒途径和条件'] : []),
    '- [ ] 文字准确、通顺，体型、数量等具体数据已对照权威资料'
  ].join('\n');
}

// One pull request for a whole batch: separate pull requests would edit the same index files and could each create the
// same new genus, so they could not all be merged.
function pullRequestText(results, failures, asked) {
  const species = results.map(result => result.species);
  const title = species.length === 1
    ? `自动新增：${species[0].name_zh || species[0].scientific_name}（${species[0].scientific_name}）`
    : `自动新增 ${species.length} 个物种：${species.slice(0, 5).map(item => item.name_zh || item.scientific_name).join('、')}${species.length > 5 ? ' 等' : ''}`;
  const listed = models => [...new Set(models.filter(Boolean))].map(model => `\`${model}\``).join('、');
  const reviewers = listed(results.map(result => result.review?.model));
  const sections = species.length === 1
    ? [results[0].report]
    : results.flatMap(result => [`## ${result.species.name_zh || result.species.scientific_name}（*${result.species.scientific_name}*）`, '', result.report, '']);
  const failed = failures.length ? ['', '## 未能生成', '', ...failures.map(item => `- ${item.target}：${item.message.split('\n')[0]}`), ''] : [];
  const body = [
    `由 \`scripts/auto-species.mjs\` 自动生成，文字模型：${listed(results.map(result => result.model))}${reviewers ? `，核查模型：${reviewers}` : ''}。`
      + '介绍文字为待审核草稿；即使启用了第二轮 AI 检查，也不能代替人工核实。',
    '',
    ...(asked ? [
      `按要求挑选：${quote(asked.request)} → 在 GBIF 的 *${asked.group}*（${RANK_ZH[asked.rank]}）下、图鉴尚未收录的物种中${asked.criteria ? '由模型按条件挑选' : '按学名稳定抽样'}`
        + `${asked.criteria ? `，其他要求：${clean(asked.criteria)}` : ''}${asked.reason ? `。挑选思路：${clean(asked.reason)}` : ''}`
        + `。要求 ${asked.wanted} 个，挑到 ${asked.found} 个；请确认所选物种符合要求。`,
      ''
    ] : []),
    ...sections,
    ...failed,
    `<!-- auto-species-ids: ${species.map(item => item.id).join(',')} -->`
  ].join('\n');
  return { title, body };
}

const currentBranch = () => run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

function startBranch(species) {
  const branch = `auto/${species.id}`;
  if (run('git', ['ls-remote', '--heads', 'origin', branch])) throw new Error(`Branch ${branch} already exists`);
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['switch', '-c', branch]);
  return branch;
}

function commitSpecies(species) {
  run('git', ['add', '--all', 'docs/taxa', 'docs/roots.json', 'docs/children']);
  run('git', ['commit', '-m', `Add ${species.scientific_name} (automated)`]);
}

function openPullRequest(branch, { title, body }) {
  run('git', ['push', '--set-upstream', 'origin', branch]);
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-species-')), 'body.md');
  fs.writeFileSync(bodyFile, body);
  return run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile]);
}

// Drops whatever a failed species left in docs/. Only used with --pr, which starts from a clean docs/.
function resetDocs() {
  run('git', ['checkout', '--', 'docs']);
  run('git', ['clean', '-fd', '--', 'docs']);
}

// Writes one species (and its missing ancestors) to docs/, or with `plan` only reports what would be used.
async function generate(record, taxa, { plan, replace }) {
  const replaced = replace
    ? [...taxa.values()].find(taxon => taxon.rank === 'species' && taxon.scientific_name.toLowerCase() === record.canonicalName.toLowerCase())
    : null;
  if (replaced) {
    if ([...taxa.values()].some(taxon => taxon.parent_id === replaced.id)) throw new Error(`${replaced.id} has sub-taxa and cannot be replaced automatically`);
    taxa.delete(replaced.id);
  }
  console.warn(`Gathering facts for ${record.canonicalName} from GBIF, Wikidata and Wikimedia Commons…`);
  const gathered = await gather(taxa, record, { plan }).catch(error => {
    throw /already in the catalog/.test(error.message) ? new Error(`${error.message}. Use --replace to regenerate it.`) : error;
  });
  const species = gathered.entries.at(-1);

  if (plan) {
    return { plan: {
      parent_id: gathered.parentId,
      entries: gathered.entries.map(entry => {
        const checkedReferences = new Map(references(entry).map(reference => [reference.source, reference.text.length]));
        return {
          id: entry.id, rank: entry.rank, scientific_name: entry.scientific_name, gbif: gbifSpeciesUrl(entry.gbif_key),
          name_zh: chineseName(entry) || null, name_source: entry.nameRecord?.url ?? entry.wikidata?.url ?? null, wikidata: entry.wikidata?.url ?? null,
          articles: entry.articles.map(article => ({ kind: article.kind, url: article.url, characters: article.text.length,
            read_for_check: checkedReferences.get(articleName(article)) ?? 0 })),
          authorship: entry.authorship ?? null
        };
      }),
      conservation_status: species.status?.code ?? null,
      image: species.image, rejected_images: species.rejectedImages,
      distribution_candidates: species.regionCandidates.map(({ id, name, records, countries }) => ({ id, name, records, countries: countries.map(country => country.name) })),
      distribution_problem: species.regionProblem
    } };
  }

  const written = await writeProse(gathered);
  console.warn(`Checking the draft against ${species.articles.map(article => articleName(article)).join(', ')} for ${record.canonicalName}…`);
  const result = { ...written, ...(await reviewProse(gathered, written.output)) };
  const distribution = species.regionProblem
    ? { regions: [], basis: null, note: species.regionProblem }
    : selectDistribution(result.output.distribution, species.regionCandidates, REGION_PARENTS);
  const toxicity = sourceBackedToxicity(result.output.species.toxicity, references(species));
  const built = buildEntries(gathered, result.output, distribution, toxicity);
  if (replaced && replaced.id !== species.id) fs.rmSync(path.join(docsDirectory, 'taxa', `${replaced.id}.md`), { force: true });
  for (const entry of built) fs.writeFileSync(path.join(docsDirectory, 'taxa', `${entry.id}.md`), entry.markdown);
  syncIndexes(docsDirectory);
  syncIndexes(docsDirectory, { check: true });
  return {
    species: built.at(-1), files: built.map(entry => `docs/taxa/${entry.id}.md`), model: result.model, review: result.review,
    report: speciesReport(built.map((entry, index) => ({ ...gathered.entries[index], ...entry })), result.output, distribution, toxicity, result.review)
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    name: { type: 'string', multiple: true }, file: { type: 'string' }, ask: { type: 'string' }, count: { type: 'string' },
    plan: { type: 'boolean' }, pr: { type: 'boolean' }, replace: { type: 'boolean' }
  } });
  const names = parseSpeciesList(...(values.name ?? []), process.env.SPECIES_NAME, values.file && fs.readFileSync(values.file, 'utf8'));
  const ask = (values.ask ?? process.env.SPECIES_ASK ?? '').trim();
  const countText = (values.count ?? process.env.SPECIES_COUNT ?? '').trim();
  const count = countText === '' ? null : Number(countText);
  if (count !== null && !(Number.isInteger(count) && count >= 0)) throw new Error(`--count must be a whole number, got "${countText}"`);
  // With --ask the count is the number of species to pick for the request, not automatic picks on top of it.
  const picks = ask ? 0 : count ?? (names.length ? 0 : 1);
  if (names.length + picks > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} species per run, got ${names.length + picks}`);
  if (ask && names.length >= MAX_BATCH) throw new Error(`At most ${MAX_BATCH} species per run; --name leaves no room for --ask`);
  const unset = LLM_SETTINGS.filter(key => !process.env[key]);
  if ((!values.plan || ask) && unset.length) {
    throw new Error(`Set ${unset.join(', ')} to call the language model${ask ? ' (--ask needs it even with --plan)' : ', or use --plan'}`);
  }
  if (values.pr && run('git', ['status', '--porcelain', '--', 'docs'])) {
    throw new Error('docs/ has uncommitted changes; commit or stash them before using --pr');
  }

  const proposed = values.pr ? proposedIds() : new Set();
  const asked = ask
    ? await askSpecies(ask, { count, room: MAX_BATCH - names.length, taxa: loadTaxa(docsDirectory), proposed })
    : null;
  const jobs = [
    ...names.map(name => ({ name })), ...(asked?.records ?? []).map(record => ({ record })), ...Array.from({ length: picks }, () => ({}))
  ];
  const startBranchName = values.pr ? currentBranch() : null;
  const startSha = values.pr ? run('git', ['rev-parse', 'HEAD']) : null;
  const results = [];
  const plans = [];
  const failures = [];
  if (asked && asked.summary.found < asked.summary.wanted) {
    failures.push({ target: '按要求挑选', message: `要求 ${asked.summary.wanted} 个，只找到 ${asked.summary.found} 个符合要求且有参考资料的物种` });
  }
  let branch = null;

  try {
    for (const [index, job] of jobs.entries()) {
      console.warn(`\n[${index + 1}/${jobs.length}] ${job.name ?? job.record?.canonicalName ?? 'picking a species automatically'}`);
      let record = null;
      let result = null;
      try {
        // Reloaded every time: species written earlier in this run are part of the catalog.
        const taxa = loadTaxa(docsDirectory);
        if (job.record) {
          record = job.record;
        } else if (job.name) {
          const match = await gbifMatch(job.name);
          if (match.problem) throw new Error(match.problem);
          record = match.record;
          if (proposed.has(slugify(record.canonicalName))) {
            console.warn(`${record.canonicalName} was already proposed in an auto/ pull request; skipped.`);
            continue;
          }
        } else {
          record = await pickCandidate(taxa, proposed);
          console.warn(`Picked ${record.canonicalName}`);
        }
        result = await generate(record, taxa, { plan: values.plan, replace: values.replace });
      } catch (error) {
        failures.push({ target: job.name ?? (record?.canonicalName ?? '自动挑选'), message: error.message });
        console.error(`Failed: ${error.message}`);
        if (values.pr) resetDocs();
        // Do not pick the same species again after it failed.
        if (record) proposed.add(slugify(record.canonicalName));
        if (!job.name && /No candidate found/.test(error.message)) break;
        continue;
      }
      if (result.plan) { plans.push(result.plan); continue; }
      results.push(result);
      proposed.add(slugify(result.species.scientific_name));
      if (values.pr) {
        branch ??= startBranch(result.species);
        commitSpecies(result.species);
      }
    }

    if (values.plan) {
      console.log(JSON.stringify(plans.length === 1 ? plans[0] : plans, null, 2));
    } else if (values.pr && results.length) {
      console.log(openPullRequest(branch, pullRequestText(results, failures, asked?.summary)));
    } else {
      for (const result of results) {
        console.log(`Wrote ${result.files.join(', ')} and updated the indexes.\n`);
        console.log(`${result.report}\n`);
      }
    }
  } finally {
    // Leave a local checkout where it was before the run.
    if (branch) run('git', startBranchName === 'HEAD' ? ['switch', '--detach', startSha] : ['switch', startBranchName]);
  }

  if (jobs.length > 1) {
    console.warn(`\nDone: ${results.length + plans.length} of ${jobs.length} species${values.plan ? ' planned' : ' written'}, ${failures.length} failed.`);
    for (const failure of failures) console.error(`  ${failure.target}: ${failure.message.split('\n')[0]}`);
  }
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
