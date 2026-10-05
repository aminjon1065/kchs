import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'
import { access } from './access.js'
import { activity } from './activity.js'
import { admin } from './admin.js'
import { alerts } from './alerts.js'
import { assistant } from './assistant.js'
import { auth } from './auth.js'
import { automation } from './automation.js'
import { calendar } from './calendar.js'
import { chats } from './chats.js'
import { common } from './common.js'
import { data } from './data.js'
import { discussion } from './discussion.js'
import { documentAssist } from './documentAssist.js'
import { documents } from './documents.js'
import { errors } from './errors.js'
import { files } from './files.js'
import { forms } from './forms.js'
import { gis } from './gis.js'
import { home } from './home.js'
import { inbox } from './inbox.js'
import { knowledge } from './knowledge.js'
import { meetings } from './meetings.js'
import { notifications } from './notifications.js'
import { objects } from './objects.js'
import { processDesigner } from './processDesigner.js'
import { processes } from './processes.js'
import { profile } from './profile.js'
import { schedules } from './schedules.js'
import { search } from './search.js'
import { shell } from './shell.js'
import { spaces } from './spaces.js'
import { tasks } from './tasks.js'
import { telegram } from './telegram.js'
import { ui } from './ui.js'

/**
 * Тоҷикӣ — перевод интерфейса с русского (основной язык). Перевод полный: в браузере
 * модульный неймспейс грузится только на языке интерфейса, без запасного ru (ADR-0191,
 * проверяет `i18n:check`). Неймспейсы — по файлам рядом. Термины — docs/05-appendix/glossary.md, раздел
 * «Интерфейс: таджикские термины»; перевод ждёт проверки носителем языка из Комитета
 * (риск R12 в 04-delivery/05-risks-and-open-questions.md). После числительного
 * существительное в таджикском стоит в единственном числе, поэтому ветви plural
 * одинаковые.
 */
export const tg: DeepPartial<Dictionary> = {
  common,
  ui,
  auth,
  shell,
  home,
  inbox,
  notifications,
  telegram,
  activity,
  objects,
  access,
  documents,
  spaces,
  files,
  gis,
  data,
  tasks,
  processes,
  processDesigner,
  documentAssist,
  calendar,
  chats,
  meetings,
  discussion,
  assistant,
  knowledge,
  search,
  profile,
  admin,
  automation,
  forms,
  alerts,
  schedules,
  errors,
}
