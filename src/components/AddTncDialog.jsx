import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack, Alert
} from '@mui/material';

const TYPE_LABELS = {
  serial: 'Serial (KISS)',
  'kiss-tcp': 'KISS over TCP',
  agwpe: 'AGWPE',
  soundmodem: 'Built-in Sound Modem (Direwolf)'
};

const PTT_METHOD_LABELS = {
  vox: 'VOX (radio/interface keys itself)',
  cm108: 'CM108 GPIO (most USB sound-card interfaces)',
  rts: 'Serial port RTS',
  dtr: 'Serial port DTR',
  none: 'None (receive only / testing)'
};

export default function AddTncDialog({ open, onClose, onCreated }) {
  const [type, setType] = useState('serial');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState(9600);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(8001);
  const [serialPorts, setSerialPorts] = useState([]);
  const [audioInputDevice, setAudioInputDevice] = useState('');
  const [audioOutputDevice, setAudioOutputDevice] = useState('');
  const [pttMethod, setPttMethod] = useState('vox');
  const [pttDevice, setPttDevice] = useState('');

  useEffect(() => {
    if (open && (type === 'serial' || type === 'soundmodem')) {
      window.nexdigi.listSerialPorts().then(setSerialPorts);
    }
  }, [open, type]);

  useEffect(() => {
    if (!open) return;
    setName(''); setPath(''); setBaud(9600); setHost('127.0.0.1');
    setPort(type === 'agwpe' ? 8000 : 8001);
    setAudioInputDevice(''); setAudioOutputDevice(''); setPttMethod('vox'); setPttDevice('');
  }, [open, type]);

  const canSubmit = name.trim() && (
    type === 'serial' ? path
      : type === 'soundmodem' ? true
        : host && port
  );

  const submit = async () => {
    const connection = type === 'serial' ? { path, baud: Number(baud) }
      : type === 'soundmodem' ? { audioInputDevice, audioOutputDevice, pttMethod, pttDevice }
        : { host, port: Number(port) };
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
          ) : type === 'soundmodem' ? (
            <>
              <TextField
                label="Audio input device (optional)"
                value={audioInputDevice}
                onChange={(e) => setAudioInputDevice(e.target.value)}
                placeholder="System default"
                helperText="Leave blank to use your system's default microphone/input. Otherwise enter the exact device name Direwolf expects for your OS."
              />
              <TextField
                label="Audio output device (optional)"
                value={audioOutputDevice}
                onChange={(e) => setAudioOutputDevice(e.target.value)}
                placeholder="System default"
                helperText="Leave blank to use your system's default speaker/output."
              />
              <TextField select label="PTT method" value={pttMethod} onChange={(e) => setPttMethod(e.target.value)}>
                {Object.entries(PTT_METHOD_LABELS).map(([v, label]) => (
                  <MenuItem key={v} value={v}>{label}</MenuItem>
                ))}
              </TextField>
              {(pttMethod === 'rts' || pttMethod === 'dtr') && (
                <TextField select label="PTT serial port" value={pttDevice} onChange={(e) => setPttDevice(e.target.value)}>
                  {serialPorts.length === 0 && <MenuItem value="" disabled>No serial ports detected</MenuItem>}
                  {serialPorts.map((p) => (
                    <MenuItem key={p.path} value={p.path}>{p.path}{p.manufacturer ? ` (${p.manufacturer})` : ''}</MenuItem>
                  ))}
                </TextField>
              )}
              {pttMethod === 'cm108' && (
                <TextField
                  label="CM108 HID device (optional)"
                  value={pttDevice}
                  onChange={(e) => setPttDevice(e.target.value)}
                  helperText="Leave blank to let Direwolf auto-detect the first CM108-family USB sound fob."
                />
              )}
              <Alert severity="info">
                This uses Direwolf (github.com/wb2osz/direwolf) as the modem — a build of it ships
                with NexPack, so nothing extra to install on macOS/Linux/Windows. If it's ever missing
                for your platform, install it yourself and make sure it's on your PATH (macOS:{' '}
                <code>brew install direwolf</code>, Debian/Ubuntu: <code>sudo apt install direwolf</code>).
                Add a radio below with the callsign-SSID to transmit as.
              </Alert>
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
