import { eq, sql } from 'drizzle-orm'
import { bumpPrincipalsVersion } from '~/kernel/access/principal-set.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { CalendarService } from '~/modules/calendar/domain/calendar-service.js'
import { EventService } from '~/modules/calendar/domain/event-service.js'
import { ChatService } from '~/modules/chat/domain/chat-service.js'
import { GroupService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { groups, spaceMembers, spaces } from '~/shared/db/schema/index.js'
import {
  findPackObject,
  headOf,
  markPackObject,
  PACK_SPACE_KEY,
  type PackContext,
  staffOf,
} from './context.js'

/**
 * Роли предметной области (04-domain-pack-emergency.md «Роли») — группами: своих ролей
 * в платформе нет, а группа годится и в доступ, и в получатели правил и маршрутов
 * (`group:<id>`). Состав заполняется из демо-мира; на чистой установке группы пустые —
 * их наполняет администратор оргструктуры.
 */
export const PACK_GROUPS = {
  duty: {
    name: 'Дежурная смена',
    description: 'Оперативные дежурные и начальник смены: обстановка, донесения, оповещение',
  },
  hq: {
    name: 'Руководство штаба ЧС',
    description: 'Председатель, руководители оперативного управления, анализа рисков и регионов',
  },
  operators: {
    name: 'Операторы сводок регионов',
    description: 'Сотрудники региональных управлений, сдающие суточные сводки',
  },
  analysts: {
    name: 'Аналитики рисков',
    description: 'Мониторинг, прогнозирование, данные и ГИС',
  },
} as const

export type PackGroupKey = keyof typeof PACK_GROUPS

export interface PackStructure {
  spaceId: string
  groupIds: Record<PackGroupKey, string>
  channelId: string
  calendarId: string
}

/** Пространство «Оперативный штаб ЧС»: существующее по ключу или новое. */
async function ensureSpace(pack: Omit<PackContext, 'spaceId'>): Promise<string> {
  const [existing] = await db()
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.key, PACK_SPACE_KEY))
    .limit(1)
  if (existing) return existing.id
  const owner = pack.demo ? ((await headOf('HQ')) ?? pack.adminId) : pack.adminId
  return db().transaction((tx) =>
    SpaceService.create(tx, pack.ctx, {
      key: PACK_SPACE_KEY,
      name: 'Оперативный штаб ЧС',
      kind: 'team',
      description:
        'Обстановка, сообщения об опасных явлениях, суточные сводки, дежурство и заседания штаба',
      ownerId: owner,
    }),
  )
}

/** Участники демо-мира: руководство — администраторы, оперативники и аналитики — редакторы. */
async function ensureMembers(pack: Omit<PackContext, 'spaceId'>, spaceId: string): Promise<number> {
  if (!pack.demo) return 0
  const admins = (await Promise.all(['HQ', 'UO', 'UA', 'RG'].map(headOf))).filter(
    (id): id is string => Boolean(id),
  )
  const editors = await staffOf(['UO', 'UA'], { prefix: true })
  const members = [...(await staffOf(['RG'], { prefix: true })), ...(await staffOf(['UD-CANC']))]
  const roles = new Map<string, 'admin' | 'editor' | 'member'>()
  for (const id of members) roles.set(id, 'member')
  for (const id of editors) roles.set(id, 'editor')
  for (const id of admins) roles.set(id, 'admin')
  if (roles.size === 0) return 0
  await db()
    .insert(spaceMembers)
    .values([...roles].map(([userId, role]) => ({ spaceId, userId, role })))
    .onConflictDoNothing()
  return roles.size
}

/** Группы-роли пакета; состав из демо-мира задаётся только новой группе. */
async function ensureGroups(
  pack: Omit<PackContext, 'spaceId'>,
): Promise<Record<PackGroupKey, string>> {
  const members: Record<PackGroupKey, () => Promise<string[]>> = {
    duty: () => staffOf(['UO-DUTY']),
    hq: async () =>
      (await Promise.all(['HQ', 'UO', 'UA', 'RG', 'UO-DUTY'].map(headOf))).filter(
        (id): id is string => Boolean(id),
      ),
    operators: () => staffOf(['RG-'], { prefix: true }),
    analysts: () => staffOf(['UA'], { prefix: true }),
  }
  const result = {} as Record<PackGroupKey, string>
  for (const key of Object.keys(PACK_GROUPS) as PackGroupKey[]) {
    const { name, description } = PACK_GROUPS[key]
    const [existing] = await db()
      .select({ id: groups.id })
      .from(groups)
      .where(sql`lower(${groups.name}) = ${name.toLowerCase()}`)
      .limit(1)
    if (existing) {
      result[key] = existing.id
      continue
    }
    const people = pack.demo ? await members[key]() : []
    result[key] = await db().transaction(async (tx) => {
      const id = await GroupService.create(tx, name, description)
      if (people.length > 0) await GroupService.setMembers(tx, id, people)
      return id
    })
  }
  return result
}

