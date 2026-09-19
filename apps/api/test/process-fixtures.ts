import { sql } from 'drizzle-orm'
import { expect } from 'vitest'
import { call, createUser, db, type TestContext, type TestUser } from './helpers.js'

/**
 * Общее для интеграционных тестов движка процессов (ADR-0079): тестовый тип
 * объекта с поставщиком данных и поддельными исполнителями шагов модуля,
 * оргструктура для назначений, публикация определений через API.
 */
const { objectType, registerObjectType } = await import('../src/kernel/objects/registry.js')
const { ObjectService } = await import('../src/kernel/objects/service.js')
const { authorize } = await import('../src/kernel/access/authorize.js')
const processes = await import('../src/kernel/process/index.js')
const { OrgService } = await import('../src/modules/identity/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { objects } = await import('../src/shared/db/schema/index.js')

/**
 * Тип объекта «тестовый документ» (маршруты запускаются и из API): ответы API
 * проверяют тип по перечню контрактов, поэтому берётся первый тип перечня, ещё
 * не занятый модулями (типы будущих фаз).
 */
const CANDIDATES = ['protocol', 'recording', 'meeting', 'webhook', 'integration', 'rule']
let testType = ''

export function TEST_TYPE(): string {
  if (!testType) throw new Error('registerTestModule() ещё не вызван')
  return testType
}

export interface ProcessPeople {
  author: TestUser
  boss: TestUser
  chief: TestUser
  a1: TestUser
  a2: TestUser
  a3: TestUser
  signer: TestUser
  registrar: TestUser
  deputy: TestUser
}

/** Вызовы хуков и исполнителей модуля — для проверок. */
export const moduleCalls: {
  activated: string[]
  completed: string[]
  decisions: Array<{ step: string; action: string; userId: string; actorId: string }>
  finished: Array<{ status: string; outcome: string }>
  registered: string[]
  tasks: Array<{ stepId: string; assignees: string[]; dueAt: string | null }>
  calls: Array<{ action: string; params: Record<string, unknown> }>
  cancelled: string[]
} = {
  activated: [],
  completed: [],
  decisions: [],
  finished: [],
  registered: [],
  tasks: [],
  calls: [],
  cancelled: [],
}

let registered = false
let registrations = 0

/** Регистрация тестового типа, поставщика и исполнителей — один раз на файл тестов. */
export function registerTestModule(): void {
  if (registered) return
  registered = true
  const free = CANDIDATES.find((candidate) => !objectType(candidate))
  if (!free) throw new Error('Нет свободного типа объекта для тестов маршрутов')
  testType = free
  registerObjectType({
    type: testType as never,
    labelKey: 'objects.types.document',
    icon: 'file-text',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
    },
    policy: processes.withProcessParticipants(undefined, { afterStep: 'view' }),
    discussable: true,
    linkable: true,
    hasParentTree: false,
  })
  processes.registerProcessObjectProvider({
    objectType: testType,
    load: async (executor, objectId) => {
      const [row] = await executor
        .select({
          createdBy: objects.createdBy,
          spaceId: objects.spaceId,
          title: objects.title,
          meta: objects.meta,
        })
        .from(objects)
        .where(sql`${objects.id} = ${objectId}`)
        .limit(1)
      if (!row) return null
      return {
        authorId: row.createdBy,
        spaceId: row.spaceId,
        title: row.title,
        fields: row.meta,
        props: { typeKey: 'letter' },
      }
    },
    fieldHints: async () => [
      { path: 'amount', label: { ru: 'Сумма', en: 'Amount' }, type: 'money' },
      { path: 'signer', label: { ru: 'Подписант', en: 'Signer' }, type: 'user' },
    ],
    setField: async (tx, ctx, objectId, field, value) => {
      await ObjectService.update(tx, ctx, objectId, { meta: { [field]: value }, mergeMeta: true })
    },
    canStart: async (ctx, objectId) => {
      await authorize(ctx, 'edit', objectId)
    },
    onStepActivated: async (_tx, _ctx, { step }) => {
      moduleCalls.activated.push(step.key)
    },
    onStepCompleted: async (_tx, _ctx, { step }) => {
      moduleCalls.completed.push(`${step.key}:${step.outcome}`)
    },
    onDecision: async (_tx, _ctx, { step, decision }) => {
      moduleCalls.decisions.push({
        step: step.key,
        action: decision.action,
        userId: decision.userId,
        actorId: decision.actorId,
      })
    },
    onFinished: async (_tx, _ctx, { status, outcome }) => {
      moduleCalls.finished.push({ status, outcome })
    },
  })
  processes.registerProcessStepHandler({
    type: 'register',
    objectType: testType,
    execute: async (_tx, _ctx, { step }) => {
      registrations += 1
      moduleCalls.registered.push(step.key)
      return { outcome: 'registered', result: { number: `ИСХ-${registrations}/26` } }
    },
  })
  processes.registerProcessStepHandler({
    type: 'task',
    execute: async (_tx, _ctx, { step }) => {
      moduleCalls.tasks.push({ stepId: step.id, assignees: step.assignees, dueAt: step.dueAt })
      return 'wait'
    },
    cancel: async (_tx, _ctx, { step }) => {
      moduleCalls.cancelled.push(step.key)
    },
  })
  processes.registerProcessStepHandler({
    type: 'call',
    action: 'test.dispatch',
    execute: async (_tx, _ctx, { params }) => {
      moduleCalls.calls.push({ action: 'test.dispatch', params })
      return { outcome: 'sent', result: { channel: params.channel ?? null } }
    },
  })
}

