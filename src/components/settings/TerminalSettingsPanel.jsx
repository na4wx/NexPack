import React, { useEffect, useMemo, useState } from 'react';
import { Box, Stack, TextField, MenuItem, Button, Typography, Alert } from '@mui/material';

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

export default function TerminalSettingsPanel({ tncs }) {
  const [radioKey, setRadioKey] = useState('');
  const [digiPath, setDigiPath] = useState('');
  const [saved, setSaved] = useState(false);

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs || []) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  useEffect(() => {
    window.nexdigi.terminalGetSettings().then((s) => {
      setRadioKey(s.defaultTncId && s.defaultRadioId ? `${s.defaultTncId}:${s.defaultRadioId}` : '');
      setDigiPath(s.defaultDigiPath || '');
    });
  }, []);

  const save = async () => {
    const r = radios.find((x) => x.key === radioKey);
    await window.nexdigi.terminalSaveSettings({ defaultTncId: r ? r.tncId : null, defaultRadioId: r ? r.radioId : null, defaultDigiPath: digiPath.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <Typography variant="body2" color="text.secondary">
        Sets the radio Terminal starts with when you open it, instead of picking one fresh every time.
        Give Terminal its own callsign/SSID here (a separate radio entry, not necessarily a separate physical
        radio) if you also use BBS-over-RF or APRS beaconing at the same time — a remote station seeing one
        callsign behave inconsistently across independent connections is a real source of confusion and
        connection loops.
      </Typography>
      <TextField select label="Default radio" value={radioKey} onChange={(e) => setRadioKey(e.target.value)}>
        <MenuItem value="">None (choose each time)</MenuItem>
        {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
      </TextField>
      <TextField label="Default digipeater path" value={digiPath} onChange={(e) => setDigiPath(e.target.value)} placeholder="WIDE1-1,WIDE2-1" />
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
