import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_NAMESPACES, hasKey, isNamespace } from '@kchs/i18n'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Неймспейсы словаря по месту показа (ADR-0191). Обход импортов от `main.tsx` — как у
 * сборщика, по объявлениям, а не по файлам целиком:
 * - оболочка (всё, что рисуется без объявления модуля, и подписи, которые оболочка берёт из
 *   объявления: `titleKey`, `labelKey`, `nav`, `useOpenHelp`, `canOpenAdmin`) — только
 *   неймспейсы оболочки, их `ru` в основном чанке;
 * - экраны, представления объектов, слои и команды палитры модуля — неймспейсы оболочки и
 *   те, что модуль объявил: `registerModule({ namespaces })`, `ModuleDefinition` или
 *   `withNamespaces([…], узел)`.
 * Ключ — строковый литерал из словаря или шаблон `неймспейс.…${…}`.
 */

const SRC = fileURLToPath(new URL('../', import.meta.url))
const CORE = new Set<string>(CORE_NAMESPACES)

// Свойства объявления модуля, которые рисует сама оболочка, а не экран модуля
const FRAME_PROPERTIES = new Set(['titleKey', 'labelKey', 'nav', 'useOpenHelp', 'canOpenAdmin'])

interface Usage {
  key: string
  where: string
}

interface ScopeRoot {
  label: string
  namespaces: ReadonlySet<string>
  file: ParsedFile
  node: ts.Node
}

interface ParsedFile {
  path: string
  source: ts.SourceFile
  imports: Map<string, { target: string | null; name: string }>
  declarations: Map<string, ts.Node[]>
  exports: Map<string, { local?: string; target?: string | null; name?: string }>
  stars: Array<string | null>
  /** Код, который исполняется при импорте: инструкции верхнего уровня и импорты ради эффекта. */
  effects: ts.Node[]
  effectImports: Array<string | null>
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('~/')) base = path.join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier)
  else return null
  const stem = base.replace(/\.js$/, '')
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const hasExport = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
const hasDefault = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)

const parsed = new Map<string, ParsedFile>()

function parse(file: string): ParsedFile {
  const cached = parsed.get(file)
  if (cached) return cached
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const result: ParsedFile = {
    path: file,
    source,
    imports: new Map(),
    declarations: new Map(),
    exports: new Map(),
    stars: [],
    effects: [],
    effectImports: [],
  }
  const declare = (name: string, node: ts.Node) =>
    result.declarations.set(name, [...(result.declarations.get(name) ?? []), node])

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const target = resolveImport(file, (statement.moduleSpecifier as ts.StringLiteral).text)
      const clause = statement.importClause
      if (!clause) result.effectImports.push(target)
      else if (!clause.isTypeOnly) {
        if (clause.name) result.imports.set(clause.name.text, { target, name: 'default' })
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings))
          result.imports.set(bindings.name.text, { target, name: '*' })
        else if (bindings)
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue
            result.imports.set(element.name.text, {
              target,
              name: (element.propertyName ?? element.name).text,
            })
          }
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const target = statement.moduleSpecifier
        ? resolveImport(file, (statement.moduleSpecifier as ts.StringLiteral).text)
        : undefined
      if (!statement.exportClause) result.stars.push(target ?? null)
      else if (ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue
          const name = (element.propertyName ?? element.name).text
          result.exports.set(
            element.name.text,
            target === undefined ? { local: name } : { target, name },
          )
        }
    } else if (ts.isExportAssignment(statement)) {
      declare('#default', statement.expression)
      result.exports.set('default', { local: '#default' })
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      const name = statement.name?.text ?? '#default'
      declare(name, statement)
      if (hasExport(statement))
        result.exports.set(hasDefault(statement) ? 'default' : name, { local: name })
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          result.effects.push(declaration)
          continue
        }
        declare(declaration.name.text, declaration)
        if (hasExport(statement))
          result.exports.set(declaration.name.text, { local: declaration.name.text })
      }
    } else if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
      result.effects.push(statement)
    }
  }
  parsed.set(file, result)
  return result
}

