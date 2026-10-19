# BIOTA 图鉴数据

这个仓库是图鉴的内容源。`docs/taxa/*.md` 存放文字与元数据；`docs/roots.json` 和 `docs/children/<id>/<page>.json` 是小型查询索引。前端在用户浏览时按需请求这些文件，不把整个图鉴打包进前端。`docs/.nojekyll` 使 GitHub Pages 原样发布 Markdown。

## 本地维护

每篇 Markdown 用 JSON 字符串形式的 YAML front matter 定义 `id`、`parent_id`、`rank`、`scientific_name`、`name_zh`，正文可使用 Markdown 写介绍。封面图片用 `image_url` 指向 HTTPS 外链，并填写 `image_credit`；正文中的 Markdown 图片也只能使用 HTTPS 外链。可选 `source_url` 引用资料来源。可选 `distribution` 是分布地区编号数组，例如 `["tdwg-36","fao-61"]`：陆地用 TDWG WGSRPD 一、二级区，海洋用 FAO 主要渔区，任意一级都可以，但不能同时列出某个区域和它的上级。可选 `distribution_basis` 为 `native`（概略原生分布）或 `records`（GBIF 有记录地区），必须与非空 `distribution` 一起填写；旧条目未标注时前端仍显示“分布地区”。合法编号及上下级关系见 `scripts/regions.json`，它与前端的 `src/regions.js` 和地图边界使用同一套编号，修改时需同步。可选 `conservation_status` 是 IUCN 红色名录等级。可选 `toxicity` 为 `none`（明确无毒）、`mild`（微毒）、`toxic`（有毒）、`high`（剧毒）。两者只能用于物种或亚种，也会写入目录索引用于卡片展示。毒性是概略编辑标签，不是像 IUCN 等级那样的统一标准；资料不明确时不填写，正文应说明接触或摄入途径。

```sh
npm run index      # 重新生成直接子分类的分页索引
npm run validate   # 检查分类树与索引是否一致
npm test           # 验证树结构和投稿转换
```

新增条目时创建 `docs/taxa/<id>.md`，运行 `npm run index`，将 Markdown 和更新后的索引一起提交 PR。索引每页最多 48 个直接子节点，因此打开某个分类不会下载全树。`id` 是稳定标识，不应随名称变动。

## GitHub Pages 配置

将仓库推送到 `biotapedia/biopedia-data`。在 **Settings → Pages** 中选择 **Deploy from a branch → main → /docs**。GitHub 会在合并后发布数据目录，前端仓库不需要重新构建。Pages 本身只提供静态读取。

启用 **Issues**。在 **Settings → Actions → General** 中允许 `GITHUB_TOKEN` 写入并启用 **Allow GitHub Actions to create and approve pull requests**。保护 `main`，要求 Pull Request 审核。网站投稿会先创建 Issue；`issue-to-pr.yml` 只处理带有站点投稿标记的 Issue，校验字段和分类关系，创建 `submission/issue-N` 分支和待审核 PR。审核前应核对科学事实、分类依据、文字与图片授权。由 `GITHUB_TOKEN` 创建的 PR，其后续校验工作流可能需要管理员在 GitHub 上批准运行。

投稿可包含 `ancestors` 数组，按从已有分类到目标条目的顺序列出缺失的中间层级。一个 Issue 会为每个新增层级及目标条目创建独立 Markdown，并在同一个 PR 中更新目录索引。

## 自动新增物种

`scripts/auto-species.mjs` 可以一次新增一个或多个物种，必要时连同缺失的上级分类，再由 `auto-species.yml` 提交为待审核的 PR。工作流每周一运行一次（自动挑 1 个），也可以在 **Actions → Propose a new species** 中手动运行，填写一个或多个学名（逗号或换行分隔），或用一句话说明要挑的物种，或填写要自动挑选的数量。

