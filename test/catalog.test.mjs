import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaxonMarkdown, expectedIndexes, loadTaxa, parseTaxon, syncIndexes, validateTree } from '../scripts/catalog.mjs';
import { parseIssueBody, prepareSubmission } from '../scripts/submission.mjs';

const docs = path.resolve('docs');

test('catalog supports optional intermediate ranks and subspecies', () => {
  const taxa = loadTaxa(docs);
  assert.equal(taxa.get('feliformia').rank, 'suborder');
  assert.equal(taxa.get('panthera-leo-leo').rank, 'subspecies');
  assert.equal(expectedIndexes(taxa).get('children/panthera-leo/1.json').includes('panthera-leo-leo'), true);
});

test('large sibling groups are split into small pages', () => {
  const taxa = new Map([['root', {
    id: 'root', parent_id: null, rank: 'kingdom', scientific_name: 'Rootus', name_zh: '根'
  }]]);
  for (let index = 0; index < 49; index++) {
    const id = `child-${index}`;
    taxa.set(id, {
      id, parent_id: 'root', rank: 'species',
      scientific_name: `Species ${index}`, name_zh: `物种 ${index}`
    });
  }
  const indexes = expectedIndexes(taxa);
  assert.equal(JSON.parse(indexes.get('children/root/1.json')).items.length, 48);
  assert.equal(JSON.parse(indexes.get('children/root/1.json')).next, 2);
  assert.equal(JSON.parse(indexes.get('children/root/2.json')).items.length, 1);
});

test('validation rejects a taxonomy cycle', () => {
  const taxa = new Map([
    ['a', { id: 'a', parent_id: 'b' }],
    ['b', { id: 'b', parent_id: 'a' }]
  ]);
  assert.throws(() => validateTree(taxa), /cycle/);
});

test('generated indexes are current', () => {
  assert.doesNotThrow(() => syncIndexes(docs, { check: true }));
});

