import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const activity: DeepPartial<Dictionary['activity']> = {
  object: {
    created: '{actor} объект эҷод кард',
    updated: '{actor} тағйир дод: {fields}',
    moved: '{actor} объектро кӯчонд',
    archived: '{actor} ба бойгонӣ фиристод',
    restored: '{actor} объектро барқарор кард',
    trashed: '{actor} ба сабад кӯчонд',
    shared: '{actor} дастрасиро тағйир дод',
    linked: '{actor} алоқа илова кард',
  },
  message: {
    posted: '{actor} дар муҳокима навишт',
  },
  file: {
    uploaded: '{actor} файли «{name}»-ро боргузорӣ кард',
    version_added: '{actor} версияи {number}-ро боргузорӣ кард',
  },
  space: {
    member_added: '{actor} иштирокчӣ илова кард',
  },
  task: {
    assigned: '{actor} иҷрокунанда таъин кард',
    accepted: '{actor} супоришро барои иҷро қабул кард',
    statusChanged:
      '{actor} ба ҳолати «{to, select, todo {Барои иҷро} in_progress {Дар иҷро} review {Дар санҷиш} done {Иҷро шуд} cancelled {Бекор шуд} assigned {Таъин шуд} other {{to}}}» гузаронд',
    dueChanged: '{actor} мӯҳлатро тағйир дод',
    reported: '{actor} дар бораи иҷро ҳисобот дод',
    completed: '{actor} вазифаро пӯшид',
    returned: '{actor} барои ислоҳ баргардонд: {comment}',
    extensionRequested: '{actor} тамдиди мӯҳлатро дархост кард: {reason}',
    extensionApproved: '{actor} мӯҳлатро тамдид кард',
    extensionRejected: '{actor} тамдиди мӯҳлатро рад кард',
    overdue: 'Мӯҳлати супориш гузашт',
    escalated: 'Дар бораи гузаштани мӯҳлат ба роҳбари иҷрокунанда хабар дода шуд',
  },
  process: {
    started: '{actor} масири «{name}»-ро оғоз кард',
    decided: {
      approve: '{actor} мувофиқа кард',
      remarks: '{actor} эрод дод',
      reject: '{actor} рад кард',
      sign: '{actor} имзо кард',
      refuse: '{actor} имзоро рад кард',
      acknowledge: '{actor} шинос шуд',
      register: '{actor} ба қайд гирифт',
      resubmit: '{actor} барои мувофиқакунии такрорӣ фиристод',
      withdraw: '{actor} аз масир бозпас гирифт',
    },
    assignees: {
      added: '{actor} мувофиқакунанда илова кард',
      delegated: '{actor} қадами худро дар масир вогузор кард',
      reassigned: '{actor} қадами масирро аз нав таъин кард',
    },
    finished: 'Масир анҷом ёфт',
    cancelled: 'Масир бекор карда шуд',
  },
  document: {
    registered: '{actor} ҳуҷҷатро ба қайд гирифт: № {number}',
    cancelled: '{actor} ҳуҷҷатро беэътибор кард: {reason}',
    statusChanged:
      '{actor} ҳуҷҷатро ба ҳолати «{to, select, draft {Сиёҳнавис} on_approval {Дар мувофиқакунӣ} returned {Баргардонида шуд} approved {Мувофиқа шуд} on_signing {Дар имзо} signed {Имзо шуд} registered {Ба қайд гирифта шуд} on_execution {Дар иҷро} executed {Иҷро шуд} filed {Дар парванда} archived {Дар бойгонӣ} cancelled {Беэътибор шуд} other {{to}}}» гузаронд',
    updated: '{actor} кортро тағйир дод',
    versionAdded: '{actor} версияи {number}-ро илова кард',
    confidentialityChanged: '{actor} грифро тағйир дод',
    resolutionRequested: '{actor} ҳуҷҷатро барои резолютсия фиристод',
    resolutionAdded: '{actor} резолютсия гузошт',
    filed: '{actor} ҳуҷҷатро ба парвандаи {index} гузошт',
    dispatched: '{actor} фиристоданро қайд кард: {addressee}',
    filesDestroyed: 'Файлҳои ҳуҷҷат аз рӯи санади № {number} нобуд карда шуданд',
  },
  case: {
    created: '{actor} парвандаи {index}-ро кушод',
    updated: '{actor} парвандаро тағйир дод',
    closed: '{actor} парвандаро пӯшид',
    reopened: '{actor} парвандаро аз нав кушод',
    archived: '{actor} парвандаро ба бойгонӣ супорид',
    destroyed: 'Парванда аз рӯи санади № {number} нобуд карда шуд',
  },
  event: {
    updated: '{actor} рӯйдодро тағйир дод',
    cancelled: '{actor} рӯйдодро бекор кард',
    invited: '{actor} иштирокчиёнро даъват кард',
    accepted: '{actor} даъватро қабул кард',
    tentative: '{actor} «шояд» ҷавоб дод',
    declined: '{actor} даъватро рад кард',
  },
}
