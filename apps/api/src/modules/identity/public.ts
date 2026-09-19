/**
 * Публичный API модуля «Идентификация» для других модулей и ядра
 * (01-overview.md §Как модули взаимодействуют).
 */
export { AuthService } from './domain/auth-service.js'
export { DirectoryQueries } from './domain/directory.js'
export {
  DelegationService,
  GroupService,
  OrgService,
  UserService,
} from './domain/user-service.js'
