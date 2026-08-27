import React, { useEffect, useState } from 'react';
import { Box, Stack, Tabs, Tab, Button, IconButton, Typography, Chip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import RefreshIcon from '@mui/icons-material/Refresh';
import MessageList from '../components/MessageList';
import MessageReadPane from '../components/MessageReadPane';
import ComposeDialog from '../components/ComposeDialog';
import BbsSettingsDialog from '../components/BbsSettingsDialog';

const CATEGORY_LABEL = { P: 'Personal', B: 'Bulletin', T: 'Traffic', E: 'Emergency', A: 'Admin' };

export default function BbsMail({ tncs }) {
  const [configured, setConfigured] = useState(null);
  const [transport, setTransport] = useState('http');
  const [view, setView] = useState('messages'); // 'messages' | 'bulletins'
  const [messages, setMessages] = useState([]);
  const [bulletins, setBulletins] = useState([]);
  const [selected, setSelected] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const boot = async () => {
    const [settings, t] = await Promise.all([window.nexdigi.bbsGetSettings(), window.nexdigi.bbsGetTransport()]);
    setTransport(t || 'http');
    // RF transport doesn't need the HTTP settings object at all — only gate
    // on "configured" for HTTP mode, RF mode is always usable once its own
    // settings are entered in the dialog (checked lazily when refresh fails).
    setConfigured(t === 'rf' ? true : !!settings);
    if (t === 'rf' || settings) await refresh();
  };

  useEffect(() => { boot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    setLoadError(null);
    try {
      const [msgs, bulls] = await Promise.all([window.nexdigi.bbsListMessages({}), window.nexdigi.bbsListBulletins()]);
      setMessages(msgs || []);
      setBulletins(bulls || []);
    } catch (e) {
      setLoadError(e.message);
    }
  };

  const send = async ({ to, subject, body }) => {
    await window.nexdigi.bbsPostMessage({ recipient: to, subject, content: body, category: 'P' });
    refresh();
  };

  const openMessage = async (m) => {
    setSelected(m);
    if (!m.read || m.content == null) {
      const full = await window.nexdigi.bbsMarkRead(m.messageNumber);
      if (full && typeof full === 'object' && full.content !== undefined) {
        // RF path returns the full parsed message (with content); HTTP's
        // markRead returns {success:true} and has no .content, so this
        // merge is a no-op there — behavior is unchanged for HTTP.
        const merged = { ...m, ...full };
        setSelected(merged);
        setMessages((prev) => prev.map((x) => (x.messageNumber === m.messageNumber ? merged : x)));
        setBulletins((prev) => prev.map((x) => (x.messageNumber === m.messageNumber ? merged : x)));
      }
      refresh();
    }
  };

  const list = view === 'messages' ? messages : bulletins;

  if (configured === false) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1 }}>Connect to a NexDigi server or radio</Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          BBS messages live on your NexDigi digipeater — connect over the internet or directly over RF to read and post them.
        </Typography>
        <Button variant="contained" onClick={() => setSettingsOpen(true)}>BBS settings</Button>
        <BbsSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={boot} tncs={tncs} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setComposeOpen(true)}>Compose</Button>
        <IconButton size="small" onClick={refresh}><RefreshIcon fontSize="small" /></IconButton>
        <Chip size="small" label={transport === 'rf' ? 'Radio (RF)' : 'Internet'} color={transport === 'rf' ? 'success' : 'default'} />
        <Box sx={{ flexGrow: 1 }} />
        {loadError && <Chip size="small" color="error" label={loadError} />}
        <IconButton size="small" onClick={() => setSettingsOpen(true)}><SettingsIcon fontSize="small" /></IconButton>
      </Stack>

      <Tabs value={view} onChange={(_e, v) => { setView(v); setSelected(null); }} sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}>
        <Tab value="messages" label="Messages" sx={{ minHeight: 36, py: 0.5 }} />
        <Tab value="bulletins" label="Bulletins" sx={{ minHeight: 36, py: 0.5 }} />
      </Tabs>

      <Box sx={{ flexGrow: 1, display: 'flex', minHeight: 0 }}>
        <Box sx={{ width: 340, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
          <MessageList
            messages={list}
            selectedId={selected && selected.messageNumber}
            onSelect={openMessage}
            getId={(m) => m.messageNumber}
            getSubject={(m) => `${m.subject}${m.category ? ` [${CATEGORY_LABEL[m.category] || m.category}]` : ''}`}
            getFrom={(m) => m.sender}
            getDate={(m) => new Date(m.timestamp).toLocaleString()}
            getUnread={(m) => !m.read}
          />
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <MessageReadPane
            message={selected}
            subject={selected && selected.subject}
            from={selected && selected.sender}
            to={selected && selected.recipient}
            date={selected && new Date(selected.timestamp).toLocaleString()}
            body={selected && selected.content}
            onReply={selected ? () => setComposeOpen(true) : null}
            onDelete={selected ? async () => { await window.nexdigi.bbsDeleteMessage(selected.messageNumber); setSelected(null); refresh(); } : null}
          />
        </Box>
      </Box>

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onSend={send}
        initialTo={selected ? selected.sender : ''}
        initialSubject={selected ? `Re: ${selected.subject}` : ''}
        subjectDisabled={transport === 'rf'}
        subjectHelperText={transport === 'rf' ? 'RF-sent messages are always stored with subject "BBS Message" — this field is ignored over radio.' : null}
      />
      <BbsSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={boot} tncs={tncs} />
    </Box>
  );
}
