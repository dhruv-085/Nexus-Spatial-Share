// Basic polyfills for browser compatibility
if (typeof (window as any).global === 'undefined') {
  (window as any).global = window;
}
if (typeof (window as any).process === 'undefined') {
  (window as any).process = { 
    nextTick: (fn: any) => setTimeout(fn, 0),
    browser: true,
    env: { NODE_ENV: 'development' }
  };
}
if (typeof (window as any).$RefreshReg$ === 'undefined') {
  (window as any).$RefreshReg$ = () => {};
}
if (typeof (window as any).$RefreshSig$ === 'undefined') {
  (window as any).$RefreshSig$ = () => (type: any) => type;
}
(window as any).__vite_plugin_react_preamble_installed__ = true;

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
