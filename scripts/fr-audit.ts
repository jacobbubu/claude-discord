#!/usr/bin/env bun
/**
 * fr-audit.ts — generate _bmad-output/fr-audit.md from PRD §11 FR table.
 *
 * Goal: turn 73 FRs into a checklist with first-pass auto-evidence so the
 * human-driven verification step has a starting point. Status defaults are
 * heuristic (based on grep hit counts), reviewer must verify and amend.
 *
 * Heuristic (per FR):
 *   - For each Epic, search domain = src files relevant to that epic
 *   - Extract keyword shortlist from Story column (CJK-friendly)
 *   - For each keyword, grep src + tests for occurrences
 *   - Tally hit counts: src_hits, test_hits
 *   - Auto-status:
 *     - test_hits > 0 → ✅ (has implementation + test)
 *     - src_hits > 0 → 🟡 (implemented, no direct test match)
 *     - 0 hits → ❓ (cannot auto-locate; reviewer must check)
 *
 * Usage:
 *   bun run scripts/fr-audit.ts
 *   → writes _bmad-output/fr-audit.md
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const PRD = join(REPO, '_bmad-output/planning-artifacts/prd.md')
const OUT = join(REPO, '_bmad-output/fr-audit.md')

type FR = {
  id: string
  story: string
  criteria: string
  priority: string
  epic: string
}

function parsePrd(text: string): FR[] {
  // Find "## 11. Functional Requirements" up to next "## 12."
  const start = text.indexOf('## 11.')
  const end = text.indexOf('## 12.', start)
  if (start < 0 || end < 0) throw new Error('PRD §11 boundaries not found')
  const section = text.slice(start, end)

  const frs: FR[] = []
  let currentEpic = ''
  for (const line of section.split('\n')) {
    const epicMatch = line.match(/^### (Epic \d+:.+)$/)
    if (epicMatch) {
      currentEpic = epicMatch[1]!
      continue
    }
    // Match table rows: | FR-X.Y | story | criteria | P0 |
    // Priority column may be "P0" / "P1" / "P2" / "P2 (day-2)" etc.
    const m = line.match(/^\|\s*(FR-[\d.]+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(P\d[^|]*?)\s*\|/)
    if (m) {
      frs.push({ id: m[1]!, story: m[2]!, criteria: m[3]!, priority: m[4]!, epic: currentEpic })
    }
  }
  return frs
}

function epicSearchDomain(epic: string): string[] {
  // Return file glob roots for grep, based on Epic membership.
  if (/Epic 1/i.test(epic)) return ['src/daemon/index.ts', 'src/cli', 'src/shared']
  if (/Epic 2/i.test(epic)) return ['src/plugin']
  if (/Epic 3/i.test(epic)) return ['src/daemon/routing.ts', 'src/daemon/registry.ts', 'src/daemon/inbound-router.ts', 'src/daemon/discord-gateway.ts']
  if (/Epic 4/i.test(epic)) return ['src/daemon/slash-commands.ts']
  if (/Epic 5/i.test(epic)) return ['src/daemon/access-control.ts', 'src/daemon/permission-relay.ts', 'src/cli/access-mutate.ts']
  if (/Epic 6/i.test(epic)) return ['src/daemon/tool-handlers.ts', 'src/protocol']
  if (/Epic 7/i.test(epic)) return ['src/cli/install.ts', 'src/cli/install-plan.ts', 'src/cli/index.ts']
  // Fallback: scan everything
  return ['src']
}

const STOPWORDS = new Set([
  'daemon', 'plugin', 'CC', 'workspace', 'channel', '当前', '触发', '通过', '使用',
  '一个', '一次', '一条', '消息', '配置', '默认', '启动', '需要', '用于', '不会',
])

function extractKeywords(story: string): string[] {
  // Naive: split on punctuation/whitespace, take CJK words and ascii identifiers
  const tokens: string[] = []
  for (const m of story.matchAll(/[一-鿿]{2,}|[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
    const t = m[0]
    if (STOPWORDS.has(t)) continue
    if (t.length < 2) continue
    tokens.push(t)
  }
  // Dedupe
  return Array.from(new Set(tokens)).slice(0, 6)
}

type GrepResult = { keyword: string; srcHits: number; testHits: number; topFile: string | null }

function listFiles(root: string): string[] {
  const abs = join(REPO, root)
  let st
  try {
    st = statSync(abs)
  } catch {
    return []
  }
  if (!st.isDirectory()) return [abs]
  const out: string[] = []
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(abs, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...listFiles(join(root, entry)))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function grepKeyword(keyword: string, files: string[], isTestFn: (path: string) => boolean): { srcHits: number; testHits: number; topFile: string | null } {
  let srcHits = 0
  let testHits = 0
  let topFile: string | null = null
  let topCount = 0
  for (const f of files) {
    const content = readFileSync(f, 'utf8')
    const idx = content.split(keyword).length - 1
    if (idx > 0) {
      if (isTestFn(f)) testHits += idx
      else srcHits += idx
      if (idx > topCount) {
        topCount = idx
        topFile = f.replace(REPO + '/', '')
      }
    }
  }
  return { srcHits, testHits, topFile }
}

function isTest(path: string): boolean {
  return path.includes('__tests__') || path.includes('.test.ts') || path.includes('/tests/')
}

function autoStatus(results: GrepResult[]): { status: string; rationale: string } {
  const totalSrc = results.reduce((a, r) => a + r.srcHits, 0)
  const totalTest = results.reduce((a, r) => a + r.testHits, 0)
  // Require at least 2 distinct keywords with test hits before claiming ✅,
  // and a non-trivial total src signal. Generic keywords like "register" or
  // "version" leak into unrelated test files and would over-tag ✅ otherwise.
  const kwsWithTest = results.filter(r => r.testHits > 0).length
  if (kwsWithTest >= 2 && totalSrc >= 3) {
    return { status: '✅', rationale: `${kwsWithTest} kw with tests, ${totalSrc} src + ${totalTest} test hits` }
  }
  if (totalSrc > 0) return { status: '🟡', rationale: `${totalSrc} src hits, weak test signal (${kwsWithTest} kw)` }
  return { status: '❓', rationale: '0 hits — manual check needed' }
}

const allTestFiles = listFiles('src').filter(isTest)
const allCodeFiles = listFiles('src')

const prdText = readFileSync(PRD, 'utf8')
const frs = parsePrd(prdText)
console.error(`fr-audit: parsed ${frs.length} FRs`)

const lines: string[] = []
lines.push('# FR audit — PRD §11 73 条 FR × main 当前实现')
lines.push('')
lines.push('> 自动生成。状态列基于 grep 命中数的 heuristic（test_hits>0 → ✅，src_hits>0 → 🟡，0 → ❓）；')
lines.push('> reviewer 必须二次核对，不可只信脚本。运行：`bun run scripts/fr-audit.ts`')
lines.push('')

let currentEpic = ''
for (const fr of frs) {
  if (fr.epic !== currentEpic) {
    currentEpic = fr.epic
    lines.push(`## ${currentEpic}`)
    lines.push('')
    lines.push('| ID | 优先级 | 状态 | 证据 (top file, hit counts) | Story |')
    lines.push('|---|---|---|---|---|')
  }
  const keywords = Array.from(new Set([
    ...extractKeywords(fr.story),
    ...extractKeywords(fr.criteria),
  ])).slice(0, 10)
  const domain = epicSearchDomain(fr.epic)
  // Restrict files to domain when domain is non-trivial; else use all code.
  const domainFiles = domain.length === 1 && domain[0] === 'src'
    ? allCodeFiles
    : allCodeFiles.filter(f => domain.some(d => f.includes(d.replace('src/', 'src/'))))
  const results: GrepResult[] = keywords.map(k => ({ keyword: k, ...grepKeyword(k, domainFiles, isTest) }))
  // Tests are searched across all test files regardless of domain.
  for (const r of results) {
    const t = grepKeyword(r.keyword, allTestFiles, () => true)
    r.testHits = t.testHits
  }
  let { status, rationale } = autoStatus(results)
  // If domain has code but no story keywords matched, default to 🟡
  // (epic is implemented; story-level keywords just don't appear in CN).
  if (status === '❓' && domainFiles.length > 0) {
    status = '🟡'
    rationale = `domain has ${domainFiles.length} files but story keywords don't match — manual check`
  }
  const topFile = results.find(r => r.topFile)?.topFile ?? '—'
  const evidence = `\`${topFile}\` (${rationale})`
  // Trim story to keep table reading width manageable.
  const shortStory = fr.story.length > 60 ? fr.story.slice(0, 57) + '…' : fr.story
  lines.push(`| ${fr.id} | ${fr.priority} | ${status} | ${evidence} | ${shortStory} |`)
}

writeFileSync(OUT, lines.join('\n') + '\n')
console.error(`fr-audit: wrote ${OUT}`)
