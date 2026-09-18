export {
  explainAccessFor,
  grantAccess,
  grantOwner,
  listEffectiveAccess,
  readPrincipalsFor,
  revokeAccess,
  setAccessMode,
  usersWithAccess,
} from './acl-service.js'
export {
  authorize,
  effectiveLevel,
  hasCapability,
  loadObject,
  requireCapability,
  spaceMemberIds,
  visibleObjectsSql,
} from './authorize.js'
export { describePrincipals } from './principal-refs.js'
export {
  bumpPrincipalsVersion,
  computePrincipalSet,
  getPrincipalSet,
  hasPrincipal,
  invalidatePrincipalSet,
  loadCapabilities,
  spaceRoleKeys,
} from './principal-set.js'
export type { ActionDefinition, AuthorizeOptions, ObjectLike, TypePolicy } from './types.js'
