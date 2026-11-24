// `user_integrations` through the generated `Database` (REL-12). The migration constrains
// `provider` and `status` with CHECKs, which the generator types as `string`; the unions below
// are the values those CHECKs allow, and the readers narrow to them.
import type { DbClient } from '@va/db'

export type Provider = 'microsoft'
export type IntegrationStatus = 'active' | 'reauth_required' | 'revoked'

export function integrations(client: DbClient) {
  return client.from('user_integrations')
}
