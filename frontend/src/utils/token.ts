import { PublicKey, Connection } from '@solana/web3.js'
import { getAssociatedTokenAddress } from '@solana/spl-token'
import tokenRegistry from '../data/tokenRegistry.json'

export async function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, owner)
}

export async function getTokenBalance(connection: Connection, tokenAccount: PublicKey): Promise<number> {
  const res = await connection.getTokenAccountBalance(tokenAccount)
  return Number(res.value.amount)
}

export async function getParsedTokenAccount(connection: Connection, account: PublicKey) {
  return connection.getParsedAccountInfo(account)
}

export function getShortTokenName(mintAddress?: string | null): string {
  if (!mintAddress) return 'UNKN'
  const found = tokenRegistry.find(
    (t) => t.mint.toLowerCase() === mintAddress.toLowerCase()
  )
  if (found) return found.symbol
  return mintAddress.slice(0, 4).toUpperCase()
}

export function getPoolDisplayName(token0?: string | null, token1?: string | null): string {
  const name0 = getShortTokenName(token0)
  const name1 = getShortTokenName(token1)
  return `${name0}-${name1}`
}
