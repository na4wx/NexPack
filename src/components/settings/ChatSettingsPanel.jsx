import React, { useEffect, useState } from 'react';
import { Box, Stack, TextField, Button, Typography } from '@mui/material';

// Chat shares its NexDigi server connection (host/password) with BBS —
// they're the same running server — but has its own callsign, kept
// separate deliberately: there's no real reason a user's Chat identity
// needs to match their BBS posting identity.
export default function ChatSettingsPanel() {
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [chatCallsign, setChatCallsign] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.nexdigi.bbsGetSettings().then((s) => {
      if (!s) return;
      setHost(s.host || '');
      setPassword(s.password || '');
      setChatCallsign(s.chatCallsign || s.callsign || '');
    });
  }, []);

  const save = async () => {
    await window.nexdigi.bbsSaveSettings({ host: host.trim(), password, chatCallsign: chatCallsign.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <Typography variant="body2" color="text.secondary">
        Chat runs on the same NexDigi server as BBS, so the connection below is shared with the BBS tab —
        saving here updates it for both. Your Chat callsign is its own separate identity.
      </Typography>
      <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost:3010" />
      <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <TextField label="Your Chat callsign" value={chatCallsign} onChange={(e) => setChatCallsign(e.target.value)} placeholder="N0CALL" />
      <Box>
        <Button variant="contained" onClick={save}>Save</Button>
        {saved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>
    </Stack>
  );
}
