// The language model side of scripts/auto-species.mjs: an OpenAI-compatible Chat Completions call and the prompts.

export const LLM_SETTINGS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
// Retries after HTTP 429 and 5xx, waiting 15, 30, 60, 120 and 120 seconds unless the provider says how long.
const MAX_RETRIES = 5;

// Sends one chat request and returns the parsed JSON answer (null when it is not valid JSON) and the model that served it.
export async function chatJson(system, user, { label, model = process.env.LLM_MODEL }) {
  const maxTokens = Number(process.env.LLM_MAX_TOKENS);
  const request = {
    model,
    // Only sent when set: some providers cap a short default, but for reasoning models the limit includes the thinking.
    ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // JSON mode is widely supported; set LLM_JSON_MODE=off for models that reject it, such as some reasoning models.
    ...(process.env.LLM_JSON_MODE === 'off' ? {} : { response_format: { type: 'json_object' } })
  };
  const seconds = Number(process.env.LLM_TIMEOUT) || 300;
  for (let attempt = 0; ; attempt++) {
    console.warn(`Waiting for ${model} to ${label} (up to ${seconds}s)…`);
    let data;
    try {
      // The timeout covers reading the body too: queued providers send headers at once and the answer much later.
      const response = await fetch(`${process.env.LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(seconds * 1000)
      });
      // Free models share a provider-wide quota that can stay exhausted for minutes, so back off for a while.
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const after = Number(response.headers.get('retry-after'));
        const wait = Math.min(after > 0 ? after : 15 * 2 ** attempt, 120);
        await response.body?.cancel();
        console.warn(`LLM API answered HTTP ${response.status}, retrying in ${wait}s (${attempt + 1}/${MAX_RETRIES})…`);
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        continue;
      }
      if (response.status === 429) {
        throw new Error(`${model} is rate-limited (HTTP 429) and stayed so after ${MAX_RETRIES} retries. Free models share one `
          + `quota with everyone using them: try again later or use a paid model. ${(await response.text()).slice(0, 300)}`);
      }
      if (!response.ok) throw new Error(`LLM API: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
      data = await response.json();
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw new Error(`${model} did not answer within ${seconds}s. Free models are often queued and `
        + 'reasoning models think before answering: try another model, or raise LLM_TIMEOUT (seconds).');
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('The model ran out of output tokens; raise LLM_MAX_TOKENS');
    if (choice?.finish_reason === 'content_filter') throw new Error('The provider filtered the response');
    const text = (choice?.message?.content ?? '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let output = null;
    try { output = JSON.parse(text); } catch {}
    return { output, model: data.model || model };
  }
}

export const WRITE_PROMPT = `你是「万物图鉴」的科普编辑。请用简体中文为分类条目撰写原创、详尽而可靠的介绍。

输入里只有已核对的学名、分类位置、部分中文名和保护等级。请先独立写出介绍；系统会用预先找到、但未提供给你的资料逐句核查。

真实性（最重要，宁可少写也不能写错）：
1. 学名、分类位置、已给出的中文名和保护等级必须与输入一致。name_zh 为 null 只表示本次数据检索未找到，不等于该物种没有中文名。
2. 用自己的知识独立组织介绍，但任何拿不准的内容都不要写。不要为补足篇幅编造细节。
3. 不写未经输入证实的具体数字、年份、人名、地点、亚种名或“最大”“唯一”等绝对说法。分布、生境和毒性等事实会在下一轮对照资料核查。
4. 不要编造研究或文献；不要把属、科或近似种的特征安到这个物种身上。

写作：
5. 全部用自己的话原创表述，不要复述记忆中的百科句子。
6. 正文里不要出现标题标记、列表、引用、链接、网址、图片或 HTML，也不要写“参考资料指出”“提供的材料未提及”等写作过程用语。资料来源由系统另行添加。
7. 物种（species）：通常写 3–5 个带小标题的段落，全文约 400–800 字。优先介绍有把握的形态、分布与栖息地、生态习性和保护现状；资料少时可以更短。
8. 上级分类（ancestors）：每个只写一个段落，heading 为空字符串，约 60–180 字。顺序和 scientific_name 与输入保持一致。
9. name_zh：输入里已给出时原样返回；为 null 时返回空字符串，绝不能拟造中文名。
10. distribution 固定返回 {"confidence":"low","regions":[],"reason":""}；toxicity 固定返回 null。这两项须在资料核查阶段确定。
11. claims_to_verify：列出介绍中的可核查事实，尤其是分布、形态、生态习性、毒性等，每条一句话。

只输出一个 JSON 对象，不要输出其他任何内容：
{"species":{"name_zh":"…","paragraphs":[{"heading":"…","text":"…"}],"toxicity":null},"ancestors":[{"scientific_name":"…","name_zh":"…","paragraphs":[{"heading":"","text":"…"}]}],"distribution":{"confidence":"low","regions":[],"reason":""},"claims_to_verify":["…"]}`;

// A mandatory source-check pass over the finished draft. It returns exact passages to replace rather than a rewritten
// text, so the script can apply, check and list every change, and nothing else in the draft moves.
export const REVIEW_PROMPT = `你是「万物图鉴」的事实核查编辑。另一位编辑未读取参考资料就写了下列条目的介绍，请逐句核对其中的事实，并把发现的问题直接改好。

输入：
- facts：权威数据（学名、分类位置、中文名、保护等级），一律以此为准。
- references：每个条目的参考资料节选，可能来自维基百科、学术论文摘要、开放获取论文中明确提及该物种的段落，或 GBIF 物种描述。只依据节选确实支持的事实；论文同时讨论其他物种时，不得把它们的特征移给目标物种。
- distribution_candidates：GBIF 有记录地区，只能在参考文章明确支持原生分布时选用。
- drafts：待核对的介绍。
- writer_doubts：作者自己也没有把握的说法，每一条都要核对并处理。

核对方法：把每一个事实性说法（数字和范围、年份、分布、生境、食性、习性、繁殖、分类关系、保护等级与保护措施等）与 facts 和 references 对照。references 缺失不能当成事实已获证实。有问题就直接给出改好的文字，不要只是指出问题：
- 与 facts 或 references 矛盾：改成 references 的说法。
- 数字与 references 不符：改成 references 中的数字和范围。
- 中英文 references 说法不一致（例如不同年份的调查数字、不同的体型范围）：改成两者都能支持的说法，例如取能涵盖两者的范围、写“约”或“数千只”这样的概数，或者去掉数字改用定性说法；不要挑其中一个写成确定的事实。
- references 里没有依据、也不是学界公认常识的说法，尤其是具体数字、年份、人名、地名、亚种名和“最大”“唯一”“最早”等绝对说法：改成 references 支持的说法，或改成不含具体细节的定性说法，实在无法保留就删去。
- 把属、科或近似种的特征，或者个别地区、个别亚种、圈养个体的情况说成整个物种的：改正范围。
- 特别核对比较句和代词的指代，避免把邻近物种的毒性、剂量或其他事实移到目标物种。
- 有依据的内容一律不动；不要润色文字、调整风格，也不要增加 references 里没有的新内容。

另外依据 references 独立给出：
- distribution：只选有参考文章明确支持的原生分布区域；无依据时 confidence 为 low、regions 为空。地区 id 必须来自 distribution_candidates。
- toxicity：只在物种自身的参考文章明确支持时填等级和逐字复制的 8–200 字 evidence；否则为 null。等级为 none、mild、toxic、high。不要把食用毒性写成接触毒性。
- 如果正文明确称该物种“剧毒”或“可致命”，必须同时给出支持 high 的物种原文证据；找不到证据就用 corrections 删除或改正该断言，不能保留断言却把 toxicity 留空。

改法：每处修改给出
- scientific_name：所属条目的学名；
- original：从该条目正文中原样复制的连续片段，必须一字不差、在该条目中只出现一次，尽量短，通常是一个分句或一句；
- replacement：改好后的文字，删除就填空字符串。替换后整段仍须通顺、与上下文衔接，不要出现链接、标题标记或 HTML，也不要照抄参考文章；
- reason：一句话说明原来错在哪里、改后的依据是什么。

只输出一个 JSON 对象，不要输出其他任何内容：
{"corrections":[{"scientific_name":"…","original":"…","replacement":"…","reason":"…"}],"doubts":["…"],"distribution":{"confidence":"low","regions":[],"reason":""},"toxicity":null}
没有需要改正的地方时 corrections 为空数组。能改好的一律直接改，不要放进 doubts；doubts 只列出改完之后仍然留在正文里、你无法从 references 确认、又不宜删去的说法，每条一句话，通常应为空数组。`;

// --ask, step one: the request in words becomes a taxon to search GBIF under. The model only names the group; the
// species themselves come from GBIF.
export const ASK_PROMPT = `你是「万物图鉴」的分类学助手。用户会用一句话说明想新增哪些物种，请把要求整理成检索条件。

- group：包含所要物种的最小分类单元的拉丁学名（GBIF Backbone 中的有效名），级别只能是 kingdom、phylum、class、order、family、genus 之一。例如“眼镜蛇科”是 Elapidae（family）；“蛇”没有对应这些级别的类群，就取 Squamata（order），并在 criteria 中写“只要蛇类”。
- rank：group 的级别，用上面的小写英文。
- kingdom：group 所属的界的拉丁名（Animalia、Plantae、Fungi 等），用于区分不同界的同名类群；group 本身是界时填它自己。
- count：用户要的物种数量（整数）；没有说明就填 null。
- criteria：group 以外的其他挑选要求（例如“常见的”“分布在中国的”“海蛇”），用简体中文简述；没有就填空字符串。
- problem：无法判断用户想要哪个类群时，group 填空字符串，并在这里用一句话说明原因；否则填空字符串。

只输出一个 JSON 对象，不要输出其他任何内容：
{"group":"Elapidae","rank":"family","kingdom":"Animalia","count":20,"criteria":"","problem":""}`;

// --ask, step two: the model ranks species from GBIF's list. Names outside the list are dropped by the script.
export const PICK_PROMPT = `你是「万物图鉴」的编辑，要从候选名单中挑选准备新增的物种。

输入：
- request：用户的原始要求；criteria：整理出的其他挑选要求（可能为空）。
- count：需要的物种数量；max_listed：最多列出的数量。
- candidates：GBIF 中该类群下、图鉴尚未收录的有效物种学名。candidates_complete 为 false 时名单只是其中一部分。

要求：
1. 只能从 candidates 中挑选，学名原样复制，不要改动拼写，不要加入名单之外的物种。
2. 只按 request 和 criteria 中明确提出的条件挑选。不要自行附加知名度、资料多少、维基百科条目或 IUCN 评估要求；用户明确要求其中某项时才考虑。
3. 按匹配用户条件的程度列出，最多 max_listed 个：前 count 个是首选，其余作为备选。符合要求的物种不够时如实少列，不要凑数。
4. reason 用一句话说明挑选思路。

只输出一个 JSON 对象，不要输出其他任何内容：
{"species":["Naja naja","…"],"reason":"…"}`;

export function askShapeProblem(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '输出必须是一个 JSON 对象';
  for (const key of ['group', 'rank', 'kingdom', 'criteria', 'problem']) {
    if (typeof (output[key] ?? '') !== 'string') return `${key} 必须是字符串`;
  }
  if (output.count !== null && output.count !== undefined && !(Number.isInteger(output.count) && output.count > 0)) {
    return 'count 必须是正整数或 null';
  }
  return null;
}

export function pickShapeProblem(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '输出必须是一个 JSON 对象';
  if (!Array.isArray(output.species) || !output.species.every(item => typeof item === 'string')) return 'species 必须是字符串数组';
  if (typeof (output.reason ?? '') !== 'string') return 'reason 必须是字符串';
  return null;
}

// The shape the script relies on; content rules are checked in auto-rules.mjs.
export function writingShapeProblem(output) {
  const isText = value => typeof value === 'string';
  const isEntry = value => value && isText(value.name_zh) && Array.isArray(value.paragraphs);
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '输出必须是一个 JSON 对象';
  if (!isEntry(output.species)) return 'species 必须包含字符串 name_zh 和数组 paragraphs';
  const toxicity = output.species.toxicity;
  if (toxicity !== undefined && toxicity !== null &&
      (!toxicity || typeof toxicity !== 'object' || Array.isArray(toxicity) ||
        typeof toxicity.level !== 'string' || typeof toxicity.evidence !== 'string')) {
    return 'species.toxicity 必须为 null 或包含字符串 level 和 evidence 的对象';
  }
  if (!Array.isArray(output.ancestors) || output.ancestors.some(item => !isEntry(item) || !isText(item.scientific_name))) {
    return 'ancestors 必须是数组，每一项包含 scientific_name、name_zh 和 paragraphs';
  }
  if (output.claims_to_verify !== undefined && !(Array.isArray(output.claims_to_verify) && output.claims_to_verify.every(isText))) {
    return 'claims_to_verify 必须是字符串数组';
  }
  return null;
}

export function reviewShapeProblem(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '输出必须是一个 JSON 对象';
  const isCorrection = item => item && ['scientific_name', 'original', 'replacement', 'reason'].every(key => typeof item[key] === 'string');
  if (!Array.isArray(output.corrections) || !output.corrections.every(isCorrection)) {
    return 'corrections 必须是数组，每一项包含字符串 scientific_name、original、replacement 和 reason';
  }
  if (output.doubts !== undefined && !(Array.isArray(output.doubts) && output.doubts.every(item => typeof item === 'string'))) {
    return 'doubts 必须是字符串数组';
  }
  if (output.distribution !== undefined && (!output.distribution || !['high', 'low'].includes(output.distribution.confidence) ||
      !Array.isArray(output.distribution.regions) || !output.distribution.regions.every(item => typeof item === 'string') ||
      typeof output.distribution.reason !== 'string')) return 'distribution 格式错误';
  if (output.toxicity !== undefined && output.toxicity !== null && (!output.toxicity || typeof output.toxicity !== 'object' ||
      typeof output.toxicity.level !== 'string' || typeof output.toxicity.evidence !== 'string')) return 'toxicity 格式错误';
  return null;
}
