import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// All three elah stylesheets, in this order, then ours last so it wins.
import '@elah/timeline/styles.css'
import '@elah/editor/styles.css'
import '@elah/editor/styles/tokens.css'
import './app.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
