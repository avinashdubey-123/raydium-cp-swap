import { useEffect, useState } from 'react'
import useProgram from '../utils/useProgram'
import { PublicKey } from '@solana/web3.js'
import { getPoolAddress } from '../utils/pda'
import { useGetPoolStateQuery } from '../store/solanaApi'

type UsePoolParams = {
  poolPda?: PublicKey
  ammConfig?: PublicKey
  token0Mint?: PublicKey
  token1Mint?: PublicKey
  fetchOnMount?: boolean
}

export default function usePool(params: UsePoolParams) {
  const { poolPda, ammConfig, token0Mint, token1Mint } = params
  const program = useProgram()

  const [resolvedPda, setResolvedPda] = useState<string | undefined>(poolPda?.toBase58())
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (poolPda) {
      setResolvedPda(poolPda.toBase58())
      return
    }
    if (ammConfig && token0Mint && token1Mint && program) {
      getPoolAddress(ammConfig, token0Mint, token1Mint, program.programId)
        .then(([p]) => setResolvedPda(p.toBase58()))
        .catch(e => setLocalError(e.message))
    }
  }, [poolPda, ammConfig, token0Mint, token1Mint, program])

  const shouldFetch = (params.fetchOnMount ?? true) && !!resolvedPda
  const { data, error: queryError, isLoading, refetch } = useGetPoolStateQuery(resolvedPda ?? '', {
    skip: !shouldFetch,
  })

  const state = data?.state
  const vault0Amount = data?.vault0Balance ?? null
  const vault1Amount = data?.vault1Balance ?? null
  const decimals0 = state ? Number(state.mint_0_decimals ?? state.mint0Decimals ?? 0) : 0
  const decimals1 = state ? Number(state.mint_1_decimals ?? state.mint1Decimals ?? 0) : 0

  const refresh = async () => {
    await refetch()
  }

  const finalError = localError || (queryError ? (typeof queryError === 'string' ? queryError : JSON.stringify(queryError)) : null)

  return { 
    poolState: state || null, 
    vault0Amount, 
    vault1Amount, 
    decimals0, 
    decimals1, 
    loading: isLoading, 
    error: finalError, 
    refresh 
  }
}
