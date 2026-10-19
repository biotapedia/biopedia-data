import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaxonMarkdown, parseTaxon } from '../scripts/catalog.mjs';
import {
  applyCorrections, chosenCandidates, collapseRegions, composeBody, copiedPassage, descriptionProblem, imageAttribution, imageCredit, imageLicenseProblem, imageSourceNote,
  paragraphProblems, parseSpeciesList, planLineage, proposedFromPulls, referenceText, regionCandidates, renderParagraphs, selectDistribution, sourceBackedToxicity, slugify, uniqueId
} from '../scripts/auto-rules.mjs';
import { REGION_PARENTS } from '../scripts/catalog.mjs';
import { askShapeProblem, pickShapeProblem } from '../scripts/auto-llm.mjs';

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
  // A species filed under a newer name than GBIF's is recognised by its GBIF record.
  taxa.set('otocolobus-manul', {
    id: 'otocolobus-manul', parent_id: 'felidae', rank: 'species', scientific_name: 'Otocolobus manul', source_url: 'https://www.gbif.org/species/2435023'
  });
  assert.throws(() => planLineage(taxa, { ...tiger, key: 2435023, canonicalName: 'Felis manul', genus: 'Felis' }), /as Otocolobus manul/);
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
});

test('the cover caption is short and the license link goes to the sources list', () => {
  const meta = {
    License: 'cc-by-sa-4.0', LicenseShortName: 'CC BY-SA 4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
    Artist: '<a href="//commons.wikimedia.org/wiki/User:A">A &amp; B [x]</a>'
  };
  const attribution = imageAttribution(meta);
  assert.equal(imageCredit(attribution), '作者：A & B x · 许可：CC BY-SA 4.0 · 来源：Wikimedia Commons');
  assert.equal(imageSourceNote(attribution), '作者 A & B x，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0)');
  assert.equal(imageSourceNote(imageAttribution({ ...meta, LicenseUrl: 'https://evil.example/license' })), '作者 A & B x，CC BY-SA 4.0');
});

test('copied text is detected regardless of punctuation and spacing', () => {
  const reference = '虎（学名：Panthera tigris）俗称老虎，是现存体型最大的猫科动物之一。老虎具有敏锐的听力、夜视力。';
  assert.ok(copiedPassage('据说，俗称老虎 是现存体型最大的猫科动物之一！老虎具有敏锐的听力', reference));
  assert.equal(copiedPassage('俗称老虎，是现存体型最大的猫科动物之一', reference), null);
  assert.equal(copiedPassage('虎是一种大型猫科动物，身上长着醒目的黑色条纹，主要生活在亚洲。', reference), null);
  assert.equal(copiedPassage('任何文字', ''), null);
  assert.equal(copiedPassage('大熊猫学名Ailuropoda melanoleuca', '大熊猫（学名：Ailuropoda melanoleuca）是熊科动物。'), null);
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

test('parentheses in a source URL cannot end the Markdown link', () => {
  const body = composeBody('虎是亚洲特有的大型猫科动物。', [
    { label: '封面图片', title: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/wiki/File:Tiger_(Panthera).jpg', note: '作者 A' }
  ]);
  assert.match(body, /\]\(https:\/\/commons\.wikimedia\.org\/wiki\/File:Tiger_%28Panthera%29\.jpg\)/);
});

const article = `虎是猫科动物。

== 形态 ==
成年雄虎体重可达 300 公斤，体长约 2.8 米。

== 生态 ==
虎主要捕食鹿类和野猪等大型有蹄类动物。

== 参见 ==
狮

== 参考文献 ==
某某文献`;

test('reference text drops boilerplate sections and is cut at a paragraph', () => {
  const text = referenceText(article, 10000);
  assert.match(text, /体重可达 300 公斤/);
  assert.doesNotMatch(text, /参见|某某文献/);
  const cut = referenceText(article, 50);
  assert.ok(cut.length <= 50 && cut.endsWith('。') && !cut.includes('捕食'));
});

const limits = { kind: 'species', min: 10, max: 200 };
const paragraph = (heading, text) => ({ heading, text });

test('paragraphs need headings (species), text, no links or markup, and a sensible length', () => {
  const good = [paragraph('形态特征', '成年雄虎体型庞大，身上有醒目的黑色条纹。'), paragraph('食性', '虎以大中型有蹄类动物为食。')];
  assert.deepEqual(paragraphProblems(good, limits), []);
  assert.deepEqual(paragraphProblems([paragraph('', '虎是猫科动物。')], { kind: 'ancestor', min: 5, max: 50 }), []);
  assert.match(paragraphProblems([paragraph('', '虎是大型猫科动物，身上有条纹。')], limits).join(''), /小标题/);
  assert.match(paragraphProblems([paragraph('形态#', '虎是大型猫科动物，身上有条纹。')], limits).join(''), /小标题/);
  assert.match(paragraphProblems([paragraph('形态', '')], limits).join(''), /没有正文/);
  assert.match(paragraphProblems(good, { ...limits, min: 500 }).join(''), /characters/);
  assert.match(paragraphProblems([paragraph('形态', '详见 https://example.com 的内容。')], limits).join(''), /links/);
  assert.match(paragraphProblems([paragraph('形态', '虎是<b>大型</b>猫科动物。')], limits).join(''), /HTML/);
  assert.deepEqual(paragraphProblems([], limits), ['没有段落']);
});

test('fact-check corrections replace exact passages, tidy deletions and skip what they cannot apply', () => {
  const paragraphs = [paragraph('形态特征', '虎体长可达 3.9 米，是现存最大的猫科动物。毛色橙黄。'), paragraph('繁殖', '寿命约二十年。')];
  const fix = (original, replacement) => ({ scientific_name: 'Panthera tigris', original, replacement, reason: '无依据' });
  const result = applyCorrections(paragraphs, [
    fix('可达 3.9 米', '较大'), fix('是现存最大的猫科动物。', ''), fix('寿命约二十年。', ''), fix('不存在的句子', ''), fix('毛色橙黄', '详见 https://x')
  ], text => (/https?:/.test(text) ? '有链接' : null));
  assert.deepEqual(result.paragraphs, [paragraph('形态特征', '虎体长较大。毛色橙黄。')]);
  assert.equal(result.applied.length, 3);
  assert.deepEqual(result.skipped.map(item => item.why), ['原文中找不到这段文字', '有链接']);
  assert.equal(paragraphs[1].text, '寿命约二十年。');
  assert.match(applyCorrections([paragraph('', '虎。虎。')], [fix('虎。', '')]).skipped[0].why, /不止一次/);
});

test('paragraphs are rendered with sub-headings only for species', () => {
  const paragraphs = [paragraph('形态特征', '第一段。'), paragraph('食性', '第二段。')];
  assert.equal(renderParagraphs(paragraphs, { headings: true }), '## 形态特征\n\n第一段。\n\n## 食性\n\n第二段。');
  assert.equal(renderParagraphs(paragraphs, { headings: false }), '第一段。\n\n第二段。');
});

test('regions are candidates only when observation records fall in them', () => {
  const isoToRegions = new Map([['IN', new Set(['tdwg-40', 'tdwg-41'])], ['RU', new Set(['tdwg-30', 'tdwg-31'])], ['CN', new Set(['tdwg-36'])]]);
  const names = new Map([['tdwg-40', 'Indian Subcontinent']]);
  const candidates = regionCandidates(new Map([['IN', 100], ['RU', 20], ['XX', 5]]), isoToRegions, names, iso => iso);
  assert.deepEqual(candidates.map(region => [region.id, region.records]), [['tdwg-40', 100], ['tdwg-41', 100], ['tdwg-30', 20], ['tdwg-31', 20]]);
  assert.equal(candidates[0].name, 'Indian Subcontinent');
  assert.equal(candidates[1].name, 'tdwg-41');
});

test('native regions are kept individually and uncertain maps show labeled observation records', () => {
  const candidates = [{ id: 'tdwg-40' }, { id: 'tdwg-41' }, { id: 'tdwg-31' }];
  const sure = regions => ({ confidence: 'high', regions, reason: '依据事实 5' });
  assert.deepEqual(selectDistribution(sure(['tdwg-40', 'tdwg-31']), candidates, REGION_PARENTS), { regions: ['tdwg-40', 'tdwg-31'], basis: 'native', note: '依据事实 5' });
  assert.deepEqual(selectDistribution(sure(['tdwg-40', 'tdwg-40']), candidates, REGION_PARENTS).regions, ['tdwg-40']);
  assert.deepEqual(selectDistribution(sure(['tdwg-40', 'tdwg-25']), candidates, REGION_PARENTS).regions, ['tdwg-40']);
  assert.match(selectDistribution(sure(['tdwg-40', 'tdwg-25']), candidates, REGION_PARENTS).note, /已排除.*tdwg-25/);
  const uncertain = selectDistribution({ confidence: 'low', regions: ['tdwg-40'] }, candidates, REGION_PARENTS);
  assert.equal(uncertain.basis, 'records');
  assert.deepEqual(uncertain.regions, ['tdwg-40', 'tdwg-41', 'tdwg-31']);
  assert.equal(selectDistribution(undefined, candidates, REGION_PARENTS).basis, 'records');
  assert.equal(selectDistribution(sure([]), candidates, REGION_PARENTS).basis, 'records');
  assert.equal(selectDistribution(sure(['tdwg-25']), candidates, REGION_PARENTS).basis, 'records');
  assert.deepEqual(selectDistribution(sure(['tdwg-40']), [], REGION_PARENTS), { regions: [], basis: null, note: 'GBIF 没有可用的陆地观察记录' });
});

test('all children of a level-1 region are replaced by it, as in the contribution form', () => {
  assert.deepEqual(collapseRegions(['tdwg-40', 'tdwg-41', 'tdwg-42', 'tdwg-43'], REGION_PARENTS), ['tdwg-4']);
  assert.deepEqual(collapseRegions(['tdwg-40', 'tdwg-41'], REGION_PARENTS), ['tdwg-40', 'tdwg-41']);
  assert.equal(parseTaxon(createTaxonMarkdown({
    id: 'a-b', parent_id: null, rank: 'species', scientific_name: 'A b', name_zh: '甲', distribution: ['tdwg-4'], description: '这是一段足够长的介绍内容。'
  }), 'a-b.md').distribution[0], 'tdwg-4');
});

test('distribution basis is stored only with a map and accepts known meanings', () => {
  const input = { id: 'a-b', parent_id: null, rank: 'species', scientific_name: 'A b', name_zh: '甲',
    distribution: ['tdwg-40'], distribution_basis: 'records', description: '这是一段足够长的介绍内容。' };
  assert.equal(parseTaxon(createTaxonMarkdown(input)).distribution_basis, 'records');
  assert.throws(() => parseTaxon(createTaxonMarkdown({ ...input, distribution_basis: 'unknown' })), /distribution_basis/);
});

test('AI toxicity needs a passage found verbatim in a species reference', () => {
  const references = [{ source: '百科条目', text: '这种蘑菇含有强烈毒素，误食后可能导致严重中毒。' }];
  assert.deepEqual(sourceBackedToxicity({ level: 'high', evidence: '误食后可能导致严重中毒' }, references),
    { level: 'high', evidence: '误食后可能导致严重中毒', source: '百科条目' });
  assert.equal(sourceBackedToxicity({ level: 'high', evidence: '接触后可能导致严重中毒' }, references), null);
  assert.equal(sourceBackedToxicity({ level: 'none', evidence: '没有毒性' }, references), null);
});

test('species lists accept lines, commas, comments and repeats', () => {
  assert.deepEqual(parseSpeciesList('Panthera tigris, Panthera  leo;Puma concolor\n# a comment, with a comma\nPanthera LEO # again\n\n'),
    ['Panthera tigris', 'Panthera leo', 'Puma concolor']);
  assert.deepEqual(parseSpeciesList('A b', undefined, '', 'a B\nC d'), ['A b', 'C d']);
  assert.deepEqual(parseSpeciesList(), []);
});

test('species proposed by earlier automated pull requests are recognised, singly or in a batch', () => {
  const ids = proposedFromPulls([
    { headRefName: 'auto/panthera-pardus', body: '<!-- auto-species-ids: panthera-pardus,panthera-onca,prionailurus-rubiginosus -->' },
    { headRefName: 'auto/ailuropoda-melanoleuca', body: null },
    { headRefName: 'submission/issue-3', body: '<!-- auto-species-ids: not-ours -->' }
  ]);
  assert.deepEqual([...ids].sort(), ['ailuropoda-melanoleuca', 'panthera-onca', 'panthera-pardus', 'prionailurus-rubiginosus']);
});

test('asked-for species are taken only from the GBIF candidates, in the model\'s order', () => {
  const candidates = [{ key: 1, canonicalName: 'Naja naja' }, { key: 2, canonicalName: 'Naja atra' }, { key: 3, canonicalName: 'Bungarus fasciatus' }];
  const { chosen, unknown } = chosenCandidates(['Naja atra', 'naja  NAJA', 'Naja atra', 'Naja invented', 'Panthera tigris'], candidates);
  assert.deepEqual(chosen.map(item => item.key), [2, 1]);
  assert.deepEqual(unknown, ['Naja invented', 'Panthera tigris']);
});

test('the request and the pick must come back in a usable shape', () => {
  assert.equal(askShapeProblem({ group: 'Elapidae', rank: 'family', kingdom: 'Animalia', count: 20, criteria: '', problem: '' }), null);
  assert.equal(askShapeProblem({ group: 'Elapidae', rank: 'family', count: null }), null);
  assert.match(askShapeProblem({ group: 'Elapidae', rank: 'family', count: '20' }), /count/);
  assert.match(askShapeProblem({ group: 'Elapidae', rank: 'family', count: 0 }), /count/);
  assert.match(askShapeProblem([]), /JSON/);
  assert.equal(pickShapeProblem({ species: ['Naja naja'], reason: '常见' }), null);
  assert.match(pickShapeProblem({ species: 'Naja naja' }), /species/);
});
