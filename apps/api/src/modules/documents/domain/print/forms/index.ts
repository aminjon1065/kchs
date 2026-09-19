import { registerPrintForm } from '../registry.js'
import { dispatchRegister } from './dispatch-register.js'
import { acknowledgmentSheet, caseInventory } from './office-sheets.js'
import { registrationCard } from './registration-card.js'
import { registrationStamp } from './registration-stamp.js'
import { approvalSheet, signatureSheet } from './route-sheets.js'

/**
 * Встроенные печатные формы (ADR-0085): регистрационная карточка, штамп,
 * реестр отправки; листы согласования и подписи (маршруты, ADR-0083), лист
 * ознакомления (ADR-0084), опись дела (ADR-0086).
 */
export function registerBuiltinPrintForms(): void {
  registerPrintForm(registrationCard)
  registerPrintForm(registrationStamp)
  registerPrintForm(dispatchRegister)
  registerPrintForm(approvalSheet)
  registerPrintForm(signatureSheet)
  registerPrintForm(acknowledgmentSheet)
  registerPrintForm(caseInventory)
}
