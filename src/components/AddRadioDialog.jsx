import React, { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack } from '@mui/material';

export default function AddRadioDialog({ tnc, onClose, onCreated }) {
  const [callsign, setCallsign] = useState('');
  const [name, setName] = useState('');
  const [portNumber, setPortNumber] = useState(0);

  useEffect(() => {
    setCallsign(''); setName(''); setPortNumber(0);
  }, [tnc]);

  if (!tnc) return null;

  const submit = async () => {
    await window.nexdigi.addRadio(tnc.id, { callsign: callsign.trim().toUpperCase(), name: name.trim(), portNumber: Number(portNumber) });
    onCreated();
  };

  return (
    <Dialog open={!!tnc} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add radio to {tnc.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Callsign" value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="N0CALL-1" autoFocus />
          <TextField label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2m VHF" />
          <TextField
            label="KISS/AGWPE port number"
            type="number"
            value={portNumber}
            onChange={(e) => setPortNumber(e.target.value)}
            helperText="0 for a single-radio TNC; higher for additional radios on a multi-port TNC"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!callsign.trim()} onClick={submit}>Add</Button>
      </DialogActions>
    </Dialog>
  );
}
