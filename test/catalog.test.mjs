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
