// The language model side of scripts/auto-species.mjs: an OpenAI-compatible Chat Completions call and the prompt.

export const LLM_SETTINGS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];

// Sends one chat request and returns the parsed JSON answer (null when it is not valid JSON) and the model that served it.
export async function chatJson(system, user, { label }) {
  const request = {
    model: process.env.LLM_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // JSON mode is widely supported; set LLM_JSON_MODE=off for models that reject it, such as some reasoning models.
    ...(process.env.LLM_JSON_MODE === 'off' ? {} : { response_format: { type: 'json_object' } })
  };
  const seconds = Number(process.env.LLM_TIMEOUT) || 300;
  for (let attempt = 0; ; attempt++) {
    console.warn(`Waiting for ${process.env.LLM_MODEL} to ${label} (up to ${seconds}s)…`);
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

export const WRITE_PROMPT = `你是「万物图鉴」的科普编辑。请用简体中文为分类条目撰写原创、详尽而可靠的介绍。

输入里有每个条目的学名、中文名、分类位置、保护等级，以及可能附带的一篇参考文章节选（reference，为 null 表示没有）。

规则：
1. 学名、分类位置、中文名和保护等级是权威数据，必须与之一致。
2. 可以参考 reference，也可以补充你确知的、学界公认的内容；不要局限于参考文章，但不确定的内容宁可不写。不要编造具体数字、年份、人名、地名或文献；数据拿不准时用定性的说法（如“体型较大”“主要分布在亚洲南部”）。
3. 全部用自己的话原创表述，不要复述、改写或拼接参考文章或任何现有文本的句子。
4. 正文里不要出现标题标记、列表、引用、链接、网址、图片或 HTML。资料来源由系统另行添加。
5. 物种（species）：写 4–7 个段落，每段有 2–8 个字的小标题 heading（如“形态特征”“分布与栖息地”“食性与习性”“繁殖与寿命”“分类与亚种”“保护现状”），内容尽量详尽，全文约 500–1000 字。没有把握的主题可以省略，不要为凑字数而空泛发挥。
6. 上级分类（ancestors）：每个只写一个段落，heading 为空字符串，60–250 字，概括该类群的共同特征。顺序和 scientific_name 与输入保持一致。
7. name_zh：输入里已给出时原样返回；为 null 时给出中国大陆通用的规范中文名，没有把握就返回空字符串。
8. distribution：distribution_candidates 是 GBIF 有野外观察或标本记录的地区（其中也有引入、逃逸的个体和误认记录，records 只是记录条数，不代表数量）。请只选出该物种**原生分布**的地区。凡是对整体范围、或其中任何一个地区没有十足把握，就把 confidence 设为 "low"，regions 设为空数组——宁缺毋滥。有把握时 confidence 为 "high"，regions 只能填候选列表里的 id，reason 用一句话写明依据。历史分布、引入种群、零星记录都不要选。候选列表为空时返回 {"confidence":"low","regions":[],"reason":""}。
9. claims_to_verify：列出物种介绍里最需要审核人再核实的说法（如体型、分布范围、种群数量），每条一句话。

只输出一个 JSON 对象，不要输出其他任何内容：
{"species":{"name_zh":"…","paragraphs":[{"heading":"…","text":"…"}]},"ancestors":[{"scientific_name":"…","name_zh":"…","paragraphs":[{"heading":"","text":"…"}]}],"distribution":{"confidence":"high","regions":["tdwg-40"],"reason":"…"},"claims_to_verify":["…"]}`;

// The shape the script relies on; content rules are checked in auto-rules.mjs.
export function writingShapeProblem(output) {
  const isText = value => typeof value === 'string';
  const isEntry = value => value && isText(value.name_zh) && Array.isArray(value.paragraphs);
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '输出必须是一个 JSON 对象';
  if (!isEntry(output.species)) return 'species 必须包含字符串 name_zh 和数组 paragraphs';
  if (!Array.isArray(output.ancestors) || output.ancestors.some(item => !isEntry(item) || !isText(item.scientific_name))) {
    return 'ancestors 必须是数组，每一项包含 scientific_name、name_zh 和 paragraphs';
  }
  if (output.claims_to_verify !== undefined && !(Array.isArray(output.claims_to_verify) && output.claims_to_verify.every(isText))) {
    return 'claims_to_verify 必须是字符串数组';
  }
  return null;
}
