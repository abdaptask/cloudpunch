import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) {
  throw new Error('CloudPunch: #root element not found in index.html');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