// ─── Объявления модулей ──────────────────────────────────────────────────────

function namespacesOf(node: ts.Expression | undefined): string[] {
  if (!node || !ts.isArrayLiteralExpression(node)) return []
  return node.elements.flatMap((element) => (ts.isStringLiteral(element) ? [element.text] : []))
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined
}

/** Литерал объявления модуля: аргумент `registerModule` или константа типа `ModuleDefinition`. */
function definitionLiteral(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'registerModule' &&
    node.arguments[0] &&
    ts.isObjectLiteralExpression(node.arguments[0])
  )
    return node.arguments[0]
  if (
    ts.isVariableDeclaration(node) &&
    node.type &&
    ts.isTypeReferenceNode(node.type) &&
    node.type.typeName.getText() === 'ModuleDefinition' &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer)
  )
    return node.initializer
  return undefined
}

/** `withNamespaces(['…'], узел)`: узел показывается с этими неймспейсами. */
function gateCall(node: ts.Node): ts.CallExpression | undefined {
  return ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'withNamespaces'
    ? node
    : undefined
}

// ─── Обход ───────────────────────────────────────────────────────────────────

const where = (file: ParsedFile, node: ts.Node) =>
  `${path.relative(SRC, file.path)}:${file.source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`

class Scope {
  readonly usages: Usage[] = []
  private readonly seenNodes = new Set<ts.Node>()
  private readonly seenExports = new Set<string>()
  private readonly seenFiles = new Set<string>()

  constructor(
    readonly label: string,
    readonly namespaces: ReadonlySet<string>,
    private readonly queue: ScopeRoot[],
    private readonly frame: (file: ParsedFile, node: ts.Node) => void,
  ) {}

  walk(file: ParsedFile, node: ts.Node): void {
    // Типы не исполняются: `typeof Экран` в аннотации — не показ экрана
    if (this.seenNodes.has(node) || ts.isTypeNode(node)) return
    this.seenNodes.add(node)
    const literal = definitionLiteral(node)
    if (literal) {
      this.definition(file, literal)
      return
    }
    const gate = gateCall(node)
    if (gate) {
      const own = namespacesOf(gate.arguments[0])
      for (const argument of gate.arguments.slice(1))
        this.queue.push({
          label: `withNamespaces ${where(file, gate)}`,
          namespaces: new Set([...this.namespaces, ...own]),
          file,
          node: argument,
        })
      return
    }
    this.inspect(file, node)
    ts.forEachChild(node, (child) => this.walk(file, child))
  }

