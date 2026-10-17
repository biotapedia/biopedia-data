# BIOTA 图鉴数据

这个仓库是图鉴的内容源。`docs/taxa/*.md` 存放文字与元数据；`docs/roots.json` 和 `docs/children/<id>/<page>.json` 是小型查询索引。前端在用户浏览时按需请求这些文件，不把整个图鉴打包进前端。`docs/.nojekyll` 使 GitHub Pages 原样发布 Markdown。

## 本地维护

每篇 Markdown 用 JSON 字符串形式的 YAML front matter 定义 `id`、`parent_id`、`rank`、`scientific_name`、`name_zh`，正文写介绍。图片只能用 `image_url` 指向 HTTPS 外链；有图片时必须填写 `image_credit`。可选 `source_url` 引用资料来源。

```sh
npm run index      # 重新生成直接子分类的分页索引
npm run validate   # 检查分类树与索引是否一致
npm test           # 验证树结构和投稿转换
```

新增条目时创建 `docs/taxa/<id>.md`，运行 `npm run index`，将 Markdown 和更新后的索引一起提交 PR。索引每页最多 48 个直接子节点，因此打开某个分类不会下载全树。`id` 是稳定标识，不应随名称变动。

## GitHub Pages 配置

将仓库推送到 `biotapedia/biopedia-data`。在 **Settings → Pages** 中选择 **Deploy from a branch → main → /docs**。GitHub 会在合并后发布数据目录，前端仓库不需要重新构建。Pages 本身只提供静态读取。

启用 **Issues**。在 **Settings → Actions → General** 中允许 `GITHUB_TOKEN` 写入并启用 **Allow GitHub Actions to create and approve pull requests**。保护 `main`，要求 Pull Request 审核。网站投稿会先创建 Issue；`issue-to-pr.yml` 只处理带有站点投稿标记的 Issue，校验字段和分类关系，创建 `submission/issue-N` 分支和待审核 PR。审核前应核对科学事实、分类依据、文字与图片授权。由 `GITHUB_TOKEN` 创建的 PR，其后续校验工作流可能需要管理员在 GitHub 上批准运行。

`docs/config.json` 的 `repository_url` 指向 `https://github.com/biotapedia/biopedia-data`。若将来更换仓库，再更新此值和前端数据地址配置。

示例条目只是功能演示，正式发布前应补充资料来源与图片授权信息。当前目录中的前端和数据仓库都是本地 Git 仓库；需要分别创建 GitHub 远端并推送，才能启用 Pages 和 PR 流程。
