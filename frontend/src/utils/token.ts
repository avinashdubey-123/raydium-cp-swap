import { PublicKey, Connection } from '@solana/web3.js'
import { getAssociatedTokenAddress } from '@solana/spl-token'

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
