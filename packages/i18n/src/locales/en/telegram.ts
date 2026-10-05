import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const telegram: DeepPartial<Dictionary['telegram']> = {
  welcome:
    'This is the KChS Portal bot: it sends notifications with a link to the object. To connect your account, open your profile in KChS Portal and click “Connect Telegram”.',
  linked:
    'Done: Telegram is connected to the account “{name}”. Notifications will arrive here. To disconnect, send /stop or use your KChS Portal profile.',
  alreadyLinked:
    'This chat is already connected to KChS Portal. Send /stop to turn notifications off.',
  linkInvalid:
    'The link has expired or was already used. Get a new one in your KChS Portal profile.',
  chatTaken:
    'This chat is already connected to another KChS Portal account. Send /stop to disconnect it, then open the link again.',
  stopped: 'Telegram notifications are off. You can connect again in your KChS Portal profile.',
  notLinked: 'This chat is not connected to KChS Portal. Connect it in your KChS Portal profile.',
  help: 'The bot sends KChS Portal notifications with a link to the object and action buttons. /cancel cancels a reply to the bot, /stop turns notifications off.',
  actionDone: 'Done.',
  actionGone: 'This item is already closed or unavailable.',
  actionFailed: 'Could not do that: {reason}',
  actionError: 'Could not perform the action — open it in KChS Portal.',
  askReport: 'Write your report in one message. /cancel to cancel.',
  askComment: 'Write a comment in one message. /cancel to cancel.',
  askDueAndReason:
    'Write the new date and the reason in one message: “25.09.2026 Waiting for district data”. /cancel to cancel.',
  badDueAndReason: 'Could not read the date. Write it like this: “DD.MM.YYYY reason”.',
  cancelled: 'Cancelled.',
  open: 'Open in KChS Portal',
}
