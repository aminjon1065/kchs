import { BookOpen } from 'lucide-react'
import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { useOpenHelp } from './help.js'

/** Что модуль «Знания» даёт оболочке (ADR-0183): пункт навигации и справку. */
export const knowledgeModule: ModuleDefinition = {
  key: 'knowledge',
  nav: [
    {
      key: 'knowledge',
      icon: BookOpen,
      labelKey: 'shell.rail.knowledge',
      tabIcon: 'knowledge',
      order: 90,
    },
  ],
  extensions: { useOpenHelp },
}
