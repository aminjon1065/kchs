#!/usr/bin/env node
/**
 * Аудит изменения пишется в транзакции изменения (ADR-0216, ADR-0177): `audit(ctx, input, tx)`.
 * Запись вне транзакции либо пропадает при сбое после фиксации изменения, либо остаётся
 * у изменения, которое откатилось. Без `tx` допустимы только записи, у которых нет
 * изменения базы в паре, — каждая перечислена ниже с причиной:
 *
 * - `read` — чтение, выгрузка или скачивание: состояние базы не меняется;
 * - `denial` — отказ (неудачный вход, токен или вебхук не принят): запись нужна именно
 *   тогда, когда изменения нет;
 * - `request` — журнал запроса в режиме администратора: пишется после ответа, у запроса
 *   своя транзакция;
 * - `external` — состояние вне Postgres (Redis, очередь сбоев, внешняя служба): общей
 *   транзакции с ним нет;
 * - `summary` — сводная запись после множества транзакций (импорт сотрудников: у каждой
 *   учётной записи — свой аудит в своей транзакции).
 *
 * Ключ исключения — `файл#функция#действие`. Исключение, которого больше нет в коде,
 * тоже ошибка: список не копит мёртвых записей.
 *
 *   node scripts/audit-tx.mjs     проверка (часть `pnpm deps:check`)
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(API, 'src')

/** @type {Record<string, 'read' | 'denial' | 'request' | 'external' | 'summary'>} */
const WITHOUT_TX = {
  'kernel/access/admin-mode.ts#auditAdminModeRequest#AUDIT_ACTIONS.adminModeAction': 'request',
  'kernel/access/authorize.ts#auditGrif#AUDIT_ACTIONS.confidentialAccess': 'read',
  'kernel/access/http.ts#handler#AUDIT_ACTIONS.shareLinkOpened': 'read',
  'kernel/events/http.ts#handler#AUDIT_ACTIONS.eventsDlqRetried': 'external',
  'modules/admin/module.ts#handler#AUDIT_ACTIONS.auditExported': 'read',
  "modules/ai/domain/service.ts#record#'ai.request'": 'external',
  'modules/automation/domain/rule-service.ts#exportRule#AUTOMATION_AUDIT.ruleExported': 'read',
  'modules/data/domain/export-service.ts#run#DATA_AUDIT.datasetExported': 'read',
  'modules/data/domain/query-export.ts#export#DATA_AUDIT.queryExported': 'read',
  'modules/documents/domain/bulk-service.ts#registry#DOCUMENTS_AUDIT.documentsRegistryExported':
    'read',
  'modules/files/module.ts#handler#FILES_AUDIT.fileDownloaded': 'read',
  'modules/identity/domain/auth-service.ts#login#AUDIT_ACTIONS.loginFailed': 'denial',
  'modules/identity/domain/oidc.ts#callback#AUDIT_ACTIONS.loginFailed': 'denial',
  'modules/identity/domain/oidc.ts#resolveUser#AUDIT_ACTIONS.loginFailed': 'denial',
  'modules/identity/domain/oidc.ts#assertActive#AUDIT_ACTIONS.loginFailed': 'denial',
  'modules/identity/domain/passkeys.ts#login#AUDIT_ACTIONS.loginFailed': 'denial',
  'modules/identity/domain/users-import.ts#run#AUDIT_ACTIONS.usersImported': 'summary',
  'modules/identity/domain/users-import.ts#reportCsv#AUDIT_ACTIONS.usersImportReportDownloaded':
    'read',
  'modules/identity/domain/users-import.ts#takeCredentials#AUDIT_ACTIONS.usersImportCredentialsDownloaded':
    'external',
  'modules/integrations/domain/config-package.ts#exportPackage#INTEGRATIONS_AUDIT.configExported':
    'read',
  'modules/integrations/domain/inbound.ts#receiveInbound#INTEGRATIONS_AUDIT.webhookReceived':
    'denial',
  'modules/integrations/domain/integration-service.ts#checkBuiltin#INTEGRATIONS_AUDIT.integrationChecked':
    'external',
  'modules/integrations/domain/token-auth.ts#authenticateApiToken#INTEGRATIONS_AUDIT.apiTokenRejected':
    'denial',
  'modules/integrations/domain/token-auth.ts#enforceTokenScope#INTEGRATIONS_AUDIT.apiTokenScopeDenied':
    'denial',
  'modules/reports/domain/run-service.ts#download#REPORTS_AUDIT.reportDownloaded': 'read',
  'modules/tasks/domain/control-export.ts#auditExport#TASKS_AUDIT.controlExported': 'read',
}

/** Исходники `.ts` под каталогом, кроме тестов. */
function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** Имя функции, внутри которой стоит вызов: объявление, метод, свойство или переменная. */
function enclosingName(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) {
      return parent.name.getText()
    }
    if (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) {
      return parent.name.getText()
    }
  }
  return '?'
}

/** Выражение `action` во втором аргументе — как оно записано в коде. */
function actionOf(call) {
  const input = call.arguments[1]
  if (!input || !ts.isObjectLiteralExpression(input)) return '?'
  for (const property of input.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === 'action') {
      return property.initializer.getText()
    }
  }
  return '?'
}

const found = new Map()
for (const file of sources(SRC)) {
  const text = readFileSync(file, 'utf8')
  if (!/\baudit\(/.test(text)) continue
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const name = path.relative(SRC, file).split(path.sep).join('/')
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'audit' &&
      node.arguments.length < 3
    ) {
      const key = `${name}#${enclosingName(node)}#${actionOf(node)}`
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      found.set(key, [...(found.get(key) ?? []), `${name}:${line}`])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const problems = []
for (const [key, places] of found) {
  if (!WITHOUT_TX[key]) {
    problems.push(
      `аудит без транзакции изменения: ${places.join(', ')} (${key}) — передайте tx или впишите причину в WITHOUT_TX`,
    )
  }
}
for (const key of Object.keys(WITHOUT_TX)) {
  if (!found.has(key)) problems.push(`исключение без вызова — уберите из WITHOUT_TX: ${key}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}
const total = [...found.values()].reduce((sum, places) => sum + places.length, 0)
console.log(
  `✔ аудит изменений — в транзакции изменения (без tx: ${total} записей чтения, отказов и внешнего состояния)`,
)
