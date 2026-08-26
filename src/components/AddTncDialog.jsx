import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack
} from '@mui/material';

const TYPE_LABELS = {
  serial: 'Serial (KISS)',
  'kiss-tcp': 'KISS over TCP',
  agwpe: 'AGWPE'
};

export default function AddTncDialog({ open, onClose, onCreated }) {
  const [type, setType] = useState('serial');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState(9600);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(8001);
  const [serialPorts, setSerialPorts] = useState([]);

  useEffect(() => {
    if (open && type === 'serial') {
      window.nexdigi.listSerialPorts().then(setSerialPorts);
    }
  }, [open, type]);

  useEffect(() => {
    if (!open) return;
    setName(''); setPath(''); setBaud(9600); setHost('127.0.0.1');
    setPort(type === 'agwpe' ? 8000 : 8001);
  }, [open, type]);

  const canSubmit = name.trim() && (type === 'serial' ? path : host && port);

  const submit = async () => {
    const connection = type === 'serial' ? { path, baud: Number(baud) } : { host, port: Number(port) };
    await window.nexdigi.createTnc({ name: name.trim(), type, connection });
    onCreated();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add TNC</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(TYPE_LABELS).map(([v, label]) => (
              <MenuItem key={v} value={v}>{label}</MenuItem>
            ))}
          </TextField>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Home TNC" autoFocus />

          {type === 'serial' ? (
            <>
              <TextField select label="Serial port" value={path} onChange={(e) => setPath(e.target.value)}>
                {serialPorts.length === 0 && <MenuItem value="" disabled>No serial ports detected</MenuItem>}
                {serialPorts.map((p) => (
                  <MenuItem key={p.path} value={p.path}>{p.path}{p.manufacturer ? ` (${p.manufacturer})` : ''}</MenuItem>
                ))}
              </TextField>
              <TextField label="Baud rate" type="number" value={baud} onChange={(e) => setBaud(e.target.value)} />
            </>
          ) : (
            <>
              <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} />
              <TextField label="Port" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!canSubmit} onClick={submit}>Add</Button>
      </DialogActions>
    </Dialog>
  );
}
