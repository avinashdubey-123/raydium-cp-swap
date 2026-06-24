import { Connection, PublicKey } from '@solana/web3.js'

/**
 * Batch fetch token account balances for multiple vaults in groups of 10.
 * This reduces RPC calls and avoids rate limiting.
 */
export async function batchFetchTokenBalances(
  connection: Connection,
  vaults: Array<{ vault0: PublicKey; vault1: PublicKey }>,
  batchSize = 10
): Promise<Map<string, { vault0Balance: number | null; vault1Balance: number | null }>> {
  const results = new Map<string, { vault0Balance: number | null; vault1Balance: number | null }>()

  // Process in batches of 10
  for (let i = 0; i < vaults.length; i += batchSize) {
    const batch = vaults.slice(i, i + batchSize)

    // Collect all unique vault addresses for this batch
    const allVaults: PublicKey[] = []
    const batchKeys: string[] = []

    for (const { vault0, vault1 } of batch) {
      const key = `${vault0.toBase58()}-${vault1.toBase58()}`
      batchKeys.push(key)
      allVaults.push(vault0, vault1)
    }

    // Fetch all vault balances in parallel using getTokenAccountBalance
    // This properly handles different token decimals and account types
    const balancePromises = allVaults.map(async (vault) => {
      try {
        const balance = await connection.getTokenAccountBalance(vault)
        return balance?.value?.uiAmount ?? null
      } catch (e) {
        // Account might not exist or be a non-token account
        return null
      }
    })

    const balances = await Promise.all(balancePromises)

    // Map results back to pairs
    for (let j = 0; j < batchKeys.length; j++) {
      const vault0Balance = balances[j * 2]
      const vault1Balance = balances[j * 2 + 1]
      results.set(batchKeys[j], { vault0Balance, vault1Balance })
    }
  }

  return results
}
