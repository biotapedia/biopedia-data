# BIOTA 图鉴数据

这个仓库是图鉴的内容源。`docs/taxa/*.md` 存放文字与元数据；`docs/roots.json` 和 `docs/children/<id>/<page>.json` 是小型查询索引。前端在用户浏览时按需请求这些文件，不把整个图鉴打包进前端。`docs/.nojekyll` 使 GitHub Pages 原样发布 Markdown。

## 本地维护

每篇 Markdown 用 JSON 字符串形式的 YAML front matter 定义 `id`、`parent_id`、`rank`、`scientific_name`、`name_zh`，正文可使用 Markdown 写介绍。封面图片用 `image_url` 指向 HTTPS 外链，并填写 `image_credit`；正文中的 Markdown 图片也只能使用 HTTPS 外链。可选 `source_url` 引用资料来源。可选 `distribution` 是分布地区编号数组，例如 `["tdwg-36","fao-61"]`：陆地用 TDWG WGSRPD 一、二级区，海洋用 FAO 主要渔区，任意一级都可以，但不能同时列出某个区域和它的上级。合法编号及上下级关系见 `scripts/regions.json`，它与前端的 `src/regions.js` 和地图边界使用同一套编号，修改时需同步。可选 `conservation_status` 是 IUCN 红色名录等级，取值 `EX`（灭绝）、`EW`（野外灭绝）、`CR`（极危）、`EN`（濒危）、`VU`（易危）、`NT`（近危）、`LC`（无危）、`DD`（数据缺乏）、`NE`（未评估），只能用于级别为 `species` 或 `subspecies` 的条目；它同时写入目录索引，以便列表卡片展示。

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

`scripts/auto-species.mjs` 每次新增一个物种，必要时连同缺失的上级分类，再由 `auto-species.yml` 提交为待审核的 PR。工作流每周一运行一次，也可以在 **Actions → Propose a new species** 中手动运行并填写学名。

脚本通过 OpenAI 兼容的 Chat Completions 接口调用大模型，不依赖任何 npm 包。在 **Settings → Secrets and variables → Actions** 中添加 Secret `LLM_API_KEY`，以及变量 `LLM_BASE_URL` 和 `LLM_MODEL`。常见平台的 `LLM_BASE_URL`：

| 平台 | `LLM_BASE_URL` |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` |

`LLM_MODEL` 填写平台文档中的模型名，例如 `deepseek-chat`、`qwen-plus`。脚本默认开启 JSON 输出模式（`response_format: json_object`），如果所用模型不支持，可设置变量 `LLM_JSON_MODE=off`。每次调用模型最多等待 300 秒，可用 `LLM_TIMEOUT`（秒）调整；免费模型往往要排队，推理模型会先思考再回答，都可能超过这个时限。

在本地运行时，把 `.env.example` 复制为 `.env` 并填写这几项。`.env` 已被 `.gitignore` 忽略，不会被提交。已经设置的环境变量优先于 `.env` 中的值。

```sh
cp .env.example .env                              # 然后填写 LLM_API_KEY 等
npm run auto -- --plan                            # 只查资料、打印结果，不调用模型，不写文件
npm run auto -- --name "Ailuropoda melanoleuca"   # 写入 docs/，用 git diff 审阅
```

不指定学名时，脚本从目录中最深的已有分类往下找 GBIF 中尚未收录、且有 IUCN 评估的物种，以排除化石种和冷门名称。已经由脚本提过 PR 的物种（无论是否合并）不会再选。

条目中的事实只取自开放数据，大模型只负责撰写介绍：

| 内容 | 来源 | 许可 |
|---|---|---|
| 学名、分类位置 | GBIF Backbone Taxonomy，须精确匹配且为有效名；异名会被拒绝，并提示有效名 | CC BY 4.0，正文注明来源 |
| 中文名 | Wikidata（通过 GBIF 编号关联）；缺失时由模型拟定，并在 PR 中标为“需核对” | CC0 |
| 保护等级 | IUCN 红色名录，经 GBIF 获取 | 引用事实并注明来源 |
| 封面图片 | Wikimedia Commons，仅接受 CC0、公有领域、CC BY 和 CC BY-SA，且须有作者署名、无附加限制 | 以外链引用，`image_credit` 写明作者、许可和原图页面 |
| 介绍文字 | 大模型根据上述结构化资料原创撰写 | 正文末尾注明由 AI 辅助撰写 |

为避免版权问题，模型只会收到上表中的结构化事实，不会收到任何现有的百科正文。生成的文字会与对应的中文维基百科条目比对，若有连续 20 字以上相同的片段就要求重写；文字中也不得含有链接、图片、标题或 HTML，“资料来源”一节由脚本添加。连续三次生成都不合格时脚本报错退出，不写入任何文件。PR 正文列出各项数据的来源、被跳过的图片及原因，以及模型列出的待核实事实。

自动检查无法保证介绍中的事实正确，也无法确认图片拍的就是该物种，所以合并前仍需人工审核。脚本不会填写 `distribution`，分布地区需由审核人补充。

`docs/config.json` 的 `repository_url` 指向 `https://github.com/biotapedia/biopedia-data`。若将来更换仓库，再更新此值和前端数据地址配置。

示例条目只是功能演示，正式发布前应补充资料来源与图片授权信息。当前目录中的前端和数据仓库都是本地 Git 仓库；需要分别创建 GitHub 远端并推送，才能启用 Pages 和 PR 流程。
