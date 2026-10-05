import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { CreateSpaceDialog } from './create-space-dialog.js'

/** Что модуль пространств даёт оболочке (ADR-0183): диалог создания из навигатора. */
export const spacesModule: ModuleDefinition = {
  key: 'spaces',
  slots: [
    {
      key: 'create-space',
      placement: 'dialog',
      render: ({ open, onOpenChange }) => (
        <CreateSpaceDialog open={open} onOpenChange={onOpenChange} />
      ),
    },
  ],
}
