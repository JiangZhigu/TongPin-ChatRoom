import './sandbox/network';
import './sandbox/navigation';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { Controls } from './sandbox/Controls';
import { initializeAssets } from './sandbox/models';
import { demoPath } from './sandbox/navigation';
import './styles.css';
function DemoRoot() { const [identity, setIdentity] = useState(0); const [path, setPath] = useState(demoPath); useEffect(() => { const change = () => setIdentity(x=>x+1); const nav = () => setPath(demoPath()); window.addEventListener('demo:identity', change); window.addEventListener('demo:navigation', nav); return () => { window.removeEventListener('demo:identity', change); window.removeEventListener('demo:navigation', nav); }; }, []); return <App key={identity + ':' + (path.startsWith('/admin') ? 'admin' : 'chat')}/>; }
void initializeAssets().then(() => { ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><DemoRoot/></React.StrictMode>); ReactDOM.createRoot(document.getElementById('demo-controls')!).render(<Controls/>); });
