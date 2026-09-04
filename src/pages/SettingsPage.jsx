import React, { useState, useEffect } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import TerminalSettingsPanel from '../components/settings/TerminalSettingsPanel';
import WinlinkSettingsPanel from '../components/settings/WinlinkSettingsPanel';
import ChatSettingsPanel from '../components/settings/ChatSettingsPanel';
import AprsSettingsPanel from '../components/settings/AprsSettingsPanel';
import GeneralSettingsPanel from '../components/settings/GeneralSettingsPanel';

const TABS = [
  { key: 'terminal', label: 'Terminal' },
  { key: 'winlink', label: 'Winlink' },
  { key: 'chat', label: 'NexChat' },
  { key: 'aprs', label: 'APRS' },
  { key: 'general', label: 'General' }
];

export default function SettingsPage({ tncs, initialTab }) {
  const [tab, setTab] = useState(initialTab || 'terminal');

  // initialTab changes when a workspace's own settings icon navigates here
  // targeting a specific tab (e.g. clicking the gear in APRS opens on the
  // APRS tab) — re-sync if the page is re-entered with a different target.
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        {TABS.map((t) => <Tab key={t.key} value={t.key} label={t.label} />)}
      </Tabs>
      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', p: 3 }}>
        {tab === 'terminal' && <TerminalSettingsPanel tncs={tncs} />}
        {tab === 'winlink' && <WinlinkSettingsPanel tncs={tncs} />}
        {tab === 'chat' && <ChatSettingsPanel tncs={tncs} />}
        {tab === 'aprs' && <AprsSettingsPanel tncs={tncs} />}
        {tab === 'general' && <GeneralSettingsPanel />}
      </Box>
    </Box>
  );
}
