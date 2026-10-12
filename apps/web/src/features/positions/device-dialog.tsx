import { DEVICE_KINDS, type DeviceKind, type DeviceRecord } from '@kchs/contracts'
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { type PickedUser, UserPicker } from '~/entities/people/user-picker.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { positionKeys, positionsApi } from './queries.js'

/**
 * Карточка устройства слежения (ADR-0203): название, номер у поставщика, вид, строка
 * «Сил и средств», кто передаёт координаты; при правке — ещё «принимает координаты».
 * Без `device` — новое устройство, с выбором пространства.
 */
export function DeviceDialog({
  device,
  open,
  onOpenChange,
  onSaved,
}: {
  device: DeviceRecord | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (id: string, name: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const externalId = useId()
  const forcesId = useId()
  const noteId = useId()
  const [name, setName] = useState(device?.name ?? '')
  const [number, setNumber] = useState(device?.externalId ?? '')
  const [kind, setKind] = useState<DeviceKind>(device?.kind ?? 'vehicle')
  const [spaceId, setSpaceId] = useState(device?.spaceId ?? '')
  const [forcesCode, setForcesCode] = useState(device?.forcesCode ?? '')
  const [note, setNote] = useState(device?.note ?? '')
  const [active, setActive] = useState(device?.active ?? true)
  const [reporter, setReporter] = useState<PickedUser | null>(
    device?.reporter ? { id: device.reporter.id, title: device.reporter.displayName } : null,
  )
  const { data: spaces = [] } = useQuery({ ...spacesQuery(), enabled: !device })

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        name: name.trim(),
        externalId: number.trim(),
        kind,
        forcesCode: forcesCode.trim() || null,
        reporterId: reporter?.id ?? null,
        note: note.trim() || null,
      }
      if (device) {
        await positionsApi.update(device.id, { ...common, active })
        return device.id
      }
      return (await positionsApi.create({ ...common, spaceId })).id
    },
    onSuccess: async (id) => {
      await client.invalidateQueries({ queryKey: positionKeys.all })
      toast.show({ title: device ? t('positions.saved') : t('positions.created'), tone: 'success' })
      onSaved?.(id, name.trim())
      onOpenChange(false)
    },
    onError: (error) =>
      toast.error(error instanceof Error && error.message ? error.message : t('errors.unknown')),
  })

  const ready = name.trim().length > 0 && number.trim().length > 0 && (device || spaceId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={device ? t('positions.editTitle') : t('positions.createTitle')}
        size="md"
        footer={
          <Button
            variant="primary"
            disabled={!ready}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {device ? t('positions.settings.save') : t('positions.create')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('positions.fields.name')} htmlFor={nameId} required>
            <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field
            label={t('positions.fields.externalId')}
            hint={t('positions.fields.externalIdHint')}
            htmlFor={externalId}
            required
          >
            <Input
              id={externalId}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
          </Field>
          <Field label={t('positions.fields.kind')}>
            <Select value={kind} onValueChange={(value) => setKind(value as DeviceKind)}>
              <SelectTrigger aria-label={t('positions.fields.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEVICE_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`positions.kinds.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {device ? null : (
            <Field label={t('positions.space')} required>
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger aria-label={t('positions.space')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field
            label={t('positions.fields.forcesCode')}
            hint={t('positions.fields.forcesCodeHint')}
            htmlFor={forcesId}
          >
            <Input
              id={forcesId}
              value={forcesCode}
              onChange={(event) => setForcesCode(event.target.value)}
            />
          </Field>
          <Field label={t('positions.fields.reporter')} hint={t('positions.fields.reporterHint')}>
            <UserPicker
              value={reporter}
              onChange={setReporter}
              label={t('positions.fields.reporter')}
              serviceAccounts
            />
          </Field>
          <Field label={t('positions.fields.note')} htmlFor={noteId}>
            <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {device ? (
            <Field label={t('positions.fields.active')}>
              <Switch
                checked={active}
                aria-label={t('positions.fields.active')}
                onCheckedChange={setActive}
              />
            </Field>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
