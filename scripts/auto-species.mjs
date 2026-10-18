// Adds species, each with any missing ancestor taxa, as reviewable changes.
//
//   node scripts/auto-species.mjs [--name "Panthera tigris"]... [--file names.txt] [--count N] [--plan] [--pr] [--replace]
//
// --name (repeatable; commas and new lines also separate names) and --file (one name per line, `#` comments) say which
// species to add. --count N picks N more automatically: assessed, living species from GBIF under the deepest taxa already
// in the catalog. Without any of them one species is picked. Species are done one after another; one that fails is
// reported and skipped. --plan prints what it gathered and stops before calling the model. --pr commits each species to
// one auto/<id> branch and opens a single pull request (used by .github/workflows/auto-species.yml); otherwise files
// are written to docs/ for review. --replace regenerates species that are already in the catalog (no sub-taxa allowed).
//
// The text is written by one model call. An optional second pass compares it with the same references
// (LLM_REVIEW=on, LLM_REVIEW_MODEL defaults to LLM_MODEL); this is a drafting aid, not independent verification.
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTaxonMarkdown, loadTaxa, parseTaxon, REGION_PARENTS, syncIndexes } from './catalog.mjs';
import { chatJson, LLM_SETTINGS, REVIEW_PROMPT, reviewShapeProblem, WRITE_PROMPT, writingShapeProblem } from './auto-llm.mjs';
import {
  applyCorrections, clean, composeBody, copiedPassage, COPY_RUN, imageSourceNote, LINEAGE_RANKS, linkUrl, paragraphProblems,
  planLineage, plainTextProblem, referenceText, parseSpeciesList, proposedFromPulls, regionCandidates, renderParagraphs, selectDistribution, sourceBackedToxicity, slugify, uniqueId
} from './auto-rules.mjs';
import {
  freeImage, gbifCountryCounts, gbifMatch, gbifRecord, gbifSpeciesUnder, gbifSpeciesUrl, imageCandidates, iucnStatus,
  regionTables, wikiArticles, wikidataForGbif
} from './auto-sources.mjs';

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDirectory = path.join(repoDirectory, 'docs');
// Local settings may live in an uncommitted .env (see .env.example). Variables already set, as in CI, take precedence.
const envFile = path.join(repoDirectory, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const MAX_CANDIDATE_LOOKUPS = 40;
const MAX_BATCH = 20;
const LENGTHS = { species: { min: 200, max: 1400 }, ancestor: { min: 20, max: 400 } };
// Characters of each reference article the model reads: most of the species articles, only the lead of an ancestor's.
const REFERENCE_CHARS = { species: { zh: 10000, en: 15000 }, ancestor: { zh: 1500, en: 1500 } };
const MAX_DISTRIBUTION_CANDIDATES = 30;
const STATUS_ZH = { EX: '灭绝', EW: '野外灭绝', CR: '极危', EN: '濒危', VU: '易危', NT: '近危', LC: '无危', DD: '数据缺乏', NE: '未评估' };
const TOXICITY_ZH = { none: '无毒', mild: '微毒', toxic: '有毒', high: '剧毒' };
const RANK_ZH = { kingdom: '界', phylum: '门', class: '纲', order: '目', family: '科', genus: '属', species: '种' };
const countryNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });

const kindOf = entry => (entry.rank === 'species' ? 'species' : 'ancestor');
const articleName = article => `${article.lang === 'zh' ? '中文' : '英文'}维基百科「${article.title}」`;
// What the model reads of an entry's Wikipedia articles, one item per language.
const references = entry => entry.articles.map(article => ({
  source: articleName(article), text: referenceText(article.text, REFERENCE_CHARS[kindOf(entry)][article.lang])
}));
// The first run of text copied verbatim from any of the entry's articles, or null.
const copiedFrom = (entry, text) => entry.articles.map(article => copiedPassage(text, article.text)).find(Boolean) ?? null;

function run(program, args) {
  return execFileSync(program, args, {
    cwd: repoDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env
  }).trim();
}

