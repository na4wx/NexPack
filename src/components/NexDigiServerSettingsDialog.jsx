import React, { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack } from '@mui/material';

// Shared across BBS and Chat — both are real network clients to the same
// running NexDigi server, using the same host/password/callsign, so there's
// only ever one "NexDigi server" connection to configure in NexPack.
export default function NexDigiServerSettingsDialog({ open, onClose, onSaved }) {
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [callsign, setCallsign] = useState('');

  useEffect(() => {
    if (!open) return;
    window.nexdigi.bbsGetSettings().then((s) => {
      if (!s) return;
      setHost(s.host || '');
      setPassword(s.password || '');
      setCallsign(s.callsign || '');
    });
  }, [open]);

  const submit = async () => {
    await window.nexdigi.bbsSaveSettings({ host: host.trim(), password, callsign: callsign.trim() });
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>NexDigi server</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost:3010" autoFocus />
          <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <TextField label="Your callsign" value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="N0CALL" helperText="Used for BBS messages you post and your chat identity" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!host.trim()} onClick={submit}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
