import type { MapBookmark } from '@kchs/contracts'
import {
  Button,
  IconButton,
  InlineEdit,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '@kchs/ui'
import { Bookmark, BookmarkPlus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useStudio } from './context.js'

/** Закладок на карте — как в контракте `MapSpec.bookmarks`. */
const MAX_BOOKMARKS = 100

function newBookmarkId(): string {
  return `bm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Закладки карты (P2-E02 S02): именованные виды `MapSpec.bookmarks` — перейти,
 * добавить текущий вид, переименовать, удалить. Правка — часть несохранённой
 * правки карты: сохраняется кнопкой «Сохранить карту» вместе со слоями.
 */
export function BookmarksMenu() {
  const t = useT()
  const studio = useStudio()
  const { spec, canEdit } = studio
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const bookmarks = spec.bookmarks

  const edit = (change: (items: MapBookmark[]) => MapBookmark[]) =>
    studio.editSpec((value) => ({ ...value, bookmarks: change([...value.bookmarks]) }))

  const add = () => {
    const title = name.trim() || t('gis.bookmarks.defaultName', { n: bookmarks.length + 1 })
    edit((items) => [...items, { id: newBookmarkId(), name: title, camera: studio.camera }])
    setName('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={t('gis.bookmarks.title')}>
        <PopoverTrigger asChild>
          <IconButton label={t('gis.bookmarks.title')} size="md" active={open}>
            <Bookmark className="size-4" aria-hidden />
          </IconButton>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="center" className="flex w-80 flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">{t('gis.bookmarks.title')}</h3>
        {bookmarks.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('gis.bookmarks.empty')}</p>
        ) : (
          <ul
            aria-label={t('gis.bookmarks.title')}
            className="flex max-h-64 flex-col overflow-y-auto"
          >
            {bookmarks.map((bookmark) => (
              <li
                key={bookmark.id}
                className="group flex min-w-0 items-center gap-1 rounded-sm hover:bg-surface-2"
              >
                {canEdit ? (
                  <div className="min-w-0 flex-1">
                    <InlineEdit
                      value={bookmark.name}
                      onSave={(next) =>
                        edit((items) =>
                          items.map((item) =>
                            item.id === bookmark.id ? { ...item, name: next } : item,
                          ),
                        )
                      }
                      className="text-sm text-fg"
                      aria-label={t('gis.bookmarks.rename', { name: bookmark.name })}
                    />
                  </div>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className={canEdit ? 'shrink-0' : 'min-w-0 flex-1 justify-start'}
                  aria-label={t('gis.bookmarks.go', { name: bookmark.name })}
                  onClick={() => {
                    studio.setCamera(bookmark.camera)
                    setOpen(false)
                  }}
                >
                  {canEdit ? (
                    t('gis.bookmarks.show')
                  ) : (
                    <span className="truncate">{bookmark.name}</span>
                  )}
                </Button>
                {canEdit ? (
                  <IconButton
                    label={t('gis.bookmarks.remove', { name: bookmark.name })}
                    size="sm"
                    variant="danger"
                    onClick={() => edit((items) => items.filter((item) => item.id !== bookmark.id))}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </IconButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form
            className="flex items-center gap-1.5 border-t border-line pt-2"
            onSubmit={(event) => {
              event.preventDefault()
              add()
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('gis.bookmarks.namePlaceholder')}
              aria-label={t('gis.bookmarks.name')}
              maxLength={200}
              className="h-7 flex-1"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              icon={<BookmarkPlus className="size-3.5" />}
              disabled={bookmarks.length >= MAX_BOOKMARKS}
            >
              {t('gis.bookmarks.add')}
            </Button>
          </form>
        ) : null}
        {canEdit && bookmarks.length > 0 ? (
          <p className="text-xs text-fg-muted">{t('gis.bookmarks.saveHint')}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