/**
 * Люди маршрутов: автор — участник пространства (редактор) из подразделения
 * TEST; глава подразделения — boss, его руководитель — chief (глава
 * родительского подразделения); согласующие a1–a3 и подписант — в том же
 * подразделении, но не в пространстве: объект видят только как участники.
 */
export async function createPeople(fx: TestContext, run: string): Promise<ProcessPeople> {
  const ctx = systemCtx('test')
  const parent = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: `PARENT-${run}`,
      name: { ru: 'Управление' },
      kind: 'department',
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  await db().transaction((tx) => OrgService.updateUnit(tx, ctx, fx.unitId, { parentId: parent }))
  const make = (name: string, roles: string[] = ['employee'], unitId: string | null = fx.unitId) =>
    createUser(fx.app, `${name}_${run}`, roles, unitId ?? undefined)
  const people: ProcessPeople = {
    author: fx.users.member,
    boss: await make('boss'),
    chief: await make('chief', ['employee'], parent),
    a1: await make('appr1'),
    a2: await make('appr2'),
    a3: await make('appr3'),
    signer: await make('signer'),
    registrar: await make('registrar', ['registrar'], null),
    deputy: await make('deputy'),
  }
  await db().transaction(async (tx) => {
    await OrgService.updateUnit(tx, ctx, fx.unitId, { headUserId: people.boss.id })
    await OrgService.updateUnit(tx, ctx, parent, { headUserId: people.chief.id })
  })
  return people
}

/** Тестовый документ автора в пространстве фикстуры. */
export async function createDocument(
  fx: TestContext,
  author: TestUser,
  title: string,
  meta: Record<string, unknown> = {},
): Promise<string> {
  const object = await db().transaction((tx) =>
    ObjectService.create(tx, systemCtx('test', { initiatorId: author.id }), {
      type: TEST_TYPE() as never,
      spaceId: fx.spaceId,
      title,
      ownerId: author.id,
      meta,
    }),
  )
  return object.id
}

/** Черновик и публикация через API администратора маршрутов. */
export async function publishDefinition(
  fx: TestContext,
  definition: Record<string, unknown>,
): Promise<void> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/process-definitions',
    as: fx.admin,
    payload: { definition },
  })
  expect(created.statusCode, created.body).toBe(200)
  const published = await call(fx.app, {
    method: 'POST',
    url: `/process-definitions/${definition.key as string}/publish`,
    as: fx.admin,
  })
  expect(published.statusCode, published.body).toBe(200)
}

export async function startProcess(
  fx: TestContext,
  as: TestUser,
  input: Record<string, unknown>,
): Promise<string> {
  const response = await call(fx.app, { method: 'POST', url: '/processes', as, payload: input })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
export async function route(fx: TestContext, as: TestUser, id: string): Promise<any> {
  const response = await call(fx.app, { url: `/processes/${id}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

export interface InboxEntry {
  id: string
  kind: string
  processStepId: string | null
  dueAt: string | null
  onBehalfOf: { id: string } | null
  actions: Array<{ key: string; requiresComment: boolean; requiresSecondFactor?: boolean }>
  object: { id: string } | null
}

export async function inboxOf(
  fx: TestContext,
  user: TestUser,
  objectId: string,
): Promise<InboxEntry[]> {
  const response = await call(fx.app, { url: '/inbox?state=open', as: user })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().items as InboxEntry[]).filter((item) => item.object?.id === objectId)
}

export async function actInbox(
  fx: TestContext,
  user: TestUser,
  itemId: string,
  action: string,
  extra: { comment?: string; payload?: Record<string, unknown> } = {},
) {
  return call(fx.app, {
    method: 'POST',
    url: `/inbox/${itemId}/act`,
    as: user,
    payload: { action, ...extra },
  })
}

/** Активный шаг маршрута по ключу. */
// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
export function activeStep(view: any, key: string): any {
  // biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
  const step = view.steps.find((item: any) => item.key === key && item.status === 'active')
  expect(step, `шаг ${key} активен`).toBeTruthy()
  return step
}
