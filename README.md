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

`scripts/auto-species.mjs` 可以一次新增一个或多个物种，必要时连同缺失的上级分类，再由 `auto-species.yml` 提交为待审核的 PR。工作流每周一运行一次（自动挑 1 个），也可以在 **Actions → Propose a new species** 中手动运行，填写一个或多个学名（逗号或换行分隔），或填写要自动挑选的数量。

脚本通过 OpenAI 兼容的 Chat Completions 接口调用大模型，不依赖任何 npm 包。在 **Settings → Secrets and variables → Actions** 中添加 Secret `LLM_API_KEY`，以及变量 `LLM_BASE_URL` 和 `LLM_MODEL`。常见平台的 `LLM_BASE_URL`：

| 平台 | `LLM_BASE_URL` |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` |

`LLM_MODEL` 填写平台文档中的模型名，例如 `deepseek-chat`、`qwen-plus`。脚本默认开启 JSON 输出模式（`response_format: json_object`），如果所用模型不支持，可设置变量 `LLM_JSON_MODE=off`。每次调用模型最多等待 300 秒（一个物种写作最多 3 次、核查最多 2 次），可用 `LLM_TIMEOUT`（秒）调整；免费模型往往要排队，推理模型会先思考再回答，都可能超过这个时限。

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

指定了学名而没有 `--count` 时只做指定的；两者都没有时自动挑 1 个；一次最多 20 个。物种按顺序逐个处理，前面写入的物种已经计入目录，所以同一个属下的几个物种只会新建一次这个属。某个物种失败（学名查不到、已存在、模型出错等）只记录原因并继续下一个，结束时汇总，有失败则退出码为 1。

加 `--pr`（工作流使用）时，一次运行只开**一个 PR**：每个物种一个提交，正文里分物种列出检查结果和待核实项，失败的列在“未能生成”下。不是每个物种一个 PR，因为它们会改同一个索引文件，也可能各自新建同一个属，无法全部合并。`--pr` 要求 `docs/` 没有未提交的改动，运行结束后会切回原来的分支。PR 正文末尾的注释记录了本批所有物种，之后不会再自动选它们。

不指定学名时，脚本从目录中最深的已有分类往下找 GBIF 中尚未收录、且有 IUCN 评估的物种，以排除化石种和冷门名称。已经由脚本提过 PR 的物种（无论是否合并）不会再选。

名称、分类、保护等级、图片取自开放数据；介绍文字由大模型撰写，属于尽力而为的草稿：

| 内容 | 来源 | 许可 |
|---|---|---|
| 学名、分类位置 | GBIF Backbone Taxonomy，须精确匹配且为有效名；异名会被拒绝，并提示有效名 | CC BY 4.0，正文注明来源 |
| 中文名 | Wikidata（通过 GBIF 编号关联）；缺失时由模型拟定，并在 PR 中标为“需核对” | CC0 |
| 保护等级 | IUCN 红色名录，经 GBIF 获取 | 引用事实并注明来源 |
| 介绍文字 | 大模型撰写：以中文和英文维基百科对应条目（有哪个用哪个）为参考，并结合自身知识；再由大模型对照同样的参考逐句核查 | 文字为重新撰写，用了参考文章时在“资料来源”中注明（CC BY-SA 4.0） |
| 分布地区 | GBIF 的野外观察和标本记录，按国家归入 TDWG 区域，再由模型筛选 | 见下 |
| 封面图片 | Wikimedia Commons，仅接受 CC0、公有领域、CC BY 和 CC BY-SA，须有作者署名、无附加限制，宽度不低于 800 像素；优先用维基百科条目的头图 | 以外链引用；封面上标注作者和许可，许可链接和原图页面写在“资料来源”中 |

**介绍文字**：物种写成 6–10 个带小标题的段落（约 1200–2500 字，参考资料少时会短一些），每个新增的上级分类写一段。模型同时阅读中文和英文维基百科（物种最多各读 1 万和 1.5 万字），被要求以参考文章为准：具体数字、年份、人名、地名只能取自参考文章，拿不准就用定性说法或不写。

**AI 核查**：写完后再调用一次模型，让它把草稿与权威数据（学名、分类、保护等级）和同样的参考文章逐句对照，并逐条处理作者自己列出的存疑说法：与参考矛盾的改成参考的说法，中英文参考不一致的改成两者都支持的概数或定性说法，没有依据的改成定性说法或删去，以“原文片段 → 改好的文字”的形式直接给出。脚本逐条应用这些改正（找不到原文、或改后含链接、与参考文章大段相同的会被跳过），并在 PR 的“AI 核查记录”里列出每一处改动及理由，“需人工核实”只列出核查后仍无法确认、又不宜删去的少数说法。核查默认用同一个模型；设置 `LLM_REVIEW_MODEL` 可以换一个更强或不同来源的模型交叉核查，设置 `LLM_REVIEW=off` 可以跳过核查。核查只能对照参考文章，**不能保证完全正确**，合并前仍需人工审核。脚本会检查：文字中没有链接、图片、标题标记或 HTML；与参考文章没有连续 20 字以上的相同片段（有就要求重写）；长度合理。最多尝试 3 次，仍不合格则报错退出，不写入任何文件。

**分布地区只在有把握时填写。** 脚本把 GBIF 有记录的国家归入 TDWG 区域（区域对照表运行时从 tdwg/wgsrpd 下载并缓存，因其许可未声明，没有提交进本仓库），作为候选交给模型。记录里混有引入、逃逸和误认的个体，所以模型只能从候选中选出**原生分布**；对整体范围或任何一个地区没有十足把握时，它必须返回“不确定”，此时不填写 `distribution`。选了没有记录支持的地区也会整体放弃。某一级下的全部区域会合并为该级。海洋物种没有对应的 FAO 渔区记录，暂不自动填写分布。

PR 正文会列出各项数据的来源、被跳过的图片及原因、分布的依据和待核实的说法。重新生成已有物种时加 `--replace`（该物种不能有下级分类）：

```sh
npm run auto -- --name "Panthera tigris" --replace
```

合并前仍需人工审核：介绍中的体型、数量等具体数据可能有误，也无法确认图片拍的就是该物种。

`docs/config.json` 的 `repository_url` 指向 `https://github.com/biotapedia/biopedia-data`。若将来更换仓库，再更新此值和前端数据地址配置。

示例条目只是功能演示，正式发布前应补充资料来源与图片授权信息。当前目录中的前端和数据仓库都是本地 Git 仓库；需要分别创建 GitHub 远端并推送，才能启用 Pages 和 PR 流程。