test('issue payload becomes a validated Markdown taxon', () => {
  const payload = {
    parent_id: 'panthera',
    rank: 'species',
    scientific_name: 'Panthera testus',
    name_zh: '测试豹',
    image_url: '',
    image_credit: '',
    source_url: '',
    description: '这是一段用于验证投稿转换流程的介绍，长度足以满足条目要求。'
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const parsed = parseIssueBody(`投稿\n<!-- BIOTA_SUBMISSION_V1\n${encoded}\n-->`);
  const result = prepareSubmission(parsed, 173, docs);
  assert.equal(parseTaxon(result.markdown).id, 'submission-173');
  assert.match(result.markdown, /parent_id: "panthera"/);
  assert.throws(() => prepareSubmission({
    ...payload, image_url: 'http://example.org/photo.jpg', image_credit: '摄影者'
  }, 174, docs), /HTTPS/);
});

test('Markdown formatting survives submission and inline images require HTTPS', () => {
  const payload = {
    parent_id: 'panthera', rank: 'species', scientific_name: 'Panthera markdownus',
    name_zh: '测试图文豹', image_url: '', image_credit: '', source_url: '',
    description: '## 形态\n\n**粗体**与*斜体*。\n\n![菌盖](https://example.org/cap.jpg)\n\n*图片作者及授权：示例作者，CC BY 4.0*'
  };
  const result = prepareSubmission(payload, 175, docs);
  assert.equal(parseTaxon(result.markdown).body, payload.description);
  assert.throws(() => prepareSubmission({
    ...payload, description: payload.description.replace('https://example.org/cap.jpg', 'http://example.org/cap.jpg')
  }, 176, docs), /HTTPS/);
});

test('one issue creates missing ancestors and the requested species together', () => {
  const result = prepareSubmission({
    parent_id: 'fungi',
    ancestors: [{ rank: 'genus', name_zh: '鹅膏属', scientific_name: 'Amanita',
      description: '鹅膏属是真菌界中的一个属，包含多种具有明显菌盖与菌柄的种类。' }],
    rank: 'species', name_zh: '毒鹅膏', scientific_name: 'Amanita phalloides',
    description: '毒鹅膏是一种有毒真菌，辨识与传播时应参考可靠的分类资料。',
    image_url: '', image_credit: '', source_url: ''
  }, 201, docs);
  assert.deepEqual(result.entries.map(entry => entry.id), ['submission-201-1', 'submission-201']);
  assert.equal(result.entries[0].parent_id, 'fungi');
  assert.equal(result.entries[1].parent_id, 'submission-201-1');
  assert.throws(() => prepareSubmission({
    parent_id: 'fungi',
    ancestors: [{ rank: 'genus', name_zh: '鹅膏属', scientific_name: 'Amanita', description: '短' }],
    rank: 'species', name_zh: '毒鹅膏', scientific_name: 'Amanita phalloides',
    description: '毒鹅膏是一种有毒真菌，辨识与传播时应参考可靠的分类资料。'
  }, 202, docs), /20–10000/);
});

test('index checker detects stale child pages', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biota-index-'));
  try {
    fs.mkdirSync(path.join(temp, 'taxa'));
    fs.writeFileSync(path.join(temp, 'taxa', 'root.md'), createTaxonMarkdown({
      id: 'root', parent_id: null, rank: 'kingdom', scientific_name: 'Rootus',
      name_zh: '根节点', description: '这是一个用于验证索引更新的根节点示例。'
    }));
    syncIndexes(temp);
    fs.writeFileSync(path.join(temp, 'roots.json'), '{}');
    assert.throws(() => syncIndexes(temp, { check: true }), /stale/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('distribution accepts regions at any level but not a region inside a listed one', () => {
  const markdown = distribution => createTaxonMarkdown({
    id: 'sample', parent_id: null, rank: 'species', scientific_name: 'Samplus', name_zh: '样本',
    distribution, description: '这是一个用于验证分布地区字段的示例条目。'
  });
  assert.deepEqual(parseTaxon(markdown(['tdwg-2', 'tdwg-36', 'fao-61'])).distribution, ['tdwg-2', 'tdwg-36', 'fao-61']);
  assert.doesNotMatch(markdown([]), /distribution/);
  assert.throws(() => parseTaxon(markdown(['tdwg-99'])), /unknown region/);
  assert.throws(() => parseTaxon(markdown(['ocean-pacific', 'fao-61'])), /inside ocean-pacific/);
  assert.throws(() => parseTaxon(markdown(['fao-61', 'fao-61'])), /repeated/);
});

test('submitted distribution is validated and written to the taxon', () => {
  const payload = {
    parent_id: 'panthera', rank: 'species', scientific_name: 'Panthera rangeus', name_zh: '测试分布豹',
    image_url: '', image_credit: '', source_url: '', distribution: ['tdwg-41', 'tdwg-36'],
    description: '这是一段用于验证投稿分布地区转换流程的介绍，长度足以满足条目要求。'
  };
  assert.match(prepareSubmission(payload, 301, docs).markdown, /distribution: \["tdwg-41","tdwg-36"\]/);
  assert.doesNotMatch(prepareSubmission({ ...payload, distribution: [] }, 302, docs).markdown, /distribution/);
  assert.throws(() => prepareSubmission({ ...payload, distribution: ['china'] }, 303, docs), /分布地区/);
  assert.throws(() => prepareSubmission({ ...payload, distribution: 'tdwg-36' }, 304, docs), /分布地区/);
});

test('conservation status is limited to IUCN codes on species and subspecies', () => {
  const markdown = (rank, conservation_status) => createTaxonMarkdown({
    id: 'sample', parent_id: null, rank, scientific_name: 'Samplus', name_zh: '样本',
    conservation_status, description: '这是一个用于验证濒危等级字段的示例条目。'
  });
  assert.equal(parseTaxon(markdown('species', 'EN')).conservation_status, 'EN');
  assert.equal(parseTaxon(markdown('subspecies', 'CR')).conservation_status, 'CR');
  assert.doesNotMatch(markdown('species', ''), /conservation_status/);
  assert.throws(() => parseTaxon(markdown('species', 'XX')), /invalid conservation_status/);
  assert.throws(() => parseTaxon(markdown('genus', 'EN')), /only for species/);
});

test('submitted conservation status is validated and written to the taxon', () => {
  const payload = {
    parent_id: 'panthera', rank: 'species', scientific_name: 'Panthera statusus', name_zh: '测试等级豹',
    image_url: '', image_credit: '', source_url: '', conservation_status: 'VU',
    description: '这是一段用于验证投稿濒危等级转换流程的介绍，长度足以满足条目要求。'
  };
  assert.match(prepareSubmission(payload, 401, docs).markdown, /conservation_status: "VU"/);
  assert.doesNotMatch(prepareSubmission({ ...payload, conservation_status: '' }, 402, docs).markdown, /conservation_status/);
  assert.throws(() => prepareSubmission({ ...payload, conservation_status: 'vu' }, 403, docs), /濒危等级/);
  assert.throws(() => prepareSubmission({ ...payload, rank: 'genus' }, 404, docs), /只有物种或亚种/);
});