  /** Объявление модуля: подписи оболочки — в оболочку, остальное — в свою область. */
  private definition(file: ParsedFile, literal: ts.ObjectLiteralExpression): void {
    const namespaces = new Set([
      ...this.namespaces,
      ...namespacesOf(
        literal.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && propertyName(property) === 'namespaces',
        )?.initializer,
      ),
    ])
    const label = `модуль ${where(file, literal)}`
    const split = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          const name = propertyName(property)
          if (name === 'namespaces' || name === 'key') continue
          if (name && FRAME_PROPERTIES.has(name)) this.frame(file, property)
          else if (ts.isPropertyAssignment(property)) split(property.initializer)
          else this.queue.push({ label, namespaces, file, node: property })
        }
      } else if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) split(element)
      } else this.queue.push({ label, namespaces, file, node })
    }
    split(literal)
  }

  private inspect(file: ParsedFile, node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text
      const prefix = /^([A-Za-z]+)\.(?:[A-Za-z0-9_]+\.)*$/.exec(text)
      if (hasKey(text) || (prefix?.[1] && isNamespace(prefix[1])))
        this.usages.push({ key: text, where: where(file, node) })
    } else if (ts.isTemplateExpression(node)) {
      const head = /^([A-Za-z]+)\./.exec(node.head.text)
      if (head?.[1] && isNamespace(head[1]))
        this.usages.push({ key: `${node.head.text}…`, where: where(file, node) })
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      this.file(resolveImport(file.path, node.arguments[0].text))
    } else if (ts.isIdentifier(node) && isReference(node)) {
      this.reference(file, node.text)
    }
  }

  private reference(file: ParsedFile, name: string): void {
    const local = file.declarations.get(name)
    if (local) for (const declaration of local) this.walk(file, declaration)
    const imported = file.imports.get(name)
    if (imported) this.exported(imported.target, imported.name)
  }

  private exported(target: string | null | undefined, name: string): void {
    if (!target) return
    if (name === '*') {
      this.file(target)
      return
    }
    const id = `${target}#${name}`
    if (this.seenExports.has(id)) return
    this.seenExports.add(id)
    const file = parse(target)
    this.effects(file)
    const entry = file.exports.get(name)
    if (entry?.local) this.reference(file, entry.local)
    else if (entry) this.exported(entry.target, entry.name ?? name)
    else for (const star of file.stars) this.exported(star, name)
  }

  private effects(file: ParsedFile): void {
    if (this.seenFiles.has(`effects:${file.path}`)) return
    this.seenFiles.add(`effects:${file.path}`)
    for (const statement of file.effects) this.walk(file, statement)
    for (const target of file.effectImports) this.file(target)
  }

  /** Модуль целиком: точка входа, динамический импорт, `import * as`. */
  file(target: string | null | undefined): void {
    if (!target || this.seenFiles.has(target)) return
    this.seenFiles.add(target)
    const file = parse(target)
    this.effects(file)
    for (const [name] of file.exports) this.exported(target, name)
    for (const star of file.stars) if (star) this.file(star)
  }

  missing(): Map<string, Usage[]> {
    const out = new Map<string, Usage[]>()
    for (const usage of this.usages) {
      const namespace = usage.key.split('.')[0] ?? ''
      if (CORE.has(namespace) || this.namespaces.has(namespace)) continue
      out.set(namespace, [...(out.get(namespace) ?? []), usage])
    }
    return out
  }
}

/** Идентификатор-ссылка, а не имя свойства, атрибута или типа. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  if (ts.isJsxAttribute(parent) && parent.name === node) return false
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false
  return true
}

function analyse(): Array<{ label: string; missing: Map<string, Usage[]> }> {
  const queue: ScopeRoot[] = []
  const frameRoots: Array<{ file: ParsedFile; node: ts.Node }> = []
  const frame = new Scope('оболочка', new Set(), queue, (file, node) =>
    frameRoots.push({ file, node }),
  )
  frame.file(path.join(SRC, 'main.tsx'))

  const scopes: Scope[] = [frame]
  // Области модулей находятся по ходу обхода и сами находят вложенные
  while (queue.length > 0 || frameRoots.length > 0) {
    for (const root of frameRoots.splice(0)) frame.walk(root.file, root.node)
    const root = queue.shift()
    if (!root) continue
    let scope = scopes.find(
      (item) =>
        item.label === root.label &&
        [...item.namespaces].sort().join() === [...root.namespaces].sort().join(),
    )
    if (!scope) {
      scope = new Scope(root.label, root.namespaces, queue, (file, node) =>
        frameRoots.push({ file, node }),
      )
      scopes.push(scope)
    }
    scope.walk(root.file, root.node)
  }
  return scopes.map((scope) => ({ label: scope.label, missing: scope.missing() }))
}

describe('неймспейсы словаря по месту показа (ADR-0191)', () => {
  const results = analyse()

  it('обход находит оболочку и объявления модулей', () => {
    expect(results.length).toBeGreaterThan(20)
  })

  it.each(results.map((result) => [result.label, result.missing] as const))(
    '%s: ключи только из объявленных неймспейсов и неймспейсов оболочки',
    (_label, missing) => {
      const report = [...missing].map(
        ([namespace, usages]) =>
          `«${namespace}» не объявлен: ${usages
            .slice(0, 3)
            .map((usage) => `${usage.key} (${usage.where})`)
            .join(', ')}${usages.length > 3 ? ` и ещё ${usages.length - 3}` : ''}`,
      )
      expect(report).toEqual([])
    },
  )
})
