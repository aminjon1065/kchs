import { formatDate, formatDateTime } from '@kchs/fields'
import { Badge, Button, ObjectIcon, StatusBadge } from '@kchs/ui'
import { PanelRightOpen, Share2 } from 'lucide-react'
import { useState } from 'react'
import { ShareDialog } from '~/entities/access/share-dialog.js'
import { PresenceAvatars } from '~/entities/objects/presence-avatars.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { PrintMenu } from '../print/print-menu.js'
import { DOCUMENT_STATUS_TONE } from '../status.js'
import { useDocument } from './document-context.js'
import { OfficeEditingBadge } from './office-editing-badge.js'
import { DocumentRouteChip } from './route-chip.js'
import { useAwaitsMe } from './step-actions.js'

/**
 * Чипы шапки (ADR-0230): вид документа, идущий маршрут (текущий шаг и кто ждёт),
 * состояние, контроль и гриф. Маршрут-чип ведёт на вкладку «Маршрут», если она есть.
 */
export function DocumentChips({ onOpenRoute }: { onOpenRoute?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const { document } = useDocument()
  const typeName = document.type.name[locale] ?? document.type.name.ru
  return (
    <>
      <Badge tone="outline" className="h-6 gap-1.5 rounded-md bg-surface px-2 text-fg">
        <ObjectIcon type="document" className="size-3.5 text-purple" />
        {typeName}
      </Badge>
      <DocumentRouteChip onOpen={onOpenRoute} />
      <StatusBadge
        status={DOCUMENT_STATUS_TONE[document.status]}
        label={t(`documents.statuses.${document.status}`)}
      />
      {document.control === 'on' ? <Badge tone="purple">{t('documents.controls.on')}</Badge> : null}
      {document.confidentiality !== 'public' ? (
        <Badge
          tone="outline"
          className="h-6 rounded-md px-2 font-mono text-2xs"
          title={t(`access.confidentiality.${document.confidentiality}`)}
        >
          {t(`access.confidentialityShort.${document.confidentiality}`)}
        </Badge>
      ) : null}
      <OfficeEditingBadge />
    </>
  )
}

/**
 * Строка реквизитов под темой (ADR-0230): номер и дата регистрации моноширинно,
 * отправитель (корреспондент входящего, подразделение или автор), кто и когда
 * зарегистрировал, срок (просрочка — тоном ошибки) и ответственный.
 */
export function DocumentRequisitesLine() {
  const t = useT()
  const locale = useLocale()
  const { document } = useDocument()
  const sender =
    document.type.direction === 'incoming'
      ? (document.correspondent?.name ?? null)
      : (document.unit?.name ?? document.author?.displayName ?? null)
  const registration = document.registration
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-secondary">
      {document.regNumber ? (
        <span className="tabular font-mono text-xs text-fg">
          {t('documents.header.number', {
            number: document.regNumber,
            date: document.regDate ? formatDate(document.regDate, { locale }) : '',
          })}
        </span>
      ) : null}
      {sender ? <span>{sender}</span> : null}
      {registration?.registeredBy ? (
        <span>
          {t('documents.header.registered', {
            name: registration.registeredBy.displayName,
            time: formatDateTime(registration.registeredAt, { locale }),
          })}
        </span>
      ) : null}
      {document.deadline ? (
        <span className={document.overdue ? 'text-danger' : undefined}>
          {t('documents.header.deadline', { date: formatDate(document.deadline, { locale }) })}
        </span>
      ) : null}
      {document.responsible ? (
        <span>{t('documents.header.responsible', { name: document.responsible.displayName })}</span>
      ) : null}
    </div>
  )
}

/**
 * Шапка карточки документа (ADR-0230): чипы и действия — присутствие, «Действия» (когда
 * контекст-панель скрыта), печать, «Поделиться»; тема крупно; строка реквизитов.
 */
export function DocumentHeader() {
  const t = useT()
  const contextOpen = useWorkspace((s) => s.contextOpen)
  const contextTab = useWorkspace((s) => s.contextTab)
  const setContextTab = useWorkspace((s) => s.setContextTab)
  const [shareOpen, setShareOpen] = useState(false)
  const { document, openSection } = useDocument()
  const awaitsMe = useAwaitsMe(document)
  // Действия шага живут в контекст-панели; когда она скрыта или на другой вкладке — кнопка к ним
  const hasActions =
    document.can.register ||
    document.can.cancel ||
    document.can.startRoute ||
    awaitsMe ||
    document.can.reply ||
    document.can.dispatch ||
    document.can.file
  const actionsHidden = hasActions && (!contextOpen || contextTab !== 'info')
  return (
    <header className="flex shrink-0 flex-col gap-2.5 px-6 pt-4 pb-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DocumentChips onOpenRoute={() => openSection('route')} />
        <span className="flex-1" />
        <PresenceAvatars objectId={document.id} />
        {actionsHidden ? (
          <Button
            variant="subtle"
            size="sm"
            icon={<PanelRightOpen className="size-3.5" />}
            onClick={() => setContextTab('info')}
          >
            {t('documents.actions.title')}
          </Button>
        ) : null}
        <PrintMenu subjectId={document.id} />
        {document.can.share ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Share2 className="size-3.5" />}
            onClick={() => setShareOpen(true)}
          >
            {t('common.actions.share')}
          </Button>
        ) : null}
      </div>
      <h1 className="text-pretty text-xl font-semibold leading-tight tracking-tight text-fg">
        {document.subject || t('documents.draft')}
      </h1>
      <DocumentRequisitesLine />
      <ShareDialog
        objectId={document.id}
        title={document.subject || t('documents.draft')}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </header>
  )
}
