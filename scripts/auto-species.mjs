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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTaxonMarkdown, loadTaxa, parseTaxon, REGION_PARENTS, syncIndexes } from './catalog.mjs';
import { chatJson, LLM_SETTINGS, WRITE_PROMPT, writingShapeProblem } from './auto-llm.mjs';
import {
  composeBody, copiedPassage, COPY_RUN, imageSourceNote, LINEAGE_RANKS, linkUrl, paragraphProblems, planLineage, referenceText,
  parseSpeciesList, proposedFromPulls, regionCandidates, renderParagraphs, selectDistribution, slugify, uniqueId
} from './auto-rules.mjs';
import {
  freeImage, gbifCountryCounts, gbifMatch, gbifRecord, gbifSpeciesUnder, gbifSpeciesUrl, imageCandidates, iucnStatus,
  regionTables, wikiArticle, wikidataForGbif
} from './auto-sources.mjs';

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDirectory = path.join(repoDirectory, 'docs');
// Local settings may live in an uncommitted .env (see .env.example). Variables already set, as in CI, take precedence.
const envFile = path.join(repoDirectory, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const MAX_CANDIDATE_LOOKUPS = 40;
const MAX_BATCH = 20;
const LENGTHS = { species: { min: 200, max: 3000 }, ancestor: { min: 20, max: 500 } };
// Characters of the reference article the model reads: most of the species article, only the lead of an ancestor's.
const REFERENCE_CHARS = { species: 10000, ancestor: 1500 };
const MAX_DISTRIBUTION_CANDIDATES = 30;
const STATUS_ZH = { EX: '灭绝', EW: '野外灭绝', CR: '极危', EN: '濒危', VU: '易危', NT: '近危', LC: '无危', DD: '数据缺乏', NE: '未评估' };
const RANK_ZH = { kingdom: '界', phylum: '门', class: '纲', order: '目', family: '科', genus: '属', species: '种' };
const countryNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });

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
    entry.article = await wikiArticle(entry.wikidata?.articles, { intro: entry.rank !== 'species' });
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

