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

输入里有每个条目的学名、中文名、分类位置、保护等级，以及参考文章节选 references（中文和/或英文维基百科，可能为空数组）。

真实性（最重要，宁可少写也不能写错）：
1. 学名、分类位置、中文名和保护等级是权威数据，必须与之一致。
2. 事实以 references 为主要依据。references 里没有、但属于学界公认且你确知的内容可以补充；任何拿不准的内容都不要写。
3. 具体数字（体长、体重、寿命、妊娠期、窝仔数、种群数量、海拔等）、年份、人名、地名和亚种名只能取自 references，并忠实转述原来的数值和范围，不要自行换算、取整或推断；references 里没有就改用定性说法（如“体型较大”“主要分布在亚洲南部”）。中英文参考说法不一致时，采用更保守、更概括的说法。
4. 不要编造研究、文献或“有研究表明”之类没有出处的说法；不要把属、科或近似种的特征安到这个物种身上；不要把个别地区、个别亚种或圈养个体的情况说成整个物种的情况；不要用“最大”“唯一”“最早”等绝对说法，除非 references 明确这样说。

写作：
5. 全部用自己的话原创表述，不要复述、改写或拼接参考文章的句子，英文参考也不要逐句翻译。
6. 正文里不要出现标题标记、列表、引用、链接、网址、图片或 HTML。资料来源由系统另行添加。
7. 物种（species）：通常写 3–5 个带小标题的段落，全文约 400–800 字。优先介绍可辨认的形态、分布与栖息地、生态习性和保护现状；其他主题只有 references 有足够资料时才写。资料少时可以更短，不要为凑段落和字数补充未经证实的细节或重复内容。
8. 上级分类（ancestors）：每个只写一个段落，heading 为空字符串，约 60–180 字，概括资料支持的共同特征和主要类群。顺序和 scientific_name 与输入保持一致。
9. name_zh：输入里已给出时原样返回；为 null 时给出中国大陆通用的规范中文名，没有把握就返回空字符串。
10. distribution：distribution_candidates 是 GBIF 有观察或标本记录的地区（可能包含引入、逃逸和误认记录，records 不是个体数量）。只选 references 明确支持的**原生分布**地区；逐区判断，不确定的地区不要选。有至少一个确定地区时 confidence 为 "high"，regions 只能填候选列表中的 id，reason 简述参考依据；references 没有分布依据或一个地区也不能确定时返回 {"confidence":"low","regions":[],"reason":""}。脚本会在这种情况下另行展示 GBIF 有记录地区，并明确标注其含义。
11. toxicity：这是给物种卡片显示的概略毒性标签，不是统一的医学等级。只能在该**物种本身**的 references 明确描述毒性时填写；不能把属或近似种的毒性套用过来，也不能因资料没提毒性就填“无毒”。level 只能是 "none"（明确无毒）、"mild"（微毒）、"toxic"（有毒，程度不明）、"high"（明确剧毒或可致命）；evidence 必须逐字复制 species references 中支持该等级的 8–200 字连续片段。没有直接依据时填 null。正文中应说明资料提到的中毒途径，不能把食用毒性写成接触毒性。
12. claims_to_verify：列出物种介绍里最需要审核人再核实的说法，尤其是具体数字、分布范围、毒性，以及不是来自 references 的内容，每条一句话。

只输出一个 JSON 对象，不要输出其他任何内容：
{"species":{"name_zh":"…","paragraphs":[{"heading":"…","text":"…"}],"toxicity":{"level":"toxic","evidence":"参考文章中的原文片段"}},"ancestors":[{"scientific_name":"…","name_zh":"…","paragraphs":[{"heading":"","text":"…"}]}],"distribution":{"confidence":"high","regions":["tdwg-40"],"reason":"…"},"claims_to_verify":["…"]}`;

// A second, independent pass over the finished draft. It returns exact passages to replace rather than a rewritten
// text, so the script can apply, check and list every change, and nothing else in the draft moves.
export const REVIEW_PROMPT = `你是「万物图鉴」的事实核查编辑。另一位编辑根据参考资料写了下列条目的介绍，请逐句核对其中的事实，并把发现的问题直接改好。

输入：
- facts：权威数据（学名、分类位置、中文名、保护等级），一律以此为准。
- references：每个条目的参考文章节选（中文和/或英文维基百科）。
- drafts：待核对的介绍。
- writer_doubts：作者自己也没有把握的说法，每一条都要核对并处理。

核对方法：把每一个事实性说法（数字和范围、年份、分布、生境、食性、习性、繁殖、分类关系、保护等级与保护措施等）与 facts 和 references 对照，有问题就直接给出改好的文字，不要只是指出问题：
- 与 facts 或 references 矛盾：改成 references 的说法。
- 数字与 references 不符：改成 references 中的数字和范围。
- 中英文 references 说法不一致（例如不同年份的调查数字、不同的体型范围）：改成两者都能支持的说法，例如取能涵盖两者的范围、写“约”或“数千只”这样的概数，或者去掉数字改用定性说法；不要挑其中一个写成确定的事实。
- references 里没有依据、也不是学界公认常识的说法，尤其是具体数字、年份、人名、地名、亚种名和“最大”“唯一”“最早”等绝对说法：改成 references 支持的说法，或改成不含具体细节的定性说法，实在无法保留就删去。
- 把属、科或近似种的特征，或者个别地区、个别亚种、圈养个体的情况说成整个物种的：改正范围。
- 有依据的内容一律不动；不要润色文字、调整风格，也不要增加 references 里没有的新内容。

改法：每处修改给出
- scientific_name：所属条目的学名；
- original：从该条目正文中原样复制的连续片段，必须一字不差、在该条目中只出现一次，尽量短，通常是一个分句或一句；
- replacement：改好后的文字，删除就填空字符串。替换后整段仍须通顺、与上下文衔接，不要出现链接、标题标记或 HTML，也不要照抄参考文章；
- reason：一句话说明原来错在哪里、改后的依据是什么。

只输出一个 JSON 对象，不要输出其他任何内容：
{"corrections":[{"scientific_name":"…","original":"…","replacement":"…","reason":"…"}],"doubts":["…"]}
没有需要改正的地方时 corrections 为空数组。能改好的一律直接改，不要放进 doubts；doubts 只列出改完之后仍然留在正文里、你无法从 references 确认、又不宜删去的说法，每条一句话，通常应为空数组。`;

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
  return null;
}
