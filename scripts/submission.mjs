import { CONSERVATION_RANKS, CONSERVATION_STATUSES, createTaxonMarkdown, distributionProblem, isHttpsUrl, loadTaxa, markdownImageUrls, parseTaxon, RANKS } from './catalog.mjs';

const MARKER = /<!-- BIOTA_SUBMISSION_V1\s+([A-Za-z0-9_-]+)\s+-->/;

export function parseIssueBody(body) {
  if (typeof body !== 'string' || body.length > 50000) throw new Error('投稿内容无效或过长');
  const match = body.match(MARKER);
  if (!match) return null;
  try {
    const raw = Buffer.from(match[1], 'base64url').toString('utf8');
    if (raw.length > 20000) throw new Error('投稿资料过长');
    return JSON.parse(raw);
  } catch {
    throw new Error('投稿资料无法解析，请从图鉴网页重新生成投稿');
  }
}

export function prepareSubmission(value, issueNumber, docsDirectory) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('投稿格式错误');
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Issue 编号无效');
  const fields = ['parent_id', 'ancestors', 'rank', 'scientific_name', 'name_zh', 'image_url', 'image_credit', 'source_url', 'distribution', 'conservation_status', 'description'];
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('投稿包含未知字段');
  const parentId = value.parent_id === '' ? null : value.parent_id;
  if (parentId !== null && (typeof parentId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parentId))) {
    throw new Error('父分类 ID 无效');
  }
  const ancestors = value.ancestors ?? [];
  if (!Array.isArray(ancestors) || ancestors.length > 8) throw new Error('一次最多可新增 8 个上级分类');
  const taxa = loadTaxa(docsDirectory);
  if (parentId !== null && !taxa.has(parentId)) throw new Error('所选父分类不存在');
  const entries = [];
  let nextParentId = parentId;
  for (const [index, input] of [...ancestors, value].entries()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('分类资料格式错误');
    const allowed = index < ancestors.length
      ? ['rank', 'scientific_name', 'name_zh', 'description'] : fields;
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('分类资料包含未知字段');
    if (!RANKS.has(input.rank)) throw new Error('分类级别无效');
    for (const key of ['scientific_name', 'name_zh', 'description']) {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} 不能为空`);
    }
    if (input.description.length < 20 || input.description.length > 10000) throw new Error('介绍需为 20–10000 字符');
    if (markdownImageUrls(input.description).some(url => !isHttpsUrl(url))) {
      throw new Error('介绍中的图片链接必须是 HTTPS');
    }
    if (input.scientific_name.length > 160 || input.name_zh.length > 120) throw new Error('名称过长');
    for (const key of ['image_url', 'image_credit', 'source_url']) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 1000)) {
        throw new Error(`${key} 格式无效`);
      }
    }
    if (input.image_url && !isHttpsUrl(input.image_url)) throw new Error('图片链接必须是 HTTPS');
    if (input.source_url && !isHttpsUrl(input.source_url)) throw new Error('资料来源必须是 HTTPS');
    if (input.image_url && !input.image_credit?.trim()) throw new Error('使用图片时请填写作者及授权');
    if (input.distribution !== undefined && distributionProblem(input.distribution)) {
      throw new Error('分布地区无效，请在图鉴网页重新选择');
    }
    if (input.conservation_status !== undefined && input.conservation_status !== '') {
      if (!CONSERVATION_STATUSES.has(input.conservation_status)) throw new Error('濒危等级无效');
      if (!CONSERVATION_RANKS.has(input.rank)) throw new Error('只有物种或亚种可以填写濒危等级');
    }
    const scientificName = input.scientific_name.trim();
    if ([...taxa.values(), ...entries].some(taxon =>
      taxon.parent_id === nextParentId && taxon.scientific_name.toLowerCase() === scientificName.toLowerCase())) {
      throw new Error('同一父分类下已存在该学名');
    }
    const id = index === ancestors.length ? `submission-${issueNumber}` : `submission-${issueNumber}-${index + 1}`;
    if (taxa.has(id)) throw new Error('该 Issue 已生成条目');
    const markdown = createTaxonMarkdown({
      ...input, id, parent_id: nextParentId, scientific_name: scientificName,
      name_zh: input.name_zh.trim(), description: input.description.trim()
    });
    const taxon = parseTaxon(markdown, `${id}.md`);
    entries.push({ ...taxon, markdown });
    nextParentId = id;
  }
  const final = entries.at(-1);
  return { id: final.id, markdown: final.markdown, entries,
    title: `新增分类：${final.name_zh}（${final.scientific_name}）` };
}
