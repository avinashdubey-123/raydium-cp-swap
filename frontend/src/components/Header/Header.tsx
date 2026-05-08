import './Header.css'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { NavLink } from 'react-router-dom'
import { useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import raydiumLogo from '../../assets/raydium-logo.svg'

const ADMIN_ID = new PublicKey('wE2EtwuovRxvXZoThsXhRTuCrFdAA1jTbLnJp9nfezL')

export default function Header() {
  const { publicKey } = useWallet()
  const isAdmin = publicKey?.equals(ADMIN_ID)

  return (
    <header className="rcs-header">
        <NavLink to='/' className="rcs-logo">
          <img src={raydiumLogo} />
        </NavLink>
        <nav className="rcs-nav">
          <NavLink to='/' className="rcs-nav__item">Swap</NavLink>
          <NavLink to='/liquidity' className="rcs-nav__item">Liquidity</NavLink>
          <NavLink to='/portfolio' className="rcs-nav__item">Portfolio</NavLink>
          {isAdmin && <NavLink to='/admin' className="rcs-nav__item">Admin</NavLink>}
        </nav>
        <div className="rcs-actions">
          <WalletMultiButton />
        </div>
    </header>
  )
}
