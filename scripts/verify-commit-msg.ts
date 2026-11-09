/**
 * Conventional Commits message verifier for lefthook commit-msg.
 *
 * Accepts: `type(scope): subject` or `type: subject`.
 * @param msg - the commit message file path (lefthook passes {1}).
 */
import { readFileSync } from 'node:fs'

const filePath = process.argv[2]
if (filePath === undefined) {
  console.error('verify-commit-msg: missing commit message file argument')
  process.exit(1)
}

const content = readFileSync(filePath, 'utf8')
const firstLine = content.split('\n')[0] ?? ''

const PATTERN = /^(feat|fix|docs|style|refactor|test|chore|build|ci|perf|revert)(\(.+\))?: .{1,100}/

if (!PATTERN.test(firstLine)) {
  console.error(
    `commit message must match Conventional Commits format:\n`
    + `  type(scope): subject\n\n`
    + `  types: feat, fix, docs, style, refactor, test, chore, build, ci, perf, revert\n`
    + `  got: ${firstLine}`,
  )
  process.exit(1)
}
