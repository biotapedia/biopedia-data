import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaxonMarkdown, parseTaxon } from '../scripts/catalog.mjs';
import { composeBody, copiedPassage, descriptionProblem, imageCredit, imageLicenseProblem, planLineage, slugify, uniqueId } from '../scripts/auto-rules.mjs';

const tiger = {
  key: 5219416, canonicalName: 'Panthera tigris',
  kingdom: 'Animalia', kingdomKey: 1, phylum: 'Chordata', phylumKey: 44, class: 'Mammalia', classKey: 359,
  order: 'Carnivora', orderKey: 732, family: 'Felidae', familyKey: 9703, genus: 'Panthera', genusKey: 2435194
};

test('a species joins the deepest existing taxon of the same rank and name', () => {
  // A fixed tree, so the test does not change as the real catalog grows.
  const taxa = new Map([
    ['animalia', { id: 'animalia', parent_id: null, rank: 'kingdom', scientific_name: 'Animalia' }],
    ['carnivora', { id: 'carnivora', parent_id: 'animalia', rank: 'order', scientific_name: 'Carnivora' }],
    ['feliformia', { id: 'feliformia', parent_id: 'carnivora', rank: 'suborder', scientific_name: 'Feliformia' }],
    ['felidae', { id: 'felidae', parent_id: 'feliformia', rank: 'family', scientific_name: 'Felidae' }],
    ['panthera', { id: 'panthera', parent_id: 'felidae', rank: 'genus', scientific_name: 'Panthera' }],
    ['panthera-leo', { id: 'panthera-leo', parent_id: 'panthera', rank: 'species', scientific_name: 'Panthera leo' }]
  ]);
  assert.deepEqual(planLineage(taxa, tiger), { parentId: 'panthera', missing: [] });
  const panda = { ...tiger, canonicalName: 'Ailuropoda melanoleuca', family: 'Ursidae', familyKey: 9681, genus: 'Ailuropoda', genusKey: 2433405 };
  const plan = planLineage(taxa, panda);
  assert.equal(plan.parentId, 'carnivora');
  assert.deepEqual(plan.missing.map(entry => entry.scientific_name), ['Ursidae', 'Ailuropoda']);
  assert.throws(() => planLineage(taxa, { ...tiger, canonicalName: 'Panthera leo' }), /already in the catalog/);
});

test('ids are slugs of the scientific name and never collide', () => {
  assert.equal(slugify('Panthera tigris'), 'panthera-tigris');
  assert.equal(slugify('Nymphaea × daubenyana'), 'nymphaea-daubenyana');
  assert.equal(slugify('Linnaéa'), 'linnaea');
  assert.equal(uniqueId('panthera', 'genus', new Set(['panthera'])), 'panthera-genus');
  assert.equal(uniqueId('panthera', 'genus', new Set(['panthera', 'panthera-genus'])), 'panthera-genus-2');
});

test('only freely licensed, attributable Commons images are accepted', () => {
  const ok = { License: 'cc-by-sa-4.0', LicenseShortName: 'CC BY-SA 4.0', Artist: '<a href="//commons.wikimedia.org/wiki/User:A">A &amp; B</a>', Restrictions: '' };
  assert.equal(imageLicenseProblem(ok), null);
  assert.equal(imageLicenseProblem({ ...ok, License: 'cc0' }), null);
  assert.equal(imageLicenseProblem({ ...ok, License: 'pd' }), null);
  assert.equal(imageLicenseProblem({ ...ok, License: 'cc-by-sa-3.0-de' }), null);
  assert.match(imageLicenseProblem({ ...ok, License: 'cc-by-nc-4.0' }), /not allowed/);
  assert.match(imageLicenseProblem({ ...ok, License: 'gfdl' }), /not allowed/);
  assert.match(imageLicenseProblem({ ...ok, License: 'fair use' }), /not allowed/);
  assert.match(imageLicenseProblem({ ...ok, NonFree: 'true' }), /non-free/);
  assert.match(imageLicenseProblem({ ...ok, Restrictions: 'personality' }), /restrictions/);
  assert.match(imageLicenseProblem({ ...ok, Artist: '', Credit: '' }), /author/);
  assert.match(imageCredit(ok, 'https://commons.wikimedia.org/wiki/File:X.jpg'), /^作者：A & B；许可：CC BY-SA 4.0；来源/);
});

test('copied text is detected regardless of punctuation and spacing', () => {
  const reference = '虎（学名：Panthera tigris）俗称老虎，是现存体型最大的猫科动物之一。老虎具有敏锐的听力、夜视力。';
  assert.ok(copiedPassage('据说，俗称老虎 是现存体型最大的猫科动物之一！老虎具有敏锐的听力', reference));
  assert.equal(copiedPassage('俗称老虎，是现存体型最大的猫科动物之一', reference), null);
  assert.equal(copiedPassage('虎是一种大型猫科动物，身上长着醒目的黑色条纹，主要生活在亚洲。', reference), null);
  assert.equal(copiedPassage('任何文字', ''), null);
});

test('generated prose may not carry links, images or structure', () => {
  const limits = { min: 10, max: 100 };
  assert.equal(descriptionProblem('虎是亚洲特有的大型猫科动物，以条纹著称。', limits), null);
  assert.match(descriptionProblem('短', limits), /characters/);
  assert.match(descriptionProblem('详见 https://example.com 的介绍内容。', limits), /links/);
  assert.match(descriptionProblem('图片如下 ![虎](x.jpg) 所示内容。', limits), /links/);
  assert.match(descriptionProblem('## 形态\n虎是大型猫科动物。', limits), /headings/);
  assert.match(descriptionProblem('虎是<b>大型</b>猫科动物。', limits), /HTML/);
});

test('a composed entry passes catalog validation', () => {
  const body = composeBody('虎是亚洲特有的大型猫科动物，身上的黑色条纹便于在草丛中隐蔽。', [
    { label: '学名与分类', title: 'GBIF Backbone Taxonomy', url: 'https://www.gbif.org/species/5219416', note: 'CC BY 4.0' }
  ]);
  const taxon = parseTaxon(createTaxonMarkdown({
    id: 'panthera-tigris', parent_id: 'panthera', rank: 'species', scientific_name: 'Panthera tigris', name_zh: '虎',
    source_url: 'https://www.gbif.org/species/5219416', conservation_status: 'EN', description: body
  }), 'panthera-tigris.md');
  assert.match(taxon.body, /## 资料来源\n\n- 学名与分类：\[GBIF Backbone Taxonomy\]\(https:\/\/www\.gbif\.org\/species\/5219416\)（CC BY 4\.0）/);
  assert.match(taxon.body, /AI .*辅助撰写/);
});
