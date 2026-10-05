import type { CoreNamespace } from '../../namespaces.js'
import type { Dictionary } from '../ru/index.js'
import { access } from './access.js'
import { activity } from './activity.js'
import { auth } from './auth.js'
import { common } from './common.js'
import { discussion } from './discussion.js'
import { errors } from './errors.js'
import { files } from './files.js'
import { home } from './home.js'
import { inbox } from './inbox.js'
import { objects } from './objects.js'
import { search } from './search.js'
import { shell } from './shell.js'
import { spaces } from './spaces.js'
import { ui } from './ui.js'

/** Неймспейсы оболочки `ru` (CORE_NAMESPACES): в основном чанке веба (ADR-0191). */
export const core = {
  common,
  ui,
  errors,
  auth,
  shell,
  objects,
  access,
  activity,
  discussion,
  spaces,
  search,
  inbox,
  home,
  files,
} satisfies { [N in CoreNamespace]: Dictionary[N] }
