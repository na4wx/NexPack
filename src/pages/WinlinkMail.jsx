import React, { useEffect, useRef, useState } from 'react';
import { Box, Stack, Tabs, Tab, Button, IconButton, Typography, MenuItem, Select, Chip, Alert } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import CallMadeIcon from '@mui/icons-material/CallMade';
import CallEndIcon from '@mui/icons-material/CallEnd';
import MessageList from '../components/MessageList';
import MessageReadPane from '../components/MessageReadPane';
import ComposeDialog from '../components/ComposeDialog';

const FOLDERS = [
  { key: 'in', label: 'Inbox' },
  { key: 'out', label: 'Outbox' },
  { key: 'sent', label: 'Sent' },
  { key: 'archive', label: 'Archive' }
];

export default function WinlinkMail({ onOpenSettings }) {
  const [configured, setConfigured] = useState(null); // null = unknown yet
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [folder, setFolder] = useState('in');
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [aliases, setAliases] = useState({});
  const [connectAlias, setConnectAlias] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [log, setLog] = useState([]);
  const logRef = useRef(null);

  const boot = async () => {
    const settings = await window.nexdigi.winlinkGetSettings();
    setConfigured(!!settings);
    if (!settings) return;
    setStarting(true);
    setStartError(null);
    try {
      await window.nexdigi.winlinkStart();
      const a = await window.nexdigi.winlinkGetConnectAliases();
      setAliases(a || {});
      const keys = Object.keys(a || {});
      if (keys.length) setConnectAlias(keys[0]);
      await refreshFolder('in');
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => { boot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const off = window.nexdigi.onWinlinkLog((line) => setLog((prev) => [...prev.slice(-200), line]));
    return off;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const refreshFolder = async (f) => {
    setFolder(f);
    setSelected(null);
    try {
      const list = await window.nexdigi.winlinkListMessages(f);
      setMessages(list || []);
    } catch (e) { setMessages([]); }
  };

  const openMessage = async (m) => {
    const full = await window.nexdigi.winlinkGetMessage(folder, m.MID);
    setSelected(full);
    if (folder === 'in' && full.Unread) {
      await window.nexdigi.winlinkMarkRead(folder, m.MID, true);
      refreshFolder(folder);
    }
  };

  const send = async ({ to, cc, subject, body }) => {
    await window.nexdigi.winlinkSendMessage({ to, cc, subject, body });
    if (folder === 'out') refreshFolder('out');
  };

  const doConnect = async () => {
    if (!connectAlias) return;
    setConnecting(true);
    try {
      await window.nexdigi.winlinkConnect(aliases[connectAlias]);
      await refreshFolder(folder);
    } catch (e) {
      setLog((prev) => [...prev.slice(-200), `Connect failed: ${e.message}`]);
    } finally {
      setConnecting(false);
    }
  };

  if (configured === false) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1 }}>Set up Winlink</Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Add your callsign and Winlink account to start sending and receiving real Winlink email.
        </Typography>
        <Button variant="contained" onClick={() => onOpenSettings('winlink')}>Winlink settings</Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setComposeOpen(true)}>Compose</Button>
        <Select size="small" value={connectAlias} onChange={(e) => setConnectAlias(e.target.value)} displayEmpty sx={{ minWidth: 220 }}>
          {Object.keys(aliases).length === 0 && <MenuItem value="" disabled>No connect targets configured</MenuItem>}
          {Object.keys(aliases).map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
        </Select>
        <Button size="small" startIcon={<CallMadeIcon />} disabled={!connectAlias || connecting} onClick={doConnect}>
          {connecting ? 'Connecting…' : 'Connect'}
        </Button>
        <Button size="small" color="error" startIcon={<CallEndIcon />} onClick={() => window.nexdigi.winlinkDisconnect(true)}>
          Disconnect
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {starting && <Chip size="small" label="Starting pat…" />}
        <IconButton size="small" onClick={() => onOpenSettings('winlink')}><SettingsIcon fontSize="small" /></IconButton>
      </Stack>

      {startError && <Alert severity="error" sx={{ m: 1 }}>{startError}</Alert>}

      <Tabs value={folder} onChange={(_e, v) => refreshFolder(v)} sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}>
        {FOLDERS.map((f) => <Tab key={f.key} value={f.key} label={f.label} sx={{ minHeight: 36, py: 0.5 }} />)}
      </Tabs>

      <Box sx={{ flexGrow: 1, display: 'flex', minHeight: 0 }}>
        <Box sx={{ width: 340, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
          <MessageList
            messages={messages}
            selectedId={selected && selected.MID}
            onSelect={openMessage}
            getId={(m) => m.MID}
            getSubject={(m) => m.Subject}
            getFrom={(m) => (m.From && m.From.Addr) || ''}
            getDate={(m) => new Date(m.Date).toLocaleString()}
            getUnread={(m) => m.Unread}
          />
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <MessageReadPane
            message={selected}
            subject={selected && selected.Subject}
            from={selected && selected.From && selected.From.Addr}
            to={selected && selected.To && selected.To.map((t) => t.Addr).join(', ')}
            date={selected && new Date(selected.Date).toLocaleString()}
            body={selected && selected.Body}
            onReply={selected ? () => setComposeOpen(true) : null}
            onArchive={selected ? async () => { await window.nexdigi.winlinkArchiveMessage(folder, selected.MID); refreshFolder(folder); } : null}
            onDelete={selected ? async () => { await window.nexdigi.winlinkDeleteMessage(folder, selected.MID); refreshFolder(folder); } : null}
          />
        </Box>
      </Box>

      <Box ref={logRef} sx={{ height: 100, overflowY: 'auto', borderTop: 1, borderColor: 'divider', p: 1, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'text.secondary' }}>
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </Box>

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onSend={send}
        showCc
        initialTo={selected ? selected.From.Addr : ''}
        initialSubject={selected ? `Re: ${selected.Subject}` : ''}
      />
    </Box>
  );
}
