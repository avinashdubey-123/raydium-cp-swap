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

    try {
      // Fetch all vault balances in parallel using getMultipleAccountsInfo
      const accountsInfo = await connection.getMultipleAccountsInfo(allVaults)

      // Parse results
      for (let j = 0; j < batchKeys.length; j++) {
        const vault0Info = accountsInfo[j * 2]
        const vault1Info = accountsInfo[j * 2 + 1]

        let vault0Balance: number | null = null
        let vault1Balance: number | null = null

        // Parse vault0
        if (vault0Info?.data) {
          try {
            const data = vault0Info.data
            // Token account data layout: mint(32) + owner(32) + amount(8) + ...
            if (data.length >= 72) {
              const amountBuffer = data.slice(64, 72)
              vault0Balance = Number(new (require('bn.js').default)(amountBuffer).toString()) / Math.pow(10, 6) // Default to 6 decimals
            }
          } catch (e) {
            // Fallback to getTokenAccountBalance
          }
        }

        // Parse vault1
        if (vault1Info?.data) {
          try {
            const data = vault1Info.data
            if (data.length >= 72) {
              const amountBuffer = data.slice(64, 72)
              vault1Balance = Number(new (require('bn.js').default)(amountBuffer).toString()) / Math.pow(10, 6)
            }
          } catch (e) {
            // Fallback to getTokenAccountBalance
          }
        }

        // If parsing failed, fall back to individual RPC calls for this batch
        if (vault0Balance === null || vault1Balance === null) {
          const { vault0: v0, vault1: v1 } = batch[j]
          try {
            const b0 = await connection.getTokenAccountBalance(v0)
            vault0Balance = b0.value.uiAmount ?? null
          } catch (e) { }
          try {
            const b1 = await connection.getTokenAccountBalance(v1)
            vault1Balance = b1.value.uiAmount ?? null
          } catch (e) { }
        }

        results.set(batchKeys[j], { vault0Balance, vault1Balance })
      }
    } catch (err) {
      console.error(`[batchFetch] Error fetching batch ${i}-${i + batchSize}:`, err)
      // On batch error, try individual fetches as fallback
      for (const { vault0, vault1 } of batch) {
        const key = `${vault0.toBase58()}-${vault1.toBase58()}`
        try {
          const b0 = await connection.getTokenAccountBalance(vault0)
          const b1 = await connection.getTokenAccountBalance(vault1)
          results.set(key, { vault0Balance: b0.value.uiAmount ?? null, vault1Balance: b1.value.uiAmount ?? null })
        } catch (e) {
          results.set(key, { vault0Balance: null, vault1Balance: null })
        }
      }
    }
  }

  return results
}