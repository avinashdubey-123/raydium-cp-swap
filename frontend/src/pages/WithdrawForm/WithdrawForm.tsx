import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import TransactionCard from '../../components/TransactionCard/TransactionCard'
import {
    getAccount,
    getAssociatedTokenAddressSync,
    getMint,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import useProgram from '../../utils/useProgram'
import { getAuthAddress, getPoolLpMintAddress, getPoolVaultAddress } from '../../utils/pda'
import { ConstantProductCurve } from '../../utils/curve/constantProduct'
import { RoundDirection } from '../../utils/curve/calculator'
import { computeTransferFeeForPre } from '../../utils/curve/fee'
import { logActivity } from '../../utils/activity'
import './WithdrawForm.css'

export type WithdrawState = {
    name?: string
    poolPda?: string
    token0?: string
    token1?: string
    token0Symbol?: string
    token1Symbol?: string
    lpAmount?: number
    token0Amount?: number
    token1Amount?: number
    token0Value?: number | null
    token1Value?: number | null
    totalValue?: number | null
}

type WithdrawFormProps = {
    state?: WithdrawState
    onClose?: () => void
    embedded?: boolean
}

type WithdrawQuote = {
    lpInput: BN
    receive0: BN
    receive1: BN
    token0Symbol: string
    token1Symbol: string
    token0Ui: string
    token1Ui: string
}

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

const formatBaseUnitsToHuman = (amount: BN, decimals: number) => {
    const raw = amount.toString(10)
    if (decimals === 0) return raw
    const padded = raw.padStart(decimals + 1, '0')
    const whole = padded.slice(0, -decimals)
    const fraction = padded.slice(-decimals).replace(/0+$/, '')
    return fraction.length ? `${whole}.${fraction}` : whole
}

const toPublicKey = (value?: string | PublicKey | null) => {
    if (!value) return null
    if (value instanceof PublicKey) return value
    try {
        return new PublicKey(value)
    } catch {
        return null
    }
}

const detectTokenProgram = async (connectionRef: any, mint: PublicKey) => {
    const info = await connectionRef.getAccountInfo(mint)
    if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`)
    if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
    return TOKEN_PROGRAM_ID
}

function WithdrawFormContent({ state, onClose, embedded = false }: { state: WithdrawState; onClose: () => void; embedded?: boolean }) {
    const [percent, setPercent] = useState(100)
    const [keepPositionOpen, setKeepPositionOpen] = useState(false)
    const [quote, setQuote] = useState<WithdrawQuote | null>(null)
    const [quoteLoading, setQuoteLoading] = useState(false)
    const [busy, setBusy] = useState(false)

    type TxState = {
        status: 'success' | 'error' | 'info'
        title: string
        message: string
        signature?: string
        details?: string | null
    } | null

    const [txState, setTxState] = useState<TxState>(null)

    const program = useProgram()
    const { connection } = useConnection()
    const wallet = useWallet()

    const poolName = state.name || `${state.token0Symbol || 'TOKEN0'}/${state.token1Symbol || 'TOKEN1'}`
    const token0Symbol = state.token0Symbol || 'TOKEN0'
    const token1Symbol = state.token1Symbol || 'TOKEN1'

    const outputToken0 = useMemo(() => {
        if (!quote) return 0
        return Number(quote.token0Ui || 0)
    }, [quote])

    const outputToken1 = useMemo(() => {
        if (!quote) return 0
        return Number(quote.token1Ui || 0)
    }, [quote])

    const getExplorerUrl = (sig?: string) =>
        sig ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : undefined

    const onQuickPercent = (value: number) => setPercent(value)

    const onConfirmWithdraw = async () => {
        if (!program || !wallet.publicKey) {
            setTxState({ status: 'error', title: 'Wallet Not Connected', message: 'Connect wallet to withdraw' })
            return
        }
        if (!quote) {
            setTxState({ status: 'error', title: 'Quote unavailable', message: 'Quote unavailable' })
            return
        }
        const poolPda = toPublicKey(state.poolPda)
        if (!poolPda) {
            setTxState({ status: 'error', title: 'Missing pool', message: 'Missing pool address' })
            return
        }

        setBusy(true)
        setTxState({ status: 'info', title: 'Preparing', message: 'Preparing withdraw transaction...' })

        try {
            const programId = (program as any).programId as PublicKey
            const poolStateAcct: any = await (program.account as any).poolState.fetch(poolPda)
            const token0Mint = new PublicKey(poolStateAcct.token0Mint)
            const token1Mint = new PublicKey(poolStateAcct.token1Mint)

            const [lpMint] = await getPoolLpMintAddress(poolPda, programId)
            const [token0Vault] = await getPoolVaultAddress(poolPda, token0Mint, programId)
            const [token1Vault] = await getPoolVaultAddress(poolPda, token1Mint, programId)

            const token0Program = await detectTokenProgram(connection, token0Mint)
            const token1Program = await detectTokenProgram(connection, token1Mint)
            const lpTokenProgram = await detectTokenProgram(connection, lpMint)

            const ownerLpToken = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, lpTokenProgram as PublicKey)
            const ownerToken0Account = getAssociatedTokenAddressSync(token0Mint, wallet.publicKey, false, token0Program as PublicKey)
            const ownerToken1Account = getAssociatedTokenAddressSync(token1Mint, wallet.publicKey, false, token1Program as PublicKey)

            const [authority] = await getAuthAddress(programId)

            setTxState({ status: 'info', title: 'Sending', message: 'Sending withdraw transaction...' })
            const tx = await program.methods
                .withdraw(new anchor.BN(quote.lpInput.toString()), new anchor.BN(quote.receive0.toString()), new anchor.BN(quote.receive1.toString()))
                .accounts({
                    owner: wallet.publicKey,
                    authority,
                    poolState: poolPda,
                    ownerLpToken,
                    token0Account: ownerToken0Account,
                    token1Account: ownerToken1Account,
                    token0Vault,
                    token1Vault,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    tokenProgram2022: TOKEN_2022_PROGRAM_ID,
                    vault0Mint: token0Mint,
                    vault1Mint: token1Mint,
                    lpMint,
                    memoProgram: MEMO_PROGRAM_ID,
                })
                .rpc({
                    skipPreflight: true,
                    commitment: 'confirmed'
                })

            setTxState({
                status: 'success',
                title: 'Withdraw Submitted',
                message: `Tx: ${tx.slice(0, 8)}...`,
                signature: tx,
            })
            logActivity({
                actionType: 'Withdraw',
                poolAddress: state.poolPda,
                tokenPair: `${token0Symbol}/${token1Symbol}`,
                signature: tx,
                status: 'success',
            })
        } catch (err: any) {
            const message = err?.message || String(err)
            setTxState({
                status: 'error',
                title: 'Withdraw Failed',
                message: 'Transaction failed',
                details: message,
            })
            console.error('Withdraw failed:', err)
        } finally {
            setBusy(false)
        }
    }

    useEffect(() => {
        let cancelled = false
        const loadQuote = async () => {
            if (!program || !wallet.publicKey) return
            const poolPda = toPublicKey(state.poolPda)
            if (!poolPda) return

            setQuoteLoading(true)

            try {
                const programId = (program as any).programId as PublicKey
                const poolStateAcct: any = await (program.account as any).poolState.fetch(poolPda)
                const token0Mint = new PublicKey(poolStateAcct.token0Mint)
                const token1Mint = new PublicKey(poolStateAcct.token1Mint)

                const [lpMint] = await getPoolLpMintAddress(poolPda, programId)
                const [token0Vault] = await getPoolVaultAddress(poolPda, token0Mint, programId)
                const [token1Vault] = await getPoolVaultAddress(poolPda, token1Mint, programId)

                const token0Program = await detectTokenProgram(connection, token0Mint)
                const token1Program = await detectTokenProgram(connection, token1Mint)
                const lpTokenProgram = await detectTokenProgram(connection, lpMint)

                const mint0 = await getMint(connection, token0Mint, 'confirmed', token0Program)
                const mint1 = await getMint(connection, token1Mint, 'confirmed', token1Program)
                const lpMintAcct = await getMint(connection, lpMint, 'confirmed', lpTokenProgram)

                const vault0Acct = await getAccount(connection, token0Vault, 'confirmed', token0Program)
                const vault1Acct = await getAccount(connection, token1Vault, 'confirmed', token1Program)

                const poolVault0Amount = new BN(vault0Acct.amount.toString())
                const poolVault1Amount = new BN(vault1Acct.amount.toString())

                const lpSupplyFromState = new BN(poolStateAcct.lpSupply?.toString?.() ?? lpMintAcct.supply.toString())

                const proto0 = new BN(poolStateAcct.protocolFeesToken0?.toString?.() ?? poolStateAcct.protocolFeesToken0 ?? 0)
                const fund0 = new BN(poolStateAcct.fundFeesToken0?.toString?.() ?? poolStateAcct.fundFeesToken0 ?? 0)
                const creator0 = new BN(poolStateAcct.creatorFeesToken0?.toString?.() ?? poolStateAcct.creatorFeesToken0 ?? 0)
                const feesToken0 = proto0.add(fund0).add(creator0)

                const proto1 = new BN(poolStateAcct.protocolFeesToken1?.toString?.() ?? poolStateAcct.protocolFeesToken1 ?? 0)
                const fund1 = new BN(poolStateAcct.fundFeesToken1?.toString?.() ?? poolStateAcct.fundFeesToken1 ?? 0)
                const creator1 = new BN(poolStateAcct.creatorFeesToken1?.toString?.() ?? poolStateAcct.creatorFeesToken1 ?? 0)
                const feesToken1 = proto1.add(fund1).add(creator1)

                const totalVault0 = poolVault0Amount.sub(feesToken0)
                const totalVault1 = poolVault1Amount.sub(feesToken1)

                const ownerLpToken = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, lpTokenProgram as PublicKey)
                const ownerLpAcct = await getAccount(connection, ownerLpToken, 'confirmed', lpTokenProgram)
                const ownerLpBalance = new BN(ownerLpAcct.amount.toString())

                const effectivePercent = keepPositionOpen && percent >= 100 ? 99.5 : percent
                const percentBps = Math.round(effectivePercent * 100)
                const lpInput = ownerLpBalance.mul(new BN(percentBps)).add(new BN(9999)).div(new BN(10000))

                if (lpInput.isZero()) {
                    if (!cancelled) {
                        setQuote({
                            lpInput,
                            receive0: new BN(0),
                            receive1: new BN(0),
                            token0Symbol,
                            token1Symbol,
                            token0Ui: '0',
                            token1Ui: '0',
                        })
                    }
                    return
                }

                const results = ConstantProductCurve.lpTokensToTradingTokens(
                    lpInput,
                    lpSupplyFromState,
                    totalVault0,
                    totalVault1,
                    RoundDirection.Floor
                )

                const token0Amount = results.tokenAmount0
                const token1Amount = results.tokenAmount1

                const fee0 = await computeTransferFeeForPre(connection, token0Mint, token0Amount)
                const fee1 = await computeTransferFeeForPre(connection, token1Mint, token1Amount)

                const receive0 = token0Amount.sub(fee0)
                const receive1 = token1Amount.sub(fee1)

                const token0Ui = formatBaseUnitsToHuman(receive0, mint0.decimals)
                const token1Ui = formatBaseUnitsToHuman(receive1, mint1.decimals)

                if (!cancelled) {
                    setQuote({
                        lpInput,
                        receive0,
                        receive1,
                        token0Symbol,
                        token1Symbol,
                        token0Ui,
                        token1Ui,
                    })
                }
            } catch (err: any) {
                if (!cancelled) {
                    setTxState({ status: 'error', title: 'Unknown Error', message: err?.message || String(err) })
                    setQuote(null)
                }
            } finally {
                if (!cancelled) setQuoteLoading(false)
            }
        }

        loadQuote()
        return () => { cancelled = true }
    }, [program, wallet.publicKey, connection, state.poolPda, percent, keepPositionOpen, token0Symbol, token1Symbol])

    return (
        <div className={embedded ? 'withdraw-page withdraw-page--embedded' : 'withdraw-page'}>
            <div className="withdraw-card">
                <div className="withdraw-header">
                    <button className="withdraw-close" onClick={onClose} aria-label="Close withdraw form">
                        x
                    </button>
                    <h2>Remove Liquidity</h2>
                    <p>{poolName}</p>
                </div>

                <div className="withdraw-token-box">
                    <div className="withdraw-token-row">
                        <span className="withdraw-token-label">{token0Symbol}</span>
                        <div className="withdraw-token-values">
                            <strong>{outputToken0.toFixed(6)}</strong>
                            <small>{quoteLoading ? 'Updating...' : 'Selected amount'}</small>
                        </div>
                    </div>
                    <div className="withdraw-token-row">
                        <span className="withdraw-token-label">{token1Symbol}</span>
                        <div className="withdraw-token-values">
                            <strong>{outputToken1.toFixed(6)}</strong>
                            <small>{quoteLoading ? 'Updating...' : 'Selected amount'}</small>
                        </div>
                    </div>
                </div>

                <div className="withdraw-amount-section">
                    <div className="withdraw-amount-top">
                        <span>Amount</span>
                        <strong>{percent}%</strong>
                    </div>

                    <input
                        className="withdraw-slider"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={percent}
                        onChange={(e) => setPercent(Number(e.target.value))}
                        aria-label="Withdraw percentage"
                        style={{
                            background: `linear-gradient(to right, #36c7ff 0%, #36c7ff ${percent}%, #1d2a47 ${percent}%, #1d2a47 100%)`
                        }}
                    />

                    <div className="withdraw-quick-actions">
                        <button type="button" onClick={() => onQuickPercent(25)}>25%</button>
                        <button type="button" onClick={() => onQuickPercent(50)}>50%</button>
                        <button type="button" onClick={() => onQuickPercent(75)}>75%</button>
                        <button type="button" onClick={() => onQuickPercent(100)}>100%</button>
                    </div>

                    <label className="withdraw-keep-open">
                        <input
                            type="checkbox"
                            checked={keepPositionOpen}
                            onChange={(e) => setKeepPositionOpen(e.target.checked)}
                        />
                        <span>Keep my position open</span>
                    </label>
                </div>

                <div className="withdraw-summary">
                    <h4>You will receive</h4>
                    <div className="withdraw-summary-row">
                        <span>Pooled assets</span>
                        <span>{outputToken0.toFixed(4)} {token0Symbol} + {outputToken1.toFixed(4)} {token1Symbol}</span>
                    </div>
                </div>

                {txState && (
                    <TransactionCard
                        status={txState.status}
                        title={txState.title}
                        message={txState.message}
                        signature={txState.signature}
                        explorerUrl={getExplorerUrl(txState.signature)}
                        details={txState.details}
                        onClose={() => setTxState(null)}
                    />
                )}
                <button className="withdraw-confirm" onClick={onConfirmWithdraw} disabled={busy || quoteLoading}>Confirm</button>
            </div>
        </div>
    )
}

export default function WithdrawForm(props?: WithdrawFormProps) {
    const navigate = useNavigate()
    const location = useLocation()
    const state = ((props?.state || location.state) as WithdrawState) || {}

    if (props?.state) {
        return (
            <WithdrawFormContent
                state={state}
                onClose={props.onClose || (() => navigate('/portfolio'))}
                embedded={props.embedded}
            />
        )
    }

    return <WithdrawFormContent state={state} onClose={() => navigate('/portfolio')} />
}
