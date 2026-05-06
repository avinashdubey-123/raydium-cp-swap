import { Buffer } from 'buffer'

// Force the npm `buffer` Buffer onto window so full API (isBuffer, from, alloc) exists
;(window as any).Buffer = Buffer

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SolanaProvider } from './utils/SolanaProvider.tsx'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SolanaProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </SolanaProvider>
  </StrictMode>,
)