// Adds one species, with any missing ancestor taxa, as a reviewable change.
//
//   node scripts/auto-species.mjs [--name "Panthera tigris"] [--plan] [--pr]
//
// Without --name it picks an assessed, living species from GBIF under the deepest taxa already in the catalog.
// --plan prints the facts it gathered and stops before calling the model. --pr commits to an auto/<id> branch and
// opens a pull request (used by .github/workflows/auto-species.yml); otherwise files are written to docs/ for review.
//
// Facts (names, classification, conservation status, images) come only from open data sources; the model only writes
// prose around them. Text and image licences are checked before anything is written, and nothing reaches main
// without a human review of the pull request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTaxonMarkdown, loadTaxa, parseTaxon, syncIndexes } from './catalog.mjs';
import { composeBody, copiedPassage, COPY_RUN, descriptionProblem, LINEAGE_RANKS, planLineage, slugify, uniqueId } from './auto-rules.mjs';
import { freeImage, gbifMatch, gbifRecord, gbifSpeciesUnder, gbifSpeciesUrl, iucnStatus, wikidataForGbif, zhwikiText } from './auto-sources.mjs';

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDirectory = path.join(repoDirectory, 'docs');
// Local settings may live in an uncommitted .env (see .env.example). Variables already set, as in CI, take precedence.
const envFile = path.join(repoDirectory, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
// Any OpenAI-compatible Chat Completions API, such as DeepSeek, Qwen (DashScope), Kimi, GLM or Doubao.
const LLM_SETTINGS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
const MAX_CANDIDATE_LOOKUPS = 40;
const LENGTHS = { species: { min: 100, max: 1500 }, ancestor: { min: 20, max: 600 } };
const STATUS_ZH = { EX: '灭绝', EW: '野外灭绝', CR: '极危', EN: '濒危', VU: '易危', NT: '近危', LC: '无危', DD: '数据缺乏', NE: '未评估' };
const RANK_ZH = { kingdom: '界', phylum: '门', class: '纲', order: '目', family: '科', genus: '属', species: '种' };

const SYSTEM_PROMPT = `你是「万物图鉴」的科普编辑，根据给定的结构化资料，用简体中文为分类条目撰写原创介绍。

规则：
1. 资料中的学名、分类、中文名和保护等级来自 GBIF、Wikidata 和 IUCN，是权威数据。正文必须与之一致，不要另作判断。
2. 只写学界公认、能在权威资料中核实的内容。不确定的细节宁可不写；不要编造数字、年份、人名、地名或文献。
3. 全部用自己的话原创表述，不要复述、改写或拼接百度百科、维基百科等任何现有文本。
4. 只写正文段落：不要标题、列表、引用、链接、网址、图片或 HTML。资料来源由系统另行添加。
5. 物种介绍 150–500 字，分 2–3 段，可以涉及形态特征、分布与栖息地、习性、与人类的关系或保护现状。每个上级分类的介绍 40–150 字，一段即可，概括该类群的共同特征。
6. name_zh：资料中已给出中文名时原样返回；为 null 时给出中国大陆通用的规范中文名，没有把握就返回空字符串。
7. claims_to_verify：逐条列出物种介绍中审核人需要核实的具体事实（如分布范围、体型、食性、种群数量），每条一句话。

只输出一个 JSON 对象，不要输出其他任何内容，段落之间用 \\n\\n 分隔：
{"species": {"name_zh": "…", "description": "…"}, "ancestors": [{"scientific_name": "…", "name_zh": "…", "description": "…"}], "claims_to_verify": ["…"]}`;

// Not every provider can enforce a JSON schema, so the shape is checked here.
function shapeProblem(output) {
  const isText = value => typeof value === 'string';
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '输出必须是一个 JSON 对象';
  if (!output.species || !isText(output.species.name_zh) || !isText(output.species.description)) {
    return 'species 必须包含字符串字段 name_zh 和 description';
  }
  if (!Array.isArray(output.ancestors)
    || output.ancestors.some(item => !item || !isText(item.scientific_name) || !isText(item.name_zh) || !isText(item.description))) {
    return 'ancestors 必须是数组，每一项包含字符串字段 scientific_name、name_zh 和 description';
  }
  if (!Array.isArray(output.claims_to_verify) || !output.claims_to_verify.every(isText)) return 'claims_to_verify 必须是字符串数组';
  return null;
}

function run(program, args) {
  return execFileSync(program, args, {
    cwd: repoDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env
  }).trim();
}

// Species already proposed by this script, merged or not, so a rejected proposal is not offered again.
function proposedIds() {
  const pulls = JSON.parse(run('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'headRefName']));
  return new Set(pulls.map(pull => pull.headRefName).filter(name => name.startsWith('auto/')).map(name => name.slice(5)));
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
      if (status && status.code !== 'NE') return gbifRecord(species.key);
    }
  }
  throw new Error('No candidate found; pass --name');
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
    entry.reference = await zhwikiText(entry.wikidata?.zhwiki);
  }
  const species = entries.at(-1);
  species.authorship = (record.authorship || '').trim();
  species.status = await iucnStatus(record.key);
  ({ image: species.image, rejected: species.rejectedImages } = await freeImage(species.wikidata?.images ?? []));
  // Chinese names for the whole lineage give the model context; existing taxa use the catalog's own names.
  const classification = LINEAGE_RANKS.filter(rank => record[rank]).map(rank => {
    const existing = [...taxa.values()].find(taxon => taxon.rank === rank && taxon.scientific_name.toLowerCase() === record[rank].toLowerCase());
    const created = entries.find(entry => entry.rank === rank);
    return { rank, scientific_name: record[rank], name_zh: existing?.name_zh ?? created?.wikidata?.name_zh ?? null };
  });
  return { parentId: plan.parentId, entries, classification };
}

