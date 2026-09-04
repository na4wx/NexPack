import React, { useState, useEffect } from 'react';
import { Box, Drawer, List, ListItemButton, ListItemIcon, Tooltip, Divider } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import RouterIcon from '@mui/icons-material/Router';
import MailIcon from '@mui/icons-material/MailOutline';
import ChatIcon from '@mui/icons-material/ChatBubbleOutline';
import MapIcon from '@mui/icons-material/MapOutlined';
import SettingsIcon from '@mui/icons-material/Settings';
import { useTncs } from './hooks/useTncs';
import TerminalWorkspace from './pages/TerminalWorkspace';
import TncManagerPage from './pages/TncManagerPage';
import WinlinkMail from './pages/WinlinkMail';
import ChatWorkspace from './pages/ChatWorkspace';
import AprsWorkspace from './pages/AprsWorkspace';
import SettingsPage from './pages/SettingsPage';
import TncStatusBar from './components/TncStatusBar';
import appIcon from './assets/app-icon.png';

const RAIL_WIDTH = 76;

const NAV_ITEMS = [
  { key: 'terminal', label: 'Terminal', icon: <TerminalIcon /> },
  { key: 'winlink', label: 'Winlink', icon: <MailIcon /> },
  { key: 'chat', label: 'NexChat', icon: <ChatIcon /> },
  { key: 'aprs', label: 'APRS', icon: <MapIcon /> }
];

export default function App() {
  const [page, setPage] = useState('terminal');
  const [settingsTab, setSettingsTab] = useState('terminal');
  const [showTncStatusBar, setShowTncStatusBar] = useState(true);
  const { tncs, refresh } = useTncs();

  // Starts on Terminal, then switches to the user's configured default
  // page (Settings → General) once it's loaded — a brief flash of Terminal
  // is an acceptable tradeoff against holding up the whole app's first
  // render on a settings-file read.
  useEffect(() => {
    window.nexdigi.appGetSettings().then((s) => {
      if (s.defaultPage && s.defaultPage !== 'terminal') setPage(s.defaultPage);
      setShowTncStatusBar(s.showTncStatusBar !== false);
    });
  }, []);

  // Re-read on every page change (cheap local file) so toggling the status
  // bar in Settings → General takes effect as soon as you leave that page,
  // without needing a dedicated "settings changed" event plumbed through.
  useEffect(() => {
    if (page === 'settings') return;
    window.nexdigi.appGetSettings().then((s) => setShowTncStatusBar(s.showTncStatusBar !== false));
  }, [page]);

  // Each workspace's own settings icon calls this to jump straight to its
  // tab in the unified Settings screen, instead of opening its own dialog.
  const openSettings = (tab) => { setSettingsTab(tab); setPage('settings'); };

  return (
    <Box sx={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <Drawer
        variant="permanent"
        sx={{
          width: RAIL_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': { width: RAIL_WIDTH, boxSizing: 'border-box', alignItems: 'center', pt: 2 }
        }}
      >
        <Box component="img" src={appIcon} alt="NexPack" sx={{ width: 36, height: 36, mb: 2 }} />
        <Divider flexItem sx={{ mb: 1 }} />
        <List sx={{ width: '100%' }}>
          {NAV_ITEMS.map((item) => (
            <Tooltip key={item.key} title={item.comingSoon ? `${item.label} (coming soon)` : item.label} placement="right">
              <span>
                <ListItemButton
                  selected={page === item.key}
                  disabled={item.comingSoon}
                  onClick={() => setPage(item.key)}
                  sx={{ flexDirection: 'column', py: 1.5, mx: 1, borderRadius: 2, mb: 0.5 }}
                >
                  <ListItemIcon sx={{ minWidth: 0, color: page === item.key ? 'primary.main' : 'text.secondary' }}>
                    {item.icon}
                  </ListItemIcon>
                </ListItemButton>
              </span>
            </Tooltip>
          ))}
        </List>
        <Box sx={{ flexGrow: 1 }} />
        <List sx={{ width: '100%' }}>
          <Tooltip title="TNCs & Radios" placement="right">
            <span>
              <ListItemButton
                selected={page === 'tncs'}
                onClick={() => setPage('tncs')}
                sx={{ flexDirection: 'column', py: 1.5, mx: 1, borderRadius: 2, mb: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: 0, color: page === 'tncs' ? 'primary.main' : 'text.secondary' }}>
                  <RouterIcon />
                </ListItemIcon>
              </ListItemButton>
            </span>
          </Tooltip>
          <Tooltip title="Settings" placement="right">
            <span>
              <ListItemButton
                selected={page === 'settings'}
                onClick={() => setPage('settings')}
                sx={{ flexDirection: 'column', py: 1.5, mx: 1, borderRadius: 2 }}
              >
                <ListItemIcon sx={{ minWidth: 0, color: page === 'settings' ? 'primary.main' : 'text.secondary' }}>
                  <SettingsIcon />
                </ListItemIcon>
              </ListItemButton>
            </span>
          </Tooltip>
        </List>
      </Drawer>

      <Box sx={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* The four live workspaces stay mounted at all times and are only
            hidden via CSS — switching nav tabs used to unmount whichever
            page you left, which threw away everything held in that page's
            own React state (docked panel choices, the packet monitor's
            in-memory log, list scroll/search, selection, etc.) even though
            the underlying data was still fine on the backend. TncManager
            and SettingsPage don't hold state worth preserving this way
            (SettingsPage actually needs to remount to pick up a fresh
            initialTab from openSettings()), so those two are left as
            conditional mounts. */}
        <Box sx={{ display: page === 'terminal' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <TerminalWorkspace tncs={tncs} onOpenSettings={openSettings} />
        </Box>
        <Box sx={{ display: page === 'winlink' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <WinlinkMail active={page === 'winlink'} onOpenSettings={openSettings} />
        </Box>
        <Box sx={{ display: page === 'chat' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <ChatWorkspace onOpenSettings={openSettings} />
        </Box>
        <Box sx={{ display: page === 'aprs' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <AprsWorkspace onOpenSettings={openSettings} />
        </Box>
        {page === 'tncs' && <TncManagerPage tncs={tncs} onChange={refresh} />}
        {page === 'settings' && <SettingsPage tncs={tncs} initialTab={settingsTab} />}
      </Box>
      {showTncStatusBar && <TncStatusBar tncs={tncs} />}
      </Box>
    </Box>
  );
}