脚本通过 OpenAI 兼容的 Chat Completions 接口调用大模型，不依赖任何 npm 包。在 **Settings → Secrets and variables → Actions** 中添加 Secret `LLM_API_KEY`，以及变量 `LLM_BASE_URL` 和 `LLM_MODEL`。常见平台的 `LLM_BASE_URL`：

| 平台 | `LLM_BASE_URL` |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` |

`LLM_MODEL` 填写平台文档中的模型名，例如 `deepseek-chat`、`qwen-plus`。脚本默认开启 JSON 输出模式（`response_format: json_object`），如果所用模型不支持，可设置变量 `LLM_JSON_MODE=off`。每次调用模型最多等待 300 秒（写作最多 3 次），可用 `LLM_TIMEOUT`（秒）调整；设置 `LLM_REVIEW=on` 时还会有最多 2 次第二轮检查。平台返回 429（限流）或 5xx 时，脚本会等待 15 秒到 2 分钟后重试，最多 5 次。

在本地运行时，把 `.env.example` 复制为 `.env` 并填写这几项。`.env` 已被 `.gitignore` 忽略，不会被提交。已经设置的环境变量优先于 `.env` 中的值。

```sh
cp .env.example .env                              # 然后填写 LLM_API_KEY 等
npm run auto -- --plan                            # 只查资料、打印结果，不调用模型，不写文件
npm run auto -- --name "Ailuropoda melanoleuca"   # 写入 docs/，用 git diff 审阅
```

**一次跑多个物种：**

```sh
npm run auto -- --count 5                                    # 自动挑 5 个
npm run auto -- --name "Panthera onca" --name "Panthera pardus"
npm run auto -- --name "Panthera onca, Panthera pardus"      # 逗号或换行也可以分隔
npm run auto -- --file names.txt                             # 每行一个学名，# 开头为注释
npm run auto -- --file names.txt --count 3                   # 指定的物种，再自动挑 3 个
```

**用一句话指定要挑的物种：**

```sh
npm run auto -- --ask "帮我生成眼镜蛇科的20个物种"
npm run auto -- --ask "猫科中分布在中国的物种" --count 3    # --count 覆盖要求里的数量
npm run auto -- --ask "海蛇里挑 5 个有代表性的" --plan      # 先看挑了哪些，不写文件
```

`--ask` 分三步：模型先把要求整理成一个 GBIF 分类单元（界到属之间的某一级）和其他要求；脚本从 GBIF 取出这个分类下图鉴尚未收录、也没有被自动 PR 提过的有效物种（最多 2000 个，不含标为化石的）；模型再从这份名单中按要求挑选并排序，名单以外的名字一律丢弃。和自动挑选一样，没有 IUCN 评估的物种会被跳过，由排在后面的备选补上；符合要求的不够时如实少做，并列在“未能生成”下。要求里没写数量时做 1 个。`--ask` 需要调用模型，即使加了 `--plan` 也要配置模型。PR 正文会记录原始要求、模型理解成的分类和挑选思路，审核时请确认所选物种符合要求。`--ask` 可以和 `--name` 一起用，但不再另外按顺序自动挑选。

指定了学名而没有 `--count` 时只做指定的；两者都没有时自动挑 1 个；一次最多 20 个。物种按顺序逐个处理，前面写入的物种已经计入目录，所以同一个属下的几个物种只会新建一次这个属。某个物种失败（学名查不到、已存在、模型出错等）只记录原因并继续下一个，结束时汇总，有失败则退出码为 1。

加 `--pr`（工作流使用）时，一次运行只开**一个 PR**：每个物种一个提交，正文里分物种列出检查结果和待核实项，失败的列在“未能生成”下。不是每个物种一个 PR，因为它们会改同一个索引文件，也可能各自新建同一个属，无法全部合并。`--pr` 要求 `docs/` 没有未提交的改动，运行结束后会切回原来的分支。PR 正文末尾的注释记录了本批所有物种，之后不会再自动选它们。

不指定学名时，脚本从目录中最深的已有分类往下找 GBIF 中尚未收录、且有 IUCN 评估的物种，以排除化石种和冷门名称。已经由脚本提过 PR 的物种（无论是否合并）不会再选。

名称、分类、保护等级、图片取自开放数据；介绍文字由大模型撰写，属于尽力而为的草稿：

| 内容 | 来源 | 许可 |
|---|---|---|
| 学名、分类位置 | GBIF Backbone Taxonomy，须精确匹配且为有效名；异名会被拒绝，并提示有效名 | CC BY 4.0，正文注明来源 |
| 中文名 | Wikidata（通过 GBIF 编号关联）；缺失时由模型拟定，并在 PR 中标为“需核对” | CC0 |
| 保护等级 | IUCN 红色名录，经 GBIF 获取 | 引用事实并注明来源 |
| 毒性 | 模型只在物种参考文章明确描述时建议等级，并提供可在原文中找到的片段；否则不填写 | PR 列出原文片段供人工核对 |
| 介绍文字 | 大模型参考中文和英文维基百科对应条目撰写短介绍；可选第二轮 AI 检查 | 文字为重新撰写，用了参考文章时在“资料来源”中注明（CC BY-SA 4.0） |
| 分布地区 | 优先依据参考文章挑选概略原生区域；无法确认时展示 GBIF 有记录区域并明确标注 | 见下 |
| 封面图片 | Wikimedia Commons，仅接受 CC0、公有领域、CC BY 和 CC BY-SA，须有作者署名、无附加限制，宽度不低于 800 像素；优先用维基百科条目的头图 | 以外链引用；封面上标注作者和许可，许可链接和原图页面写在“资料来源”中 |

**介绍文字**：物种通常写 3–5 个带小标题的段落（约 400–800 字，参考资料少时更短），每个新增的上级分类写一段。模型同时阅读中文和英文维基百科（物种最多各读 1 万和 1.5 万字），具体数字、年份、人名、地名只能取自参考文章，拿不准就不写。生成的文字标为待编辑审核。

**可选 AI 检查**：默认只生成一次草稿并列出待核实说法。设置 `LLM_REVIEW=on` 才会让第二个模型调用对照同一批资料提出局部改正，并在 PR 记录改动；`LLM_REVIEW_MODEL` 可指定检查模型。这一轮不是独立事实验证，合并前仍需人工审核。脚本还会检查格式、长度，以及与参考文章没有连续 20 字以上的相同片段。写作最多尝试 3 次，仍不合格则报错退出。

**地图尽量展示，但明确依据。** 脚本把 GBIF 有记录的国家归入 TDWG 区域（区域对照表运行时从 tdwg/wgsrpd 下载并缓存），作为候选交给模型。模型只从参考文章明确支持的候选地区中挑选原生分布；无记录支持的选择会逐区排除。若没有可确认的原生区域，则改为展示 GBIF 有记录区域，并设置 `distribution_basis: "records"`。这类记录可能包含引入、逃逸或误认，前端会用不同颜色和说明提示，不能视为原生范围。地图着色的是整个大区，不代表区域内处处有分布。GBIF 没有可用的陆地记录时仍无法绘图；海洋物种暂无自动分布。

PR 正文会列出各项数据的来源、被跳过的图片及原因、分布的依据和待核实的说法。重新生成已有物种时加 `--replace`（该物种不能有下级分类）：

```sh
npm run auto -- --name "Panthera tigris" --replace
```

合并前仍需人工审核：介绍中的体型、数量等具体数据可能有误，也无法确认图片拍的就是该物种。

`docs/config.json` 的 `repository_url` 指向 `https://github.com/biotapedia/biopedia-data`。若将来更换仓库，再更新此值和前端数据地址配置。

示例条目只是功能演示，正式发布前应补充资料来源与图片授权信息。当前目录中的前端和数据仓库都是本地 Git 仓库；需要分别创建 GitHub 远端并推送，才能启用 Pages 和 PR 流程。
