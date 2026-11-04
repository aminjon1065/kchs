import type { EventRecord } from '@kchs/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { keys } from '~/shared/api/queries.js'
import { meFixture, renderWithClient, stubApi, testQueryClient } from '~/test/render.js'
import { EventDetails } from './event-details.js'

/**
 * Ответ на приглашение (ADR-0229): у повторяющейся встречи можно ответить на одно
 * повторение — «не смогу в этот четверг»; по умолчанию ответ — на всю серию.
 */
const ID = '00000000-0000-4000-8000-0000000000e1'
const SECOND = '2026-11-20T11:00:00.000Z'

function record(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: ID,
    calendar: {
      id: '00000000-0000-4000-8000-0000000000c1',
      title: 'Личный',
      kind: 'personal',
      color: 'blue',
    },
    busy: false,
    title: 'Совещание отдела',
    description: null,
    location: null,
    allDay: false,
    startsAt: '2026-11-13T11:00:00.000Z',
    endsAt: '2026-11-13T11:30:00.000Z',
    startDate: null,
    endDate: null,
    timezone: 'Asia/Dushanbe',
    rrule: 'FREQ=WEEKLY;BYDAY=FR;COUNT=4',
    exdates: [],
    visibility: 'public',
    showAs: 'busy',
    color: null,
    organizer: null,
    attendees: [],
    resources: [],
    reminders: [],
    myReminders: null,
    myStatus: 'accepted',
    linkedObjects: [],
    meetingId: null,
    source: 'local',
    seriesId: null,
    occurrence: {
      recurrenceId: SECOND,
      startsAt: SECOND,
      endsAt: '2026-11-20T11:30:00.000Z',
      startDate: null,
      endDate: null,
      overridden: false,
    },
    can: { edit: false, respond: true, cancel: false, manage: false },
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as EventRecord
}

function renderDetails(value: EventRecord) {
  const me = meFixture()
  const calls = stubApi({ '/me': me, [`POST /events/${ID}/respond`]: {} })
  const client = testQueryClient()
  client.setQueryData(keys.me, me)
  renderWithClient(<EventDetails record={value} />, client)
  return calls
}

const responds = (calls: ReturnType<typeof stubApi>) =>
  calls.filter((call) => call.method === 'POST' && call.path === `/events/${ID}/respond`)

describe('EventDetails: ответ на повторение', () => {
  it('по умолчанию ответ — на серию; с флажком — на это повторение', async () => {
    const user = userEvent.setup()
    const calls = renderDetails(record())
    await user.click(screen.getByRole('button', { name: 'Нет' }))
    await waitFor(() => expect(responds(calls)).toHaveLength(1))
    expect(responds(calls)[0]?.body).toEqual({ status: 'declined' })

    await user.click(screen.getByRole('checkbox', { name: 'Ответ только на это повторение' }))
    await user.click(screen.getByRole('button', { name: 'Нет' }))
    await waitFor(() => expect(responds(calls)).toHaveLength(2))
    expect(responds(calls)[1]?.body).toEqual({ status: 'declined', recurrenceId: SECOND })
  })

  it('у неповторяющейся встречи флажка нет', () => {
    renderDetails(record({ rrule: null, occurrence: null }))
    expect(screen.queryByRole('checkbox', { name: 'Ответ только на это повторение' })).toBeNull()
  })
})
