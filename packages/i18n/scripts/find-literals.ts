/**
 * Тексты интерфейса — только через словари (CLAUDE.md, правило 6).
 * Скрипт ищет в исходниках клиента и дизайн-системы строки и JSX-текст
 * с кириллицей, которые не прошли через `t()`. Комментарии не учитываются —
 * разбор выполняет компилятор TypeScript.
 *
 * Исключение для осознанных случаев: комментарий `i18n-ignore` на строке
 * перед литералом или на той же строке.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')

const SCAN = ['apps/web/src', 'packages/ui/src']
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'stories'])
const CYRILLIC = /[А-Яа-яЁё]/

interface Finding {
  file: string
  line: number
  text: string
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec|stories)\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function ignored(source: ts.SourceFile, node: ts.Node, lines: string[]): boolean {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
  return Boolean(lines[line]?.includes('i18n-ignore') || lines[line - 1]?.includes('i18n-ignore'))
}

function scan(file: string): Finding[] {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings: Finding[] = []

  const visit = (node: ts.Node): void => {
    let literal: string | null = null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // Пути модулей не являются текстами интерфейса
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        literal = node.text
      }
    } else if (ts.isTemplateExpression(node)) {
      literal = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('…')
    } else if (ts.isJsxText(node)) {
      literal = node.text.trim()
    }

    if (literal && CYRILLIC.test(literal) && !ignored(source, node, lines)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      findings.push({ file: path.relative(root, file), line: line + 1, text: literal.slice(0, 80) })
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings
}

const findings = SCAN.flatMap((dir) => sourceFiles(path.join(root, dir))).flatMap(scan)

if (findings.length === 0) {
  process.stdout.write('Тексты интерфейса: все строки проходят через словари\n')
  process.exit(0)
}

for (const f of findings) process.stdout.write(`${f.file}:${f.line}  ${f.text}\n`)
process.stdout.write(`\nНайдено строк мимо словарей: ${findings.length}\n`)
process.exit(1)
