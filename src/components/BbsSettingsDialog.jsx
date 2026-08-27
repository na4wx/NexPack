import React, { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack,
  Tabs, Tab, ToggleButtonGroup, ToggleButton, Typography, MenuItem
} from '@mui/material';

const MAX_PATH_HOPS = 8;

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

function parsePathInput(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_PATH_HOPS);
}

// Replaces the plain NexDigiServerSettingsDialog for BBS specifically (that
// dialog stays untouched for Chat, which is HTTP-only) — this one lets the
// user configure BOTH an HTTP (NexDigi server) connection and an RF
// (AX.25 connected-mode, over a configured TNC/radio) connection, and pick
// which is currently active. Switching the toggle takes effect immediately
// on the next refresh; no separate "apply" step.
export default function BbsSettingsDialog({ open, onClose, onSaved, tncs }) {
  const [tab, setTab] = useState('http');
  const [transport, setTransport] = useState('http');

  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [callsign, setCallsign] = useState('');

  const [radioKey, setRadioKey] = useState('');
  const [bbsCallsign, setBbsCallsign] = useState('');
  const [pathStr, setPathStr] = useState('');

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs || []) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  useEffect(() => {
    if (!open) return;
    Promise.all([window.nexdigi.bbsGetSettings(), window.nexdigi.rfBbsGetSettings(), window.nexdigi.bbsGetTransport()]).then(([http, rf, t]) => {
      if (http) { setHost(http.host || ''); setPassword(http.password || ''); setCallsign(http.callsign || ''); }
      if (rf) {
        setRadioKey(rf.tncId && rf.radioId ? `${rf.tncId}:${rf.radioId}` : '');
        setBbsCallsign(rf.bbsCallsign || '');
        setPathStr((rf.digiPath || []).join(','));
      }
      setTransport(t || 'http');
      setTab(t || 'http');
    });
  }, [open]);

  const submit = async () => {
    const r = radios.find((x) => x.key === radioKey);
    await window.nexdigi.bbsSaveSettings({ host: host.trim(), password, callsign: callsign.trim() });
    await window.nexdigi.rfBbsSaveSettings({ tncId: r ? r.tncId : null, radioId: r ? r.radioId : null, bbsCallsign: bbsCallsign.trim().toUpperCase(), digiPath: parsePathInput(pathStr) });
    await window.nexdigi.bbsSetTransport(transport);
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>BBS connection</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <ToggleButtonGroup exclusive size="small" value={transport} onChange={(_e, v) => v && setTransport(v)}>
            <ToggleButton value="http">Internet</ToggleButton>
            <ToggleButton value="rf">Radio (RF)</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary">
            {transport === 'http' ? 'Talks to a running NexDigi server over HTTP.' : 'Connects directly to the BBS callsign over AX.25, using a configured TNC/radio — no internet required.'}
          </Typography>

          <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="fullWidth" sx={{ minHeight: 36 }}>
            <Tab value="http" label="Server" sx={{ minHeight: 36, py: 0.5 }} />
            <Tab value="rf" label="Radio" sx={{ minHeight: 36, py: 0.5 }} />
          </Tabs>

          {tab === 'http' && (
            <Stack spacing={2}>
              <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost:3010" />
              <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <TextField label="Your callsign" value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="N0CALL" helperText="Used for BBS messages you post" />
            </Stack>
          )}

          {tab === 'rf' && (
            <Stack spacing={2}>
              <TextField select label="Radio" value={radioKey} onChange={(e) => setRadioKey(e.target.value)}>
                {radios.length === 0 && <MenuItem value="" disabled>No radios configured</MenuItem>}
                {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
              </TextField>
              <TextField label="BBS callsign" value={bbsCallsign} onChange={(e) => setBbsCallsign(e.target.value)} placeholder="NA4WX-7" />
              <TextField label="Path (optional)" value={pathStr} onChange={(e) => setPathStr(e.target.value)} placeholder="WIDE1-1,WIDE2-1" />
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