/**
 * Календарь штаба с повторяющимися событиями: ежедневная передача дежурства и
 * еженедельное заседание штаба. Ресурсный календарь событий не принимает (ADR-0081),
 * поэтому график смен — датасет «График дежурств», а здесь — ритм работы штаба.
 */
async function ensureCalendar(
  pack: Omit<PackContext, 'spaceId'>,
  spaceId: string,
  groupIds: Record<PackGroupKey, string>,
): Promise<string> {
  const found = await findPackObject('calendar', 'calendar')
  const calendarId =
    found ??
    (await db().transaction(async (tx) => {
      const id = await CalendarService.create(tx, pack.user, {
        kind: 'team',
        title: 'Штаб ЧС',
        description: 'Передача дежурства, заседания штаба, учения',
        spaceId,
        color: 'red',
      })
      await markPackObject(tx, pack.ctx, id, 'calendar')
      return id
    }))
  const attendeesOf = async (key: PackGroupKey) => {
    if (!pack.demo) return []
    const rows = await db().execute<{ user_id: string }>(
      sql`SELECT user_id FROM group_members WHERE group_id = ${groupIds[key]}::uuid`,
    )
    return rows.map((row) => ({ userId: row.user_id, optional: false }))
  }
  // Первое повторение — со вчерашнего дня: серия видна в календаре сразу
  const start = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10)
  const monday = mondayOnOrBefore(start)
  const events = [
    {
      key: 'event.duty-handover',
      title: 'Приём-передача дежурства',
      description:
        'Доклад заступающей смене: обстановка, происшествия за сутки, сообщения об опасных явлениях, несданные сводки, исправность связи и оповещения.',
      startsAt: `${start}T08:00:00+05:00`,
      endsAt: `${start}T08:30:00+05:00`,
      rrule: 'FREQ=DAILY',
      attendees: await attendeesOf('duty'),
    },
    {
      key: 'event.hq-meeting',
      title: 'Заседание штаба ЧС',
      description:
        'Обстановка за неделю, прогноз, готовность сил и средств, исполнение поручений штаба.',
      startsAt: `${monday}T10:00:00+05:00`,
      endsAt: `${monday}T11:00:00+05:00`,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      attendees: await attendeesOf('hq'),
    },
  ]
  for (const event of events) {
    if (await findPackObject('event', event.key)) continue
    await db().transaction(async (tx) => {
      const id = await EventService.create(tx, pack.user, {
        calendarId,
        title: event.title,
        description: event.description,
        allDay: false,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: config().TZ,
        rrule: event.rrule,
        visibility: 'public',
        attendees: event.attendees,
        resourceIds: [],
        linkedObjectIds: [],
        onlineMeeting: false,
      })
      await markPackObject(tx, pack.ctx, id, event.key)
    })
  }
  return calendarId
}

/** Понедельник той же недели (или сам день, если это понедельник), `YYYY-MM-DD`. */
function mondayOnOrBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  const shift = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - shift)
  return date.toISOString().slice(0, 10)
}

export async function ensureStructure(pack: Omit<PackContext, 'spaceId'>): Promise<PackStructure> {
  const spaceId = await ensureSpace(pack)
  const members = await ensureMembers(pack, spaceId)
  const groupIds = await ensureGroups(pack)
  await bumpPrincipalsVersion()
  // Канал пространства — открытый, его видят участники штаба: сюда пишут правила пакета
  const channelId = await db().transaction((tx) =>
    ChatService.ensureSpaceChannel(tx, pack.ctx, spaceId),
  )
  const calendarId = await ensureCalendar(pack, spaceId, groupIds)
  pack.log('структура пакета ЧС готова', { members, groups: Object.keys(groupIds).length })
  return { spaceId, groupIds, channelId, calendarId }
}
