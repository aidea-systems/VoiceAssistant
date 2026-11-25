// The connection's state as its owner may see it, read through the user's own client: RLS and
// the column grant of `user_integrations` let it read these columns of its own row and nothing
// else, so no token column is ever selected here.
import type { DbClient } from '@va/db'

import { integrations, type IntegrationStatus, type Provider } from './db.js'
import { IntegrationError } from './errors.js'

export interface ConnectionState {
  provider: Provider
  account: string
  status: IntegrationStatus
  connected_at: string
}

/** The signed-in user's connections, revoked ones included (Settings shows them as not connected). */
export async function listConnections(
  userClient: DbClient,
  signal?: AbortSignal,
): Promise<ConnectionState[]> {
  const query = integrations(userClient).select('provider, account, status, connected_at').order('provider')
  const { data, error } = await (signal ? query.abortSignal(signal) : query)
  if (error) throw new IntegrationError('store_failed')
  return data.map((row) => {
    // The CHECKs allow only these values; anything else is a store we do not understand.
    if (!isProvider(row.provider) || !isStatus(row.status)) throw new IntegrationError('store_failed')
    return { ...row, provider: row.provider, status: row.status }
  })
}

const isProvider = (value: string): value is Provider => value === 'microsoft'
const isStatus = (value: string): value is IntegrationStatus =>
  value === 'active' || value === 'reauth_required' || value === 'revoked'