// Species already proposed by this script, merged or not, so a rejected proposal is not offered again.
function proposedIds() {
  return proposedFromPulls(JSON.parse(run('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'headRefName,body'])));
}

async function pickCandidate(taxa, proposed) {
  const known = new Set([...taxa.values()].map(taxon => taxon.scientific_name.toLowerCase()));
  const ancestry = id => {
    const chain = [];
    for (let taxon = taxa.get(id); taxon; taxon = taxa.get(taxon.parent_id)) chain.push(taxon);
    return chain;
  };
  const groups = [...taxa.values()].filter(taxon => LINEAGE_RANKS.includes(taxon.rank))
    .sort((a, b) => ancestry(b.id).length - ancestry(a.id).length || a.id.localeCompare(b.id));
  let lookups = 0;
  for (const group of groups) {
    const root = ancestry(group.id).at(-1);
    const kingdom = root.rank === 'kingdom' ? root.scientific_name : undefined;
    const { record } = await gbifMatch(group.scientific_name, { rank: group.rank.toUpperCase(), kingdom });
    if (!record) continue;
    for (const species of await gbifSpeciesUnder(record.key)) {
      const name = species.canonicalName;
      if (!name || known.has(name.toLowerCase()) || proposed.has(slugify(name))) continue;
      if (++lookups > MAX_CANDIDATE_LOOKUPS) throw new Error('No candidate found; pass --name');
      // Fossil and unassessed species have no IUCN category, which keeps automatic picks to living, notable species.
      const status = await iucnStatus(species.key);
      if (!status || status.code === 'NE') continue;
      return gbifRecord(species.key);
    }
  }
  throw new Error('No candidate found; pass --name');
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

async function gather(taxa, record) {
  const plan = planLineage(taxa, record);
  const taken = new Set(taxa.keys());
  const entries = [...plan.missing, { rank: 'species', scientific_name: record.canonicalName, gbif_key: record.key }]
    .map(entry => {
      const id = uniqueId(slugify(entry.scientific_name), entry.rank, taken);
      taken.add(id);
      return { ...entry, id };
    });
  for (const entry of entries) {
    entry.wikidata = await wikidataForGbif(entry.gbif_key);
    entry.articles = await wikiArticles(entry.wikidata?.articles, { intro: entry.rank !== 'species' });
  }
  const species = entries.at(-1);
  species.authorship = (record.authorship || '').trim();
  species.status = await iucnStatus(record.key);
  ({ image: species.image, rejected: species.rejectedImages } = await freeImage(await imageCandidates(species.wikidata)));
  ({ candidates: species.regionCandidates, problem: species.regionProblem } = await distributionCandidates(record.key));
  // Chinese names for the whole lineage; existing taxa use the catalog's own names.
  const classification = LINEAGE_RANKS.filter(rank => record[rank]).map(rank => {
    const existing = [...taxa.values()].find(taxon => taxon.rank === rank && taxon.scientific_name.toLowerCase() === record[rank].toLowerCase());
    const created = entries.find(entry => entry.rank === rank);
    return { rank, scientific_name: record[rank], name_zh: existing?.name_zh ?? created?.wikidata?.name_zh ?? null };
  });
  return { parentId: plan.parentId, entries, classification };
}

// The authoritative data about the species: name, classification and status.
function speciesFacts({ entries, classification }) {
  const species = entries.at(-1);
  return {
    scientific_name: species.scientific_name, rank: species.rank, name_zh: species.wikidata?.name_zh ?? null,
    authorship: species.authorship || null,
    classification: classification.map(item => ({ rank: item.rank, scientific_name: item.scientific_name, name_zh: item.name_zh })),
    conservation_status: species.status ? `${species.status.code}（${STATUS_ZH[species.status.code]}）` : null
  };
}

// What the model is given: the facts and, for every entry, the Wikipedia excerpts to read.
function writingInput(gathered) {
  const { entries } = gathered;
  const species = entries.at(-1);
  const describe = entry => ({
    scientific_name: entry.scientific_name, rank: entry.rank, name_zh: entry.wikidata?.name_zh ?? null, references: references(entry)
  });
  return {
    species: { ...speciesFacts(gathered), references: references(species) },
    ancestors: entries.slice(0, -1).map(describe),
    distribution_candidates: (species.regionCandidates ?? []).slice(0, MAX_DISTRIBUTION_CANDIDATES).map(region => ({
      id: region.id, name: region.name, records: region.records,
      countries: region.countries.slice(0, 6).map(country => `${country.name} ${country.records}`)
    }))
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
    if (copied) problems.push(`${entry.scientific_name} 的介绍与维基百科文章有连续 ${COPY_RUN} 字以上相同：「${copied}」，请换用完全不同的表述`);
    if (!entry.wikidata?.name_zh && !item.name_zh?.trim()) problems.push(`没有 ${entry.scientific_name} 的中文名`);
  }
  return problems;
}

async function writeProse(gathered) {
  const request = `请为以下条目撰写介绍。\n\n${JSON.stringify(writingInput(gathered), null, 2)}`;
  let feedback = '';
  for (let attempt = 1; ; attempt++) {
    const result = await chatJson(WRITE_PROMPT, request + feedback, { label: 'write the descriptions' });
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
  return { output: reviewed, review: { model, applied, skipped, doubts: output.doubts ?? [] } };
}

// A second model call checks the draft against the facts and the same references, and names exact passages to fix,
// including the claims the writer itself was unsure of.
async function reviewProse(gathered, draft) {
  const { entries } = gathered;
  const input = {
    facts: speciesFacts(gathered),
    references: entries.map(entry => ({ scientific_name: entry.scientific_name, references: references(entry) })),
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
    const problem = reviewShapeProblem(result.output);
    if (!problem) return applyReview(entries, draft, result);
    if (attempt === 2) throw new Error(`The fact check did not return usable output: ${problem}`);
    feedback = `\n\n上一次的输出不符合格式要求：${problem}。请按要求重新输出。`;
    console.warn(`Fact check output was malformed, retrying: ${problem}`);
  }
}

function wikiSource(article) {
  return {
    label: '参考资料', title: articleName(article), url: article.url,
    note: 'CC BY-SA 4.0；仅作参考，文字为重新撰写'
  };
}

function buildEntries({ parentId, entries }, output, distribution, toxicity) {
  let parent = parentId;
  return entries.map((entry, index) => {
    const isSpecies = entry.rank === 'species';
    const prose = isSpecies ? output.species : output.ancestors[index];
    const nameZh = entry.wikidata?.name_zh ?? prose.name_zh.trim();
    const nameSource = entry.wikidata?.name_zh ? `Wikidata（${entry.wikidata.name_language}）` : 'AI 拟定，需核对';
    const sources = [{ label: '学名与分类', title: 'GBIF Backbone Taxonomy', url: gbifSpeciesUrl(entry.gbif_key), note: 'CC BY 4.0' }];
    if (entry.wikidata?.name_zh) sources.push({ label: '中文名', title: `Wikidata ${entry.wikidata.qid}`, url: entry.wikidata.url, note: 'CC0' });
    for (const article of entry.articles) sources.push(wikiSource(article));
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
    `| \`${entry.id}\` | ${RANK_ZH[entry.rank]} | *${entry.scientific_name}* | ${entry.name_zh} | ${entry.name_source} |`);
  const image = species.image
    ? `${species.image.license}，[原图页面](${linkUrl(species.image.page)})`
    : '无（未找到许可合格的图片）';
  const skipped = species.rejectedImages.map(item => `  - 已跳过 ${item.filename}：${item.reason}`);
  const regionName = id => species.regionCandidates.find(region => region.id === id)?.name ?? id;
  const map = distribution.regions.length
    ? `${distribution.basis === 'records' ? 'GBIF 有记录地区' : '概略原生分布'}：${distribution.regions.map(id => `\`${id}\` ${regionName(id)}`).join('、')}。${distribution.note}`
    : `未填写：${distribution.note}`;
  const reference = species.articles.length
    ? `模型阅读了${species.articles.map(article => `[${articleName(article)}](${linkUrl(article.url)})`).join('和')}作为参考，并结合自身知识撰写`
    : '没有找到维基百科条目，完全由模型凭自身知识撰写，请格外仔细核对';
  const checked = review
    ? `由 \`${review.model}\` 对照相同参考资料检查草稿，改正 ${review.applied.length} 处${review.skipped.length ? `，${review.skipped.length} 处建议未能自动应用` : ''}；仍需人工核实`
    : '未启用第二轮 AI 检查；请人工核实草稿';
  // After a fact check the writer's doubts have been dealt with; what is left are the ones the check could not settle.
  const claims = [...new Set((review ? review.doubts : output.claims_to_verify ?? []).map(claim => claim.trim()).filter(Boolean))];
  return [
    '| 条目 | 级别 | 学名 | 中文名 | 中文名来源 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '### 已自动检查',
    '',
    `- 学名与分类：GBIF Backbone 精确匹配、状态为 ACCEPTED（[GBIF](${gbifSpeciesUrl(species.gbif_key)})）`,
    `- 保护等级：${species.status ? `${species.status.code}（${STATUS_ZH[species.status.code]}），来自 IUCN 红色名录（经 GBIF）` : '无评估，未填写'}`,
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
    ...(claims.length ? claims.map(claim => `- [ ] ${claim}`) : [`- [ ] （${review ? 'AI 核查后没有遗留的存疑说法' : '模型未列出'}，请通读全文）`]),
    ...(distribution.regions.length ? [`- [ ] 分布地图的“${distribution.basis === 'records' ? 'GBIF 有记录地区' : '概略原生分布'}”标注与所选地区相符`] : []),
    '',
    '### 审核清单',
    '',
    '- [ ] 分类位置正确，新增的上级分类确有必要',
    '- [ ] 中文名规范（尤其是标为「AI 拟定」的）',
    '- [ ] 图片确为该物种，作者与许可信息完整',
    ...(toxicity ? ['- [ ] 毒性等级适用于这个物种，且正文准确说明中毒途径和条件'] : []),
    '- [ ] 文字准确、通顺，体型、数量等具体数据已对照权威资料'
  ].join('\n');
}

// One pull request for a whole batch: separate pull requests would edit the same index files and could each create the
// same new genus, so they could not all be merged.
function pullRequestText(results, failures) {
  const species = results.map(result => result.species);
  const title = species.length === 1
    ? `自动新增：${species[0].name_zh}（${species[0].scientific_name}）`
    : `自动新增 ${species.length} 个物种：${species.slice(0, 5).map(item => item.name_zh).join('、')}${species.length > 5 ? ' 等' : ''}`;
  const listed = models => [...new Set(models.filter(Boolean))].map(model => `\`${model}\``).join('、');
  const reviewers = listed(results.map(result => result.review?.model));
  const sections = species.length === 1
    ? [results[0].report]
    : results.flatMap(result => [`## ${result.species.name_zh}（*${result.species.scientific_name}*）`, '', result.report, '']);
  const failed = failures.length ? ['', '## 未能生成', '', ...failures.map(item => `- ${item.target}：${item.message.split('\n')[0]}`), ''] : [];
  const body = [
    `由 \`scripts/auto-species.mjs\` 自动生成，文字模型：${listed(results.map(result => result.model))}${reviewers ? `，核查模型：${reviewers}` : ''}。`
      + '介绍文字为待审核草稿；即使启用了第二轮 AI 检查，也不能代替人工核实。',
    '',
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
  console.warn(`Gathering facts for ${record.canonicalName} from GBIF, Wikidata, Wikipedia and Wikimedia Commons…`);
  const gathered = await gather(taxa, record).catch(error => {
    throw /already in the catalog/.test(error.message) ? new Error(`${error.message}. Use --replace to regenerate it.`) : error;
  });
  const species = gathered.entries.at(-1);

  if (plan) {
    return { plan: {
      parent_id: gathered.parentId,
      entries: gathered.entries.map(entry => ({
        id: entry.id, rank: entry.rank, scientific_name: entry.scientific_name, gbif: gbifSpeciesUrl(entry.gbif_key),
        name_zh: entry.wikidata?.name_zh ?? null, wikidata: entry.wikidata?.url ?? null,
        articles: entry.articles.map(article => ({ url: article.url, characters: article.text.length,
          read_by_model: referenceText(article.text, REFERENCE_CHARS[kindOf(entry)][article.lang]).length })),
        authorship: entry.authorship ?? null
      })),
      conservation_status: species.status?.code ?? null,
      image: species.image, rejected_images: species.rejectedImages,
      distribution_candidates: species.regionCandidates.map(({ id, name, records, countries }) => ({ id, name, records, countries: countries.map(country => country.name) })),
      distribution_problem: species.regionProblem
    } };
  }

  const written = await writeProse(gathered);
  const result = process.env.LLM_REVIEW === 'on' ? { ...written, ...(await reviewProse(gathered, written.output)) } : { ...written, review: null };
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
    name: { type: 'string', multiple: true }, file: { type: 'string' }, count: { type: 'string' },
    plan: { type: 'boolean' }, pr: { type: 'boolean' }, replace: { type: 'boolean' }
  } });
  const names = parseSpeciesList(...(values.name ?? []), process.env.SPECIES_NAME, values.file && fs.readFileSync(values.file, 'utf8'));
  const countText = (values.count ?? process.env.SPECIES_COUNT ?? '').trim();
  const picks = countText === '' ? (names.length ? 0 : 1) : Number(countText);
  if (!Number.isInteger(picks) || picks < 0) throw new Error(`--count must be a whole number, got "${countText}"`);
  if (names.length + picks > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} species per run, got ${names.length + picks}`);
  const unset = LLM_SETTINGS.filter(key => !process.env[key]);
  if (!values.plan && unset.length) throw new Error(`Set ${unset.join(', ')} to call the language model, or use --plan`);
  if (values.pr && run('git', ['status', '--porcelain', '--', 'docs'])) {
    throw new Error('docs/ has uncommitted changes; commit or stash them before using --pr');
  }

  const jobs = [...names.map(name => ({ name })), ...Array.from({ length: picks }, () => ({}))];
  const proposed = values.pr ? proposedIds() : new Set();
  const startBranchName = values.pr ? currentBranch() : null;
  const startSha = values.pr ? run('git', ['rev-parse', 'HEAD']) : null;
  const results = [];
  const plans = [];
  const failures = [];
  let branch = null;

  try {
    for (const [index, job] of jobs.entries()) {
      console.warn(`\n[${index + 1}/${jobs.length}] ${job.name ?? 'picking a species automatically'}`);
      let record = null;
      let result = null;
      try {
        // Reloaded every time: species written earlier in this run are part of the catalog.
        const taxa = loadTaxa(docsDirectory);
        if (job.name) {
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
      console.log(openPullRequest(branch, pullRequestText(results, failures)));
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
