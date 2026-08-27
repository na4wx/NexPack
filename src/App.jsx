import React, { useState } from 'react';
import { Box, Drawer, List, ListItemButton, ListItemIcon, Tooltip, Typography, Divider } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import RouterIcon from '@mui/icons-material/Router';
import MailIcon from '@mui/icons-material/MailOutline';
import ChatIcon from '@mui/icons-material/ChatBubbleOutline';
import MapIcon from '@mui/icons-material/MapOutlined';
import { useTncs } from './hooks/useTncs';
import TerminalWorkspace from './pages/TerminalWorkspace';
import TncManagerPage from './pages/TncManagerPage';
import MailWorkspace from './pages/MailWorkspace';
import ChatWorkspace from './pages/ChatWorkspace';
import AprsWorkspace from './pages/AprsWorkspace';

const RAIL_WIDTH = 76;

const NAV_ITEMS = [
  { key: 'terminal', label: 'Terminal', icon: <TerminalIcon /> },
  { key: 'tncs', label: 'TNCs & Radios', icon: <RouterIcon /> },
  { key: 'winlink', label: 'Winlink / BBS', icon: <MailIcon /> },
  { key: 'chat', label: 'Chat', icon: <ChatIcon /> },
  { key: 'aprs', label: 'APRS', icon: <MapIcon /> }
];

export default function App() {
  const [page, setPage] = useState('terminal');
  const { tncs, refresh } = useTncs();

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
        <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 1, color: 'primary.main', mb: 2 }}>
          NP
        </Typography>
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
      </Drawer>

      <Box sx={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        {page === 'terminal' && <TerminalWorkspace tncs={tncs} />}
        {page === 'tncs' && <TncManagerPage tncs={tncs} onChange={refresh} />}
        {page === 'winlink' && <MailWorkspace />}
        {page === 'chat' && <ChatWorkspace />}
        {page === 'aprs' && <AprsWorkspace tncs={tncs} />}
      </Box>
    </Box>
  );
}
