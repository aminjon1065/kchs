import { type HelpPages, LOCALES, type Locale } from '@kchs/contracts'
import { LOCALE_NAMES } from '@kchs/i18n'
import { Button, Card, Field, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { helpQuery } from '~/features/knowledge/help.js'
import { ObjectPicker } from '~/features/notebooks/object-picker.js'
import { ApiError, http } from '~/shared/api/client.js'

const pagesKey = ['knowledge', 'help', 'pages'] as const

/**
 * Страницы пункта «Справка» по языкам (вопрос N88): без страницы на языке сотрудника
 * открывается русская, без обеих пункта нет. Сид предлагает корни краткого
 * руководства, администратор может выбрать свои страницы.
 */
export function HelpCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { data } = useQuery({
    queryKey: pagesKey,
    queryFn: () => http.get<HelpPages>('/knowledge/help/pages'),
  })
  const [draft, setDraft] = useState<HelpPages | null>(null)
  const value = draft ?? data
  const save = useMutation({
    mutationFn: (next: HelpPages) => http.put<HelpPages>('/knowledge/help/pages', next),
    onSuccess: (saved) => {
      client.setQueryData(pagesKey, saved)
      void client.invalidateQueries({ queryKey: helpQuery().queryKey })
      setDraft(null)
      toast.show({ title: t('admin.help.saved'), tone: 'success' })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })
  if (!value) return null
  const set = (locale: Locale, id: string | null) => setDraft({ ...value, [locale]: id })

  return (
    <Card title={t('admin.help.title')} role="group" aria-label={t('admin.help.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-secondary">{t('admin.help.hint')}</p>
        {LOCALES.map((locale) => (
          <Field key={locale} label={LOCALE_NAMES[locale].full}>
            <div className="flex items-center gap-2">
              <ObjectPicker
                type="page"
                value={value[locale]}
                onChange={(id) => set(locale, id)}
                label={t('admin.help.pageFor', { language: LOCALE_NAMES[locale].full })}
                placeholder={t('admin.help.none')}
                spaceId={null}
              />
              {value[locale] ? (
                <Button variant="ghost" size="sm" onClick={() => set(locale, null)}>
                  {t('common.actions.remove')}
                </Button>
              ) : null}
            </div>
          </Field>
        ))}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!draft}
            loading={save.isPending}
            onClick={() => draft && save.mutate(draft)}
          >
            {/* Своя подпись: на экране брендирования уже есть «Сохранить» (N88) */}
            {t('admin.help.save')}
          </Button>
          {draft ? (
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('common.actions.cancel')}
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
