import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
    // Chat and local drafts remain available in this tab; offline navigation is not
    // promised when browser settings prevent the static shell from being stored.
    window.dispatchEvent(new CustomEvent('tongpin:offline-shell', { detail: 'unavailable' }));
  });
}