function modelInput({ entries, classification }) {
  const species = entries.at(-1);
  return {
    species: {
      scientific_name: species.scientific_name,
      authorship: species.authorship,
      name_zh: species.wikidata?.name_zh ?? null,
      conservation_status: species.status ? `${species.status.code}（${STATUS_ZH[species.status.code]}）` : null,
      classification
    },
    ancestors: entries.slice(0, -1).map(entry => ({
      rank: entry.rank, scientific_name: entry.scientific_name, name_zh: entry.wikidata?.name_zh ?? null
    }))
  };
}

async function writeProse(input, feedback) {
  const content = `请为以下条目撰写介绍。ancestors 按从上到下的顺序给出，返回时保持相同顺序和学名。\n\n${JSON.stringify(input, null, 2)}`
    + (feedback ? `\n\n上一次的输出没有通过检查，请按要求重写：\n${feedback}` : '');
  const request = {
    model: process.env.LLM_MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
    // JSON mode is widely supported; set LLM_JSON_MODE=off for models that reject it, such as some reasoning models.
    ...(process.env.LLM_JSON_MODE === 'off' ? {} : { response_format: { type: 'json_object' } })
  };
  const seconds = Number(process.env.LLM_TIMEOUT) || 300;
  for (let attempt = 0; ; attempt++) {
    console.warn(`Waiting for ${process.env.LLM_MODEL} to write the descriptions (up to ${seconds}s)…`);
    let data;
    try {
      // The timeout covers reading the body too: queued providers send headers at once and the answer much later.
      const response = await fetch(`${process.env.LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(seconds * 1000)
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        console.warn(`LLM API answered HTTP ${response.status}, retrying…`);
        await new Promise(resolve => setTimeout(resolve, 5000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`LLM API: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
      data = await response.json();
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw new Error(`${process.env.LLM_MODEL} did not answer within ${seconds}s. Free models are often queued and `
        + 'reasoning models think before answering: try another model, or raise LLM_TIMEOUT (seconds).');
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('The model ran out of output tokens');
    if (choice?.finish_reason === 'content_filter') throw new Error('The provider filtered the response');
    const text = (choice?.message?.content ?? '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let output = null;
    try { output = JSON.parse(text); } catch {}
    return { output, model: data.model || process.env.LLM_MODEL };
  }
}

// Returns every reason the generated prose cannot be used, so a retry can address them all at once.
function proseProblems(output, entries) {
  const shape = shapeProblem(output);
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
    const problem = descriptionProblem(item.description, LENGTHS[entry.rank === 'species' ? 'species' : 'ancestor']);
    if (problem) problems.push(`${entry.scientific_name} 的介绍 ${problem}`);
    const copied = copiedPassage(item.description ?? '', entry.reference);
    if (copied) problems.push(`${entry.scientific_name} 的介绍与中文维基百科有连续 ${COPY_RUN} 字以上相同：「${copied}」，请换用完全不同的表述`);
    if (!entry.wikidata?.name_zh && !item.name_zh?.trim()) problems.push(`没有 ${entry.scientific_name} 的中文名`);
  }
  return problems;
}

function buildEntries({ parentId, entries }, output) {
  let parent = parentId;
  return entries.map((entry, index) => {
    const isSpecies = entry.rank === 'species';
    const prose = isSpecies ? output.species : output.ancestors[index];
    const nameZh = entry.wikidata?.name_zh ?? prose.name_zh.trim();
    const nameSource = entry.wikidata?.name_zh ? `Wikidata（${entry.wikidata.name_language}）` : 'AI 拟定，需核对';
    const sources = [{ label: '学名与分类', title: 'GBIF Backbone Taxonomy', url: gbifSpeciesUrl(entry.gbif_key), note: 'CC BY 4.0' }];
    if (entry.wikidata?.name_zh) sources.push({ label: '中文名', title: `Wikidata ${entry.wikidata.qid}`, url: entry.wikidata.url, note: 'CC0' });
    if (isSpecies && entry.status) {
      sources.push({
        label: '保护等级', title: 'IUCN 红色名录',
        url: entry.status.iucnTaxonID ? `https://www.iucnredlist.org/species/${entry.status.iucnTaxonID}` : gbifSpeciesUrl(entry.gbif_key),
        note: '经 GBIF 获取'
      });
    }
    if (isSpecies && entry.image) sources.push({ label: '封面图片', title: 'Wikimedia Commons', url: entry.image.page, note: entry.image.license });
    const markdown = createTaxonMarkdown({
      id: entry.id, parent_id: parent, rank: entry.rank, scientific_name: entry.scientific_name, name_zh: nameZh,
      image_url: isSpecies ? entry.image?.url : '', image_credit: isSpecies ? entry.image?.credit : '',
      source_url: gbifSpeciesUrl(entry.gbif_key),
      ...(isSpecies && entry.status ? { conservation_status: entry.status.code } : {}),
      description: composeBody(prose.description, sources)
    });
    parseTaxon(markdown, `${entry.id}.md`);
    parent = entry.id;
    return { ...entry, name_zh: nameZh, name_source: nameSource, markdown };
  });
}

function pullRequestBody(built, claims, model) {
  const species = built.at(-1);
  const rows = built.map(entry =>
    `| \`${entry.id}\` | ${RANK_ZH[entry.rank]} | *${entry.scientific_name}* | ${entry.name_zh} | ${entry.name_source} |`);
  const image = species.image
    ? `${species.image.license}，[原图页面](${species.image.page})`
    : '无（未找到许可合格的图片）';
  const skipped = species.rejectedImages.map(item => `  - 已跳过 ${item.filename}：${item.reason}`);
  return [
    `由 \`scripts/auto-species.mjs\` 自动生成，文字模型：\`${model}\`。合并前请逐项核对。`,
    '',
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
    `- 文字：模型只收到上表中的结构化事实，没有收到任何现有百科文本；与中文维基百科对应条目没有连续 ${COPY_RUN} 字以上的相同片段`,
    '- 正文中没有模型生成的链接或图片；「资料来源」和 AI 辅助撰写说明由脚本添加',
    '',
    '### 需人工核实的事实',
    '',
    ...(claims.length ? claims.map(claim => `- [ ] ${claim}`) : ['- [ ] （模型未列出，请通读全文）']),
    '',
    '### 审核清单',
    '',
    '- [ ] 分类位置正确，新增的上级分类确有必要',
    '- [ ] 中文名规范（尤其是标为「AI 拟定」的）',
    '- [ ] 图片确为该物种，作者与许可信息完整',
    '- [ ] 文字准确、通顺，没有照搬其他来源'
  ].join('\n');
}

function openPullRequest(built, body) {
  const species = built.at(-1);
  const branch = `auto/${species.id}`;
  if (run('git', ['ls-remote', '--heads', 'origin', branch])) throw new Error(`Branch ${branch} already exists`);
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['switch', '-c', branch]);
  run('git', ['add', 'docs/taxa', 'docs/roots.json', 'docs/children']);
  run('git', ['commit', '-m', `Add ${species.scientific_name} (automated)`]);
  run('git', ['push', '--set-upstream', 'origin', branch]);
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-species-')), 'body.md');
  fs.writeFileSync(bodyFile, body);
  return run('gh', ['pr', 'create', '--base', 'main', '--head', branch,
    '--title', `自动新增：${species.name_zh}（${species.scientific_name}）`, '--body-file', bodyFile]);
}

async function main() {
  const { values } = parseArgs({ options: { name: { type: 'string' }, plan: { type: 'boolean' }, pr: { type: 'boolean' } } });
  const name = (values.name ?? process.env.SPECIES_NAME ?? '').trim();
  const unset = LLM_SETTINGS.filter(key => !process.env[key]);
  if (!values.plan && unset.length) throw new Error(`Set ${unset.join(', ')} to call the language model, or use --plan`);
  const taxa = loadTaxa(docsDirectory);
  const proposed = values.pr ? proposedIds() : new Set();

  let record;
  if (name) {
    const match = await gbifMatch(name);
    if (match.problem) throw new Error(match.problem);
    record = match.record;
    if (proposed.has(slugify(record.canonicalName))) {
      console.log(`${record.canonicalName} was already proposed in an auto/ pull request.`);
      return;
    }
  } else {
    record = await pickCandidate(taxa, proposed);
  }
  console.warn(`Gathering facts for ${record.canonicalName} from GBIF, Wikidata and Wikimedia Commons…`);
  const gathered = await gather(taxa, record);
  const input = modelInput(gathered);

  if (values.plan) {
    const species = gathered.entries.at(-1);
    console.log(JSON.stringify({
      parent_id: gathered.parentId,
      entries: gathered.entries.map(entry => ({
        id: entry.id, rank: entry.rank, scientific_name: entry.scientific_name, gbif: gbifSpeciesUrl(entry.gbif_key),
        name_zh: entry.wikidata?.name_zh ?? null, wikidata: entry.wikidata?.url ?? null, zhwiki_characters: entry.reference.length
      })),
      conservation_status: species.status?.code ?? null,
      image: species.image, rejected_images: species.rejectedImages,
      model_input: input
    }, null, 2));
    return;
  }

  let result;
  let feedback = '';
  for (let attempt = 1; ; attempt++) {
    result = await writeProse(input, feedback);
    const problems = proseProblems(result.output, gathered.entries);
    if (!problems.length) break;
    if (attempt === 3) throw new Error(`Generated text failed checks:\n${problems.join('\n')}`);
    feedback = problems.map(problem => `- ${problem}`).join('\n');
    console.warn(`Attempt ${attempt} failed checks, retrying:\n${feedback}`);
  }

  const built = buildEntries(gathered, result.output);
  for (const entry of built) fs.writeFileSync(path.join(docsDirectory, 'taxa', `${entry.id}.md`), entry.markdown);
  syncIndexes(docsDirectory);
  syncIndexes(docsDirectory, { check: true });
  const body = pullRequestBody(built, result.output.claims_to_verify, result.model);

  if (values.pr) {
    console.log(openPullRequest(built, body));
  } else {
    console.log(`Wrote ${built.map(entry => `docs/taxa/${entry.id}.md`).join(', ')} and updated the indexes.\n`);
    console.log(body);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
