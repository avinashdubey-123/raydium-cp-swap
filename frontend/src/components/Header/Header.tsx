import './Header.css'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { NavLink, useLocation } from 'react-router-dom'
import { useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import raydiumLogo from '../../assets/raydium-logo.svg'

const ADMIN_ID = new PublicKey('wE2EtwuovRxvXZoThsXhRTuCrFdAA1jTbLnJp9nfezL')

export default function Header() {
  const { publicKey } = useWallet()
  const location = useLocation()
  const isAdmin = publicKey?.equals(ADMIN_ID)
  const liquidityActive = location.pathname === '/' || location.pathname === '/liquidity'

  return (
    <header className="rcs-header">
        <NavLink to='/liquidity' className="rcs-logo">
          <img src={raydiumLogo} />
        </NavLink>
        <nav className="rcs-nav">
          <NavLink to='/swap' className="rcs-nav__item">Swap</NavLink>
          <NavLink to='/liquidity' className={`rcs-nav__item${liquidityActive ? ' active' : ''}`}>Liquidity</NavLink>
          <NavLink to='/portfolio' className="rcs-nav__item">Portfolio</NavLink>
          {isAdmin && <NavLink to='/admin' className="rcs-nav__item">Admin</NavLink>}
        </nav>
        <div className="rcs-actions">
          <WalletMultiButton />
        </div>
    </header>
  )
}
