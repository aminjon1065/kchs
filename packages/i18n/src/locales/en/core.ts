import type { CoreNamespace } from '../../namespaces.js'
import type { DeepPartial } from '../../types.js'
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

/** Неймспейсы оболочки `en` (CORE_NAMESPACES): в вебе — один чанк, грузится с языком (ADR-0191). */
export const core: { [N in CoreNamespace]: DeepPartial<Dictionary[N]> } = {
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
}
