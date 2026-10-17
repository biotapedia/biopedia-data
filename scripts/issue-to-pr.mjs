import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncIndexes } from './catalog.mjs';
import { parseIssueBody, prepareSubmission } from './submission.mjs';

const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDirectory = path.join(repoDirectory, 'docs');
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const issue = event.issue;
if (!issue || !Number.isSafeInteger(issue.number)) throw new Error('Missing GitHub issue event');
const submission = parseIssueBody(issue.body);
if (!submission) {
  console.log('This issue was not created by the Biota contribution form.');
  process.exit(0);
}

function run(program, args) {
  return execFileSync(program, args, {
    cwd: repoDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env
  }).trim();
}

function comment(message) {
  run('gh', ['issue', 'comment', String(issue.number), '--body', message]);
}

let prepared;
try {
  prepared = prepareSubmission(submission, issue.number, docsDirectory);
} catch (error) {
  comment(`投稿资料校验失败：${error.message}\n\n请在图鉴网页修正后重新提交。`);
  throw error;
}

const branch = `submission/issue-${issue.number}`;
const existing = JSON.parse(run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url']));
if (existing.length) {
  console.log(`Already created: ${existing[0].url}`);
  process.exit(0);
}
const remoteBranch = run('git', ['ls-remote', '--heads', 'origin', branch]);
if (remoteBranch) {
  const url = run('gh', [
    'pr', 'create', '--base', 'main', '--head', branch,
    '--title', prepared.title,
    '--body', `来自 #${issue.number} 的社区投稿。\n\n投稿者：@${issue.user.login}\n\n合并前请核对分类位置、文字内容、图片授权和资料来源。`
  ]);
  comment(`感谢投稿！资料已转换为待审核的 Pull Request：${url}`);
  console.log(url);
  process.exit(0);
}
run('git', ['config', 'user.name', 'github-actions[bot]']);
run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
run('git', ['switch', '-c', branch]);
for (const entry of prepared.entries) {
  fs.writeFileSync(path.join(docsDirectory, 'taxa', `${entry.id}.md`), entry.markdown);
}
syncIndexes(docsDirectory);
run('git', ['add', 'docs/taxa', 'docs/roots.json', 'docs/children']);
run('git', ['commit', '-m', `Add taxon from issue #${issue.number}`]);
run('git', ['push', '--set-upstream', 'origin', branch]);
const url = run('gh', [
  'pr', 'create', '--base', 'main', '--head', branch,
  '--title', prepared.title,
  '--body', `来自 #${issue.number} 的社区投稿。\n\n投稿者：@${issue.user.login}\n\n合并前请核对分类位置、文字内容、图片授权和资料来源。`
]);
comment(`感谢投稿！资料已转换为待审核的 Pull Request：${url}`);
console.log(url);
