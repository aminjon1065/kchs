import { registerPrintForm } from '../registry.js'
import { dispatchRegister } from './dispatch-register.js'
import { registrationCard } from './registration-card.js'
import { registrationStamp } from './registration-stamp.js'

/**
 * Встроенные печатные формы (ADR-0085). Листы согласования, подписи и
 * ознакомления, опись дела добавляют их модули той же регистрацией.
 */
export function registerBuiltinPrintForms(): void {
  registerPrintForm(registrationCard)
  registerPrintForm(registrationStamp)
  registerPrintForm(dispatchRegister)
}
