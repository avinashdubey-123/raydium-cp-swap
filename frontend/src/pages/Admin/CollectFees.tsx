import { useEffect, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import { 
    TOKEN_PROGRAM_ID, 
    TOKEN_2022_PROGRAM_ID
} from '@solana/spl-token'
import useProgram from '../../utils/useProgram'
import { getAuthAddress } from '../../utils/pda'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import useTokenProgramAta from '../../hooks/useTokenProgramAta'
import '../WithdrawForm/WithdrawForm.css'
import { getPoolDisplayName } from '../../utils/token'

const toPublicKey = (value?: string | any | null) => {
    if (!value) return null
    if (value instanceof PublicKey) return value
    try {
        if (typeof value === 'string') return new PublicKey(value)
        if (value.toBase58) {
            if (typeof value.toBase58 === 'function') return new PublicKey(value.toBase58())
            if (typeof value.toBase58 === 'string') return new PublicKey(value.toBase58)
        }
        if (value._bn) {
            const bnValue = value._bn.words || value._bn.hex || value._bn
            return new PublicKey(new anchor.BN(bnValue).toArray('le', 32))
        }
        const str = value.toString()
        if (str && str !== '[object Object]') return new PublicKey(str)
        return null
    } catch (e) {
        console.error('toPublicKey conversion failed:', e)
        return null
    }
}

const getBNValue = (val: any) => {
    if (!val) return new anchor.BN(0)
    if (typeof val === 'string' || typeof val === 'number') return new anchor.BN(val)
    if (val.toString && typeof val.toString === 'function' && val.toString() !== '[object Object]') {
        return new anchor.BN(val.toString())
    }
    if (val.words || val.hex) return new anchor.BN(val)
    return new anchor.BN(0)
}

export default function CollectFees() {
    const navigate = useNavigate()
    const location = useLocation()
    const wallet = useWallet()
    const { connection } = useConnection()
    const program = useProgram()
    const { deriveAta, buildEnsureAtaInstruction } = useTokenProgramAta()
    
    const state = location.state as { pool: any; type: 'protocol' | 'fund'; fromTab?: string }
    const [percent, setPercent] = useState(100)
    const [busy, setBusy] = useState(false)
    const [fetching, setFetching] = useState(false)
    const [localPool, setLocalPool] = useState<any>(null)
    const [txState, setTxState] = useState<{
        status: 'success' | 'error' | 'info'
        title: string
        message: string
        signature?: string
        details?: string | null
    } | null>(null)

    const poolPda = toPublicKey(state?.pool?.publicKey || state?.pool?.poolPda)
    const type = state?.type || 'protocol'

    const fetchPool = useCallback(async (isRetry = false) => {
        if (!program || !poolPda) return
        
        if (!isRetry) setFetching(true)
        try {
            if (!isRetry) await new Promise(r => setTimeout(r, 400))
            
            const data = await (program.account as any).poolState.fetch(poolPda)
            setLocalPool(data)
            if (txState?.status === 'error' && txState.title === 'Fetch Failed') {
                setTxState(null)
            }
        } catch (err: any) {
            console.error('Fetch pool error:', err)
            if (err.message?.includes('429')) {
                setTimeout(() => fetchPool(true), 2000)
            }
        } finally {
            if (!isRetry) setFetching(false)
        }
    }, [program, poolPda?.toBase58()])

    useEffect(() => {
        fetchPool()
    }, [fetchPool])

    if (!state || !state.pool || !poolPda) {
        return (
            <div className="withdraw-page">
                <div className="withdraw-card">
                    <h2>Error</h2>
                    <p>No pool selected for fee collection.</p>
                    <button className="withdraw-confirm" style={{ marginTop: '20px' }} onClick={() => navigate('/admin', { state: { activeTab: state?.fromTab } })}>Back to Admin</button>
                </div>
            </div>
        )
    }

    const pool = localPool || state.pool
    const fees0 = type === 'protocol' 
        ? getBNValue(pool.protocolFeesToken0 || pool.protocolFees0) 
        : getBNValue(pool.fundFeesToken0 || pool.fundFees0)
    const fees1 = type === 'protocol' 
        ? getBNValue(pool.protocolFeesToken1 || pool.protocolFees1) 
        : getBNValue(pool.fundFeesToken1 || pool.fundFees1)

    const dec0 = pool.mint0Decimals ?? pool.mint_0_decimals ?? pool.mintDecimals0 ?? pool.decimals0 ?? 6
    const dec1 = pool.mint1Decimals ?? pool.mint_1_decimals ?? pool.mintDecimals1 ?? pool.decimals1 ?? 6

    const onConfirmCollection = async () => {
        if (!program || !wallet.publicKey || !pool) return
        
        const amount0 = fees0.mul(new anchor.BN(percent)).div(new anchor.BN(100))
        const amount1 = fees1.mul(new anchor.BN(percent)).div(new anchor.BN(100))

        if (amount0.isZero() && amount1.isZero()) {
            setTxState({ status: 'error', title: 'Empty Collection', message: 'No fees available to collect at this time.' })
            return
        }

        setBusy(true)
        setTxState({ status: 'info', title: 'Preparing', message: 'Building transaction...' })

        try {
            const token0Mint = toPublicKey(pool.token0Mint)!
            const token1Mint = toPublicKey(pool.token1Mint)!
            const token0Program = toPublicKey(pool.token0Program)!
            const token1Program = toPublicKey(pool.token1Program)!
            
            const recipient0 = deriveAta(wallet.publicKey, token0Mint, token0Program)
            const recipient1 = deriveAta(wallet.publicKey, token1Mint, token1Program)

            const [authority] = await getAuthAddress(program.programId)
            const method = type === 'protocol' ? (program.methods as any).collectProtocolFee : (program.methods as any).collectFundFee
            
            const tx = new anchor.web3.Transaction()

            const recipient0AtaCtx = await buildEnsureAtaInstruction({
                payer: wallet.publicKey,
                owner: wallet.publicKey,
                mint: token0Mint,
                tokenProgram: token0Program,
            })
            const recipient1AtaCtx = await buildEnsureAtaInstruction({
                payer: wallet.publicKey,
                owner: wallet.publicKey,
                mint: token1Mint,
                tokenProgram: token1Program,
            })

            if (recipient0AtaCtx.instruction) tx.add(recipient0AtaCtx.instruction)
            if (recipient1AtaCtx.instruction) tx.add(recipient1AtaCtx.instruction)

            const ix = await method(amount0, amount1)
                .accounts({
                    owner: wallet.publicKey,
                    authority,
                    poolState: poolPda,
                    ammConfig: toPublicKey(pool.ammConfig)!,
                    token0Vault: toPublicKey(pool.token0Vault)!,
                    token1Vault: toPublicKey(pool.token1Vault)!,
                    vault0Mint: token0Mint,
                    vault1Mint: token1Mint,
                    recipientToken0Account: recipient0,
                    recipientToken1Account: recipient1,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    tokenProgram2022: TOKEN_2022_PROGRAM_ID,
                })
                .instruction()
            
            tx.add(ix)
            
            setTxState({ status: 'info', title: 'Signing', message: 'Please confirm in your wallet' })
            
            const { blockhash } = await connection.getLatestBlockhash()
            tx.recentBlockhash = blockhash
            tx.feePayer = wallet.publicKey

            const sig = await wallet.sendTransaction(tx, connection)
            await connection.confirmTransaction(sig, 'confirmed')
            
            fetchPool()

            setTxState({
                status: 'success',
                title: 'Collection Successful',
                message: `Tx: ${sig.slice(0, 8)}...`,
                signature: sig
            })
        } catch (err: any) {
            setTxState({
                status: 'error',
                title: 'Collection Failed',
                message: 'Transaction failed',
                details: err.message || String(err)
            })
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="withdraw-page">
            <div className="withdraw-card">
                <div className="withdraw-header">
                    <button className="withdraw-close" onClick={() => navigate('/admin', { state: { activeTab: state?.fromTab } })}>x</button>
                    <h2>Collect {type === 'protocol' ? 'Protocol' : 'Fund'} Fees</h2>
                    <p style={{ margin: '8px 0', fontSize: '14px', color: '#fff', fontWeight: 600 }}>Pool: {getPoolDisplayName(toPublicKey(pool.token0Mint)?.toBase58(), toPublicKey(pool.token1Mint)?.toBase58())}</p>
                </div>

                <div className="withdraw-token-box">
                    <div className="withdraw-token-row">
                        <span className="withdraw-token-label">Token 0</span>
                        <div className="withdraw-token-values">
                            <strong>{fetching ? '...' : (Number(fees0.toString()) * percent / 100 / Math.pow(10, dec0)).toFixed(6)}</strong>
                            <small>{fetching ? 'Refreshing...' : `Available: ${(Number(fees0.toString()) / Math.pow(10, dec0)).toFixed(6)}`}</small>
                        </div>
                    </div>
                    <div className="withdraw-token-row">
                        <span className="withdraw-token-label">Token 1</span>
                        <div className="withdraw-token-values">
                            <strong>{fetching ? '...' : (Number(fees1.toString()) * percent / 100 / Math.pow(10, dec1)).toFixed(6)}</strong>
                            <small>{fetching ? 'Refreshing...' : `Available: ${(Number(fees1.toString()) / Math.pow(10, dec1)).toFixed(6)}`}</small>
                        </div>
                    </div>
                </div>

                <div className="withdraw-amount-section">
                    <div className="withdraw-amount-top">
                        <span>Percentage</span>
                        <strong>{percent}%</strong>
                    </div>
                    <input 
                        type="range" 
                        className="withdraw-slider"
                        min="0" max="100" 
                        value={percent} 
                        onChange={(e) => setPercent(Number(e.target.value))}
                        style={{
                            background: `linear-gradient(to right, #36c7ff 0%, #36c7ff ${percent}%, #1d2a47 ${percent}%, #1d2a47 100%)`
                        }}
                    />
                    <div className="withdraw-quick-actions">
                        <button type="button" onClick={() => setPercent(25)}>25%</button>
                        <button type="button" onClick={() => setPercent(50)}>50%</button>
                        <button type="button" onClick={() => setPercent(75)}>75%</button>
                        <button type="button" onClick={() => setPercent(100)}>100%</button>
                    </div>
                </div>

                <div className="withdraw-summary">
                    <h4>Collection Summary</h4>
                    <div className="withdraw-summary-row">
                        <span>Target</span>
                        <span>{type === 'protocol' ? 'Protocol Treasury' : 'Fund Manager'}</span>
                    </div>
                </div>

                {txState && (
                    <TransactionCard
                        status={txState.status}
                        title={txState.title}
                        message={txState.message}
                        signature={txState.signature}
                        explorerUrl={txState.signature ? `https://explorer.solana.com/tx/${txState.signature}?cluster=devnet` : undefined}
                        details={txState.details}
                        onClose={() => {
                            if (txState.status === 'success') {
                                setTxState(null)
                            } else {
                                setTxState(null)
                            }
                        }}
                    />
                )}

                <button 
                    className="withdraw-confirm" 
                    onClick={onConfirmCollection} 
                    disabled={busy || fetching || (fees0.isZero() && fees1.isZero())}
                >
                    {busy ? 'Processing...' : (fees0.isZero() && fees1.isZero() ? 'No Fees Available' : 'Confirm Collection')}
                </button>
            </div>
        </div>
    )
}
