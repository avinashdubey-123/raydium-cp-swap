import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import idlJson from '../../idl/raydium_cp_swap.json'

const PROGRAM_ID = new PublicKey('J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD')

export type PoolData = {
  poolPda: string | null
  name: string
  fee: string
  ammConfig: string | null
  token0: string | null
  token1: string | null
  token0Vault: string | null
  token1Vault: string | null
  vault0Balance: number | null
  vault1Balance: number | null
  lpSupply?: string
  raw: any
}

export type AmmConfigData = {
  publicKey: string
  [key: string]: any
}

let cachedConnection: Connection | null = null
let cachedEndpoint = ''

function getEndpoint(): string {
  const endpointFromWindow = typeof window !== 'undefined' ? (window as any).__SOLANA_ENDPOINT : null
  if (typeof endpointFromWindow === 'string' && endpointFromWindow.length > 0) {
    return endpointFromWindow
  }
  return clusterApiUrl('devnet')
}

function getConnection(): Connection {
  const endpoint = getEndpoint()
  if (!cachedConnection || cachedEndpoint !== endpoint) {
    cachedConnection = new Connection(endpoint, 'confirmed')
    cachedEndpoint = endpoint
  }
  return cachedConnection
}

function toPubString(v: any): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  if (v?.toBase58) return v.toBase58()
  try {
    return String(v)
  } catch {
    return null
  }
}

function decodeAccount(coder: anchor.BorshAccountsCoder, data: Buffer | Uint8Array) {
  const asBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data)

  let decodedPool: any = null
  try {
    decodedPool = coder.decode('PoolState', asBuffer)
  } catch {
    // no-op
  }
  if (!decodedPool) {
    try {
      decodedPool = coder.decode('poolState', asBuffer)
    } catch {
      // no-op
    }
  }
  if (!decodedPool) {
    try {
      decodedPool = coder.decode('pool_state', asBuffer)
    } catch {
      // no-op
    }
  }
  if (decodedPool) {
    return { kind: 'pool' as const, account: decodedPool }
  }

  let decodedConfig: any = null
  try {
    decodedConfig = coder.decode('AmmConfig', asBuffer)
  } catch {
    // no-op
  }
  if (!decodedConfig) {
    try {
      decodedConfig = coder.decode('ammConfig', asBuffer)
    } catch {
      // no-op
    }
  }
  if (!decodedConfig) {
    try {
      decodedConfig = coder.decode('amm_config', asBuffer)
    } catch {
      // no-op
    }
  }
  if (decodedConfig) {
    return { kind: 'config' as const, account: decodedConfig }
  }

  return null
}

async function getTokenBalance(connection: Connection, account: string | null): Promise<number | null> {
  if (!account) return null
  try {
    const balance = await connection.getTokenAccountBalance(new PublicKey(account))
    return balance?.value?.uiAmount ?? null
  } catch {
    return null
  }
}

async function fetchPoolsAndConfigs() {
  const connection = getConnection()
  const coder = new anchor.BorshAccountsCoder(idlJson as any)

  const raw = await connection.getProgramAccounts(PROGRAM_ID)
  const pools: Array<{ pubkey: PublicKey; account: any }> = []
  const ammConfigs: AmmConfigData[] = []

  for (const item of raw) {
    try {
      const decoded = decodeAccount(coder, item.account.data)
      if (!decoded) continue
      if (decoded.kind === 'pool') {
        pools.push({ pubkey: item.pubkey, account: decoded.account })
      } else {
        ammConfigs.push({ ...decoded.account, publicKey: item.pubkey.toBase58() })
      }
    } catch {
      // skip invalid account
    }
  }

  const mapped: PoolData[] = pools.map(({ pubkey, account }) => {
    const token0Vault = toPubString(account.token_0_vault ?? account.token0Vault ?? account.token0_vault)
    const token1Vault = toPubString(account.token_1_vault ?? account.token1Vault ?? account.token1_vault)
    const mint0 = toPubString(account.token_0_mint ?? account.token0Mint ?? account.mint_0 ?? account.mint0 ?? account.mint_0_mint ?? account.mint_0_pubkey)
    const mint1 = toPubString(account.token_1_mint ?? account.token1Mint ?? account.mint_1 ?? account.mint1 ?? account.mint_1_mint ?? account.mint_1_pubkey)
    const ammConfig = toPubString(account.amm_config ?? account.ammConfig ?? account.amm)

    return {
      poolPda: pubkey.toBase58(),
      name: account.name ?? (mint0 ? String(mint0).slice(0, 6) : 'Pool'),
      fee: account.fee ?? '-',
      ammConfig,
      token0: mint0 ?? null,
      token1: mint1 ?? null,
      token0Vault,
      token1Vault,
      vault0Balance: null,
      vault1Balance: null,
      lpSupply: account.lpSupply ?? account.lp_supply ?? undefined,
      raw: account,
    }
  })

  await Promise.all(
    mapped.map(async (pool) => {
      const [v0, v1] = await Promise.all([
        getTokenBalance(connection, pool.token0Vault),
        getTokenBalance(connection, pool.token1Vault),
      ])
      pool.vault0Balance = v0
      pool.vault1Balance = v1
    }),
  )

  return { pools: mapped, ammConfigs }
}

export const solanaApi = createApi({
  reducerPath: 'solanaApi',
  baseQuery: fakeBaseQuery(),
  tagTypes: ['Pools', 'Portfolio'],
  endpoints: (builder) => ({
    getPools: builder.query<{ pools: PoolData[]; ammConfigs: AmmConfigData[] }, void>({
      queryFn: async () => {
        try {
          const data = await fetchPoolsAndConfigs()
          return { data }
        } catch (error) {
          return {
            error: {
              status: 'CUSTOM_ERROR',
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      },
      providesTags: [{ type: 'Pools', id: 'LIST' }],
      keepUnusedDataFor: 60 * 10,
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, dispatch }) {
        await cacheDataLoaded
        const connection = getConnection()
        let listenerId: number | null = null

        try {
          listenerId = connection.onProgramAccountChange(PROGRAM_ID, () => {
            dispatch(solanaApi.util.invalidateTags([{ type: 'Pools', id: 'LIST' }, { type: 'Portfolio', id: 'LIST' }]))
          })
        } catch {
          // websocket subscription is best-effort
        }

        await cacheEntryRemoved

        if (listenerId != null) {
          try {
            await connection.removeProgramAccountChangeListener(listenerId)
          } catch {
            // no-op
          }
        }
      },
    }),
  }),
})

export const { useGetPoolsQuery } = solanaApi
