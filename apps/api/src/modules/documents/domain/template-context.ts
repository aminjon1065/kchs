import type { CorrespondentRecord, UserProfile, UserRef } from '@kchs/contracts'
import { formatDate, formatValue } from '@kchs/fields'
import { createTranslator } from '@kchs/i18n'
import { UserService } from '~/modules/identity/public.js'
import type { UserCtx } from '~/shared/context.js'
import { CorrespondentService } from './correspondent-service.js'
import { DocumentService } from './document-service.js'

/** «Иванов И. И.» — из фамилии и инициалов профиля, иначе полное имя. */
export function shortNameOf(
  ref: Pick<UserRef, 'displayName'>,
  profile: Pick<UserProfile, 'lastName' | 'firstName' | 'middleName'> | null,
): string {
  if (!profile?.lastName) return ref.displayName
  const initials = [profile.firstName, profile.middleName]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => `${part.trim().charAt(0).toUpperCase()}.`)
    .join(' ')
  return initials ? `${profile.lastName} ${initials}` : profile.lastName
}

function personOf(ref: UserRef | null, profile: UserProfile | null): Record<string, string> {
  return {
    name: ref?.displayName ?? '',
    short_name: ref ? shortNameOf(ref, profile) : '',
    last_name: profile?.lastName ?? '',
    position: ref?.position ?? '',
    unit: ref?.unitName ?? '',
    email: profile?.email ?? '',
    phone: profile?.phone ?? '',
  }
}

/**
 * Контекст заполнения шаблона DOCX (08-documents.md §8, ADR-0085): реквизиты
 * документа и люди — с правами заказчика, значения — готовые строки на его
 * языке (даты — «19.09.2026», поля карточки — по формату поля). Пути — те же,
 * что перечислены в `templatePlaceholders()`.
 */
export async function templateContext(
  ctx: UserCtx,
  documentId: string,
  org: string,
): Promise<Record<string, unknown>> {
  const t = createTranslator(ctx.locale)
  const doc = await DocumentService.get(ctx, documentId)
  const correspondent: CorrespondentRecord | null = doc.correspondent
    ? await CorrespondentService.get(ctx, doc.correspondent.id).catch(() => null)
    : null
  const people = [doc.author, doc.signer, doc.responsible, doc.controller]
  const profiles = await Promise.all(
    people.map((ref) => (ref ? UserService.profile(ref.id) : Promise.resolve(null))),
  )
  const date = (value: string | null) =>
    value ? formatDate(value, { locale: ctx.locale, timezone: 'UTC' }) : ''
  const fields: Record<string, string> = {}
  for (const field of doc.type.cardSchema.fields) {
    fields[field.key] = formatValue(doc.fields[field.key], field, {
      locale: ctx.locale,
      timezone: ctx.timezone,
    })
  }
  return {
    doc: {
      subject: doc.subject,
      summary: doc.summary ?? '',
      type: doc.type.name[ctx.locale] ?? doc.type.name.ru,
      reg_number: doc.regNumber ?? '',
      reg_date: date(doc.regDate),
      deadline: date(doc.deadline),
      external_number: doc.externalNumber ?? '',
      external_date: date(doc.externalDate),
      received_date: date(doc.receivedDate),
      delivery_method: doc.deliveryMethod ? t(`documents.delivery.${doc.deliveryMethod}`) : '',
      unit: doc.unit?.name ?? '',
      correspondent: {
        name: correspondent?.name ?? doc.correspondent?.name ?? '',
        short_name: correspondent?.details.shortName ?? '',
        address: correspondent?.details.address ?? '',
        head: correspondent?.details.head ?? '',
        email: correspondent?.contacts.email ?? '',
        phone: correspondent?.contacts.phone ?? '',
      },
      fields,
      attachments: (doc.currentVersion?.attachments ?? []).map((file) => ({ name: file.name })),
    },
    author: personOf(doc.author, profiles[0] ?? null),
    signer: personOf(doc.signer, profiles[1] ?? null),
    responsible: personOf(doc.responsible, profiles[2] ?? null),
    controller: personOf(doc.controller, profiles[3] ?? null),
    org: { name: org },
    today: formatDate(new Date(), { locale: ctx.locale, timezone: ctx.timezone }),
  }
}
