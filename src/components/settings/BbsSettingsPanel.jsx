import React, { useEffect, useMemo, useState } from 'react';
import { Box, Stack, TextField, Button, Typography, ToggleButtonGroup, ToggleButton, Divider, MenuItem, Alert } from '@mui/material';

const MAX_PATH_HOPS = 8;

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

function parsePathInput(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_PATH_HOPS);
}

export default function BbsSettingsPanel({ tncs }) {
  const [transport, setTransport] = useState('http');

  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [callsign, setCallsign] = useState('');

  const [radioKey, setRadioKey] = useState('');
  const [bbsCallsign, setBbsCallsign] = useState('');
  const [pathStr, setPathStr] = useState('');
  const [saved, setSaved] = useState(false);

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs || []) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  useEffect(() => {
    Promise.all([window.nexdigi.bbsGetSettings(), window.nexdigi.rfBbsGetSettings(), window.nexdigi.bbsGetTransport()]).then(([http, rf, t]) => {
      if (http) { setHost(http.host || ''); setPassword(http.password || ''); setCallsign(http.callsign || ''); }
      if (rf) {
        setRadioKey(rf.tncId && rf.radioId ? `${rf.tncId}:${rf.radioId}` : '');
        setBbsCallsign(rf.bbsCallsign || '');
        setPathStr((rf.digiPath || []).join(','));
      }
      setTransport(t || 'http');
    });
  }, []);

  const save = async () => {
    const r = radios.find((x) => x.key === radioKey);
    await window.nexdigi.bbsSaveSettings({ host: host.trim(), password, callsign: callsign.trim() });
    await window.nexdigi.rfBbsSaveSettings({ tncId: r ? r.tncId : null, radioId: r ? r.radioId : null, bbsCallsign: bbsCallsign.trim().toUpperCase(), digiPath: parsePathInput(pathStr) });
    await window.nexdigi.bbsSetTransport(transport);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <ToggleButtonGroup exclusive size="small" value={transport} onChange={(_e, v) => v && setTransport(v)}>
        <ToggleButton value="http">Internet</ToggleButton>
        <ToggleButton value="rf">Radio (RF)</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="body2" color="text.secondary">
        {transport === 'http' ? 'Talks to a running NexDigi server over HTTP.' : 'Connects directly to the BBS callsign over AX.25, using a configured TNC/radio — no internet required.'}
      </Typography>

      <Divider />
      <Typography variant="subtitle2">NexDigi server (Internet)</Typography>
      <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost:3010" />
      <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <TextField label="Your callsign" value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="N0CALL" helperText="Used for BBS messages you post over the internet" />

      <Divider />
      <Typography variant="subtitle2">Radio (RF)</Typography>
      <TextField select label="Radio" value={radioKey} onChange={(e) => setRadioKey(e.target.value)}>
        <MenuItem value="">None</MenuItem>
        {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
      </TextField>
      <Typography variant="caption" color="text.secondary">
        This radio's own callsign/SSID is what identifies you to the BBS over RF — give it its own SSID
        (e.g. N0CALL-2) if Terminal or APRS beaconing might be active on the same radio at the same time.
      </Typography>
      <TextField label="BBS callsign" value={bbsCallsign} onChange={(e) => setBbsCallsign(e.target.value)} placeholder="NA4WX-7" helperText="The remote BBS station's callsign, not yours" />
      <TextField label="Digipeater path (optional)" value={pathStr} onChange={(e) => setPathStr(e.target.value)} placeholder="WIDE1-1,WIDE2-1" />
      {radios.length === 0 && (
        <Alert severity="info">No radios configured yet — add one under TNCs &amp; Radios in the nav.</Alert>
      )}

      <Box>
        <Button variant="contained" onClick={save}>Save</Button>
        {saved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>
    </Stack>
  );
}
