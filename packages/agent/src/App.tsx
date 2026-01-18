import React from 'react';
import { UserPortal } from './components/UserPortal';

export default function App() {
  return (
    <UserPortal
      onMinimize={() => (window as any).require?.('electron')?.ipcRenderer?.send('window-hide')}
      isMinimized={false}
      onRestore={() => {}}
      frameless
    />
  );
}