// What the model is given: names, classification, status and, when there is one, a Wikipedia excerpt to read.
function writingInput({ entries, classification }) {
  const species = entries.at(-1);
  const reference = entry => (entry.article ? referenceText(entry.article.text, REFERENCE_CHARS[entry.rank === 'species' ? 'species' : 'ancestor']) : null);
  const describe = entry => ({
    scientific_name: entry.scientific_name, rank: entry.rank, name_zh: entry.wikidata?.name_zh ?? null, reference: reference(entry)
  });
  return {
    species: {
      ...describe(species),
      authorship: species.authorship || null,
      classification: classification.map(item => ({ rank: item.rank, scientific_name: item.scientific_name, name_zh: item.name_zh })),
      conservation_status: species.status ? `${species.status.code}（${STATUS_ZH[species.status.code]}）` : null
    },
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
    const kind = entry.rank === 'species' ? 'species' : 'ancestor';
    problems.push(...paragraphProblems(item.paragraphs, { kind, ...LENGTHS[kind] }).map(problem => `${entry.scientific_name}：${problem}`));
    const text = (item.paragraphs ?? []).map(paragraph => paragraph?.text ?? '').join('');
    const copied = entry.article ? copiedPassage(text, entry.article.text) : null;
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

function wikiSource(article) {
  return {
    label: '参考资料', title: `${article.lang === 'zh' ? '中文' : '英文'}维基百科「${article.title}」`, url: article.url,
    note: 'CC BY-SA 4.0；仅作参考，文字为重新撰写'
  };
}

function buildEntries({ parentId, entries }, output, distribution) {
  let parent = parentId;
  return entries.map((entry, index) => {
    const isSpecies = entry.rank === 'species';
    const prose = isSpecies ? output.species : output.ancestors[index];
    const nameZh = entry.wikidata?.name_zh ?? prose.name_zh.trim();
    const nameSource = entry.wikidata?.name_zh ? `Wikidata（${entry.wikidata.name_language}）` : 'AI 拟定，需核对';
    const sources = [{ label: '学名与分类', title: 'GBIF Backbone Taxonomy', url: gbifSpeciesUrl(entry.gbif_key), note: 'CC BY 4.0' }];
    if (entry.wikidata?.name_zh) sources.push({ label: '中文名', title: `Wikidata ${entry.wikidata.qid}`, url: entry.wikidata.url, note: 'CC0' });
    if (entry.article) sources.push(wikiSource(entry.article));
    if (isSpecies && entry.status) {
      sources.push({
        label: '保护等级', title: 'IUCN 红色名录',
        url: entry.status.iucnTaxonID ? `https://www.iucnredlist.org/species/${entry.status.iucnTaxonID}` : gbifSpeciesUrl(entry.gbif_key),
        note: '经 GBIF 获取'
      });
    }
    if (isSpecies && distribution.regions.length) {
      sources.push({ label: '分布依据', title: 'GBIF 观察记录', url: gbifSpeciesUrl(entry.gbif_key), note: '区域划分采用 TDWG WGSRPD' });
    }
    if (isSpecies && entry.image) {
      sources.push({ label: '封面图片', title: 'Wikimedia Commons', url: entry.image.page, note: imageSourceNote(entry.image) });
    }
    const markdown = createTaxonMarkdown({
      id: entry.id, parent_id: parent, rank: entry.rank, scientific_name: entry.scientific_name, name_zh: nameZh,
      image_url: isSpecies ? entry.image?.url : '', image_credit: isSpecies ? entry.image?.credit : '',
      source_url: gbifSpeciesUrl(entry.gbif_key),
      ...(isSpecies && entry.status ? { conservation_status: entry.status.code } : {}),
      ...(isSpecies ? { distribution: distribution.regions } : {}),
      description: composeBody(renderParagraphs(prose.paragraphs, { headings: isSpecies }), sources)
    });
    parseTaxon(markdown, `${entry.id}.md`);
    parent = entry.id;
    return { ...entry, name_zh: nameZh, name_source: nameSource, markdown };
  });
}

function speciesReport(built, output, distribution) {
  const species = built.at(-1);
  const rows = built.map(entry =>
    `| \`${entry.id}\` | ${RANK_ZH[entry.rank]} | *${entry.scientific_name}* | ${entry.name_zh} | ${entry.name_source} |`);
  const image = species.image
    ? `${species.image.license}，[原图页面](${linkUrl(species.image.page)})`
    : '无（未找到许可合格的图片）';
  const skipped = species.rejectedImages.map(item => `  - 已跳过 ${item.filename}：${item.reason}`);
  const regionName = id => species.regionCandidates.find(region => region.id === id)?.name ?? id;
  const map = distribution.regions.length
    ? `已填写 ${distribution.regions.map(id => `\`${id}\` ${regionName(id)}`).join('、')}。模型的依据：${distribution.note || '（未说明）'}`
    : `未填写：${distribution.note}`;
  const reference = species.article
    ? `模型阅读了[${species.article.title}](${linkUrl(species.article.url)})（${species.article.lang === 'zh' ? '中文' : '英文'}维基百科）作为参考，并结合自身知识撰写`
    : '没有找到维基百科条目，完全由模型凭自身知识撰写，请格外仔细核对';
  const claims = output.claims_to_verify ?? [];
  return [
    '| 条目 | 级别 | 学名 | 中文名 | 中文名来源 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '### 已自动检查',
    '',
    `- 学名与分类：GBIF Backbone 精确匹配、状态为 ACCEPTED（[GBIF](${gbifSpeciesUrl(species.gbif_key)})）`,
    `- 保护等级：${species.status ? `${species.status.code}（${STATUS_ZH[species.status.code]}），来自 IUCN 红色名录（经 GBIF）` : '无评估，未填写'}`,
    `- 封面图片：${image}`,
    ...skipped,
    `- 介绍：${reference}。**文字中的事实没有逐条核对**；与参考文章没有连续 ${COPY_RUN} 字以上的相同片段，正文中没有模型生成的链接或图片`,
    `- 分布地图：${map}`,
    '',
    '### 需人工核实',
    '',
    ...(claims.length ? claims.map(claim => `- [ ] ${claim}`) : ['- [ ] （模型未列出，请通读全文）']),
    ...(distribution.regions.length ? ['- [ ] 分布地图覆盖的地区与该物种的原生分布一致'] : []),
    '',
    '### 审核清单',
    '',
    '- [ ] 分类位置正确，新增的上级分类确有必要',
    '- [ ] 中文名规范（尤其是标为「AI 拟定」的）',
    '- [ ] 图片确为该物种，作者与许可信息完整',
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
  const models = [...new Set(results.map(result => result.model))].map(model => `\`${model}\``).join('、');
  const sections = species.length === 1
    ? [results[0].report]
    : results.flatMap(result => [`## ${result.species.name_zh}（*${result.species.scientific_name}*）`, '', result.report, '']);
  const failed = failures.length ? ['', '## 未能生成', '', ...failures.map(item => `- ${item.target}：${item.message.split('\n')[0]}`), ''] : [];
  const body = [
    `由 \`scripts/auto-species.mjs\` 自动生成，文字模型：${models}。介绍文字为尽力而为的草稿，合并前请逐项核对。`,
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
        article: entry.article && { url: entry.article.url, characters: entry.article.text.length,
          read_by_model: referenceText(entry.article.text, REFERENCE_CHARS[entry.rank === 'species' ? 'species' : 'ancestor']).length },
        authorship: entry.authorship ?? null
      })),
      conservation_status: species.status?.code ?? null,
      image: species.image, rejected_images: species.rejectedImages,
      distribution_candidates: species.regionCandidates.map(({ id, name, records, countries }) => ({ id, name, records, countries: countries.map(country => country.name) })),
      distribution_problem: species.regionProblem
    } };
  }

  const result = await writeProse(gathered);
  const distribution = species.regionProblem
    ? { regions: [], note: species.regionProblem }
    : selectDistribution(result.output.distribution, species.regionCandidates, REGION_PARENTS);
  const built = buildEntries(gathered, result.output, distribution);
  if (replaced && replaced.id !== species.id) fs.rmSync(path.join(docsDirectory, 'taxa', `${replaced.id}.md`), { force: true });
  for (const entry of built) fs.writeFileSync(path.join(docsDirectory, 'taxa', `${entry.id}.md`), entry.markdown);
  syncIndexes(docsDirectory);
  syncIndexes(docsDirectory, { check: true });
  return {
    species: built.at(-1), files: built.map(entry => `docs/taxa/${entry.id}.md`), model: result.model,
    report: speciesReport(built.map((entry, index) => ({ ...gathered.entries[index], ...entry })), result.output, distribution)
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
