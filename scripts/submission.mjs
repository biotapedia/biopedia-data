import { createTaxonMarkdown, isHttpsUrl, loadTaxa, parseTaxon, RANKS } from './catalog.mjs';

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
  const fields = ['parent_id', 'rank', 'scientific_name', 'name_zh', 'image_url', 'image_credit', 'source_url', 'description'];
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('投稿包含未知字段');
  const parentId = value.parent_id === '' ? null : value.parent_id;
  if (parentId !== null && (typeof parentId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parentId))) {
    throw new Error('父分类 ID 无效');
  }
  if (!RANKS.has(value.rank)) throw new Error('分类级别无效');
  for (const key of ['scientific_name', 'name_zh', 'description']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`${key} 不能为空`);
  }
  if (value.description.length < 20 || value.description.length > 10000) throw new Error('介绍需为 20–10000 字符');
  if (value.scientific_name.length > 160 || value.name_zh.length > 120) throw new Error('名称过长');
  for (const key of ['image_url', 'image_credit', 'source_url']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 1000)) {
      throw new Error(`${key} 格式无效`);
    }
  }
  if (value.image_url && !isHttpsUrl(value.image_url)) throw new Error('图片链接必须是 HTTPS');
  if (value.source_url && !isHttpsUrl(value.source_url)) throw new Error('资料来源必须是 HTTPS');
  if (value.image_url && !value.image_credit?.trim()) throw new Error('使用图片时请填写作者及授权');
  const taxa = loadTaxa(docsDirectory);
  if (parentId !== null && !taxa.has(parentId)) throw new Error('所选父分类不存在');
  for (const taxon of taxa.values()) {
    if (taxon.parent_id === parentId && taxon.scientific_name.toLowerCase() === value.scientific_name.trim().toLowerCase()) {
      throw new Error('同一父分类下已存在该学名');
    }
  }
  const id = `submission-${issueNumber}`;
  if (taxa.has(id)) throw new Error('该 Issue 已生成条目');
  const markdown = createTaxonMarkdown({
    ...value,
    id,
    parent_id: parentId,
    scientific_name: value.scientific_name.trim(),
    name_zh: value.name_zh.trim(),
    description: value.description.trim()
  });
  parseTaxon(markdown, `${id}.md`);
  return { id, markdown, title: `新增分类：${value.name_zh.trim()}（${value.scientific_name.trim()}）` };
}
