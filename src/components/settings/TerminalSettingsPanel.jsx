import React, { useEffect, useMemo, useState } from 'react';
import { Box, Stack, TextField, MenuItem, Button, Typography, Alert, Divider, Switch, FormControlLabel } from '@mui/material';

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

export default function TerminalSettingsPanel({ tncs }) {
  const [radioKey, setRadioKey] = useState('');
  const [digiPath, setDigiPath] = useState('');
  const [saved, setSaved] = useState(false);

  const [nodeEnabled, setNodeEnabled] = useState(false);
  const [preamble, setPreamble] = useState('');
  const [nodeSaved, setNodeSaved] = useState(false);

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
    window.nexdigi.inboundServerGetSettings().then((s) => {
      setNodeEnabled(!!s.node.enabled);
      setPreamble(s.node.preamble || '');
    });
  }, []);

  const save = async () => {
    const r = radios.find((x) => x.key === radioKey);
    await window.nexdigi.terminalSaveSettings({ defaultTncId: r ? r.tncId : null, defaultRadioId: r ? r.radioId : null, defaultDigiPath: digiPath.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveNode = async () => {
    await window.nexdigi.inboundServerSaveSettings({ node: { enabled: nodeEnabled, preamble } });
    setNodeSaved(true);
    setTimeout(() => setNodeSaved(false), 2000);
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <Typography variant="body2" color="text.secondary">
        Sets the radio Terminal starts with when you open it, instead of picking one fresh every time.
        Give Terminal its own callsign/SSID here (a separate radio entry, not necessarily a separate physical
        radio) if you also use BBS-over-RF or APRS beaconing at the same time — a remote station seeing one
        callsign behave inconsistently across independent connections is a real source of confusion and
        connection loops. This same radio is also the identity remote stations connect to below.
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

      <Divider />
      <Typography variant="subtitle1">Accept incoming connections</Typography>
      <Typography variant="body2" color="text.secondary">
        When enabled, a remote station connecting to Terminal's radio (above) gets a welcome message and a
        menu — replying CHAT or BBS takes them straight into that part of NexPack; BYE disconnects. Connecting
        directly to the BBS or Chat radio (set in their own tabs) skips this menu entirely.
      </Typography>
      <FormControlLabel control={<Switch checked={nodeEnabled} onChange={(e) => setNodeEnabled(e.target.checked)} />} label="Serve a node menu to incoming connections" />
      <TextField
        label="Preamble"
        value={preamble}
        onChange={(e) => setPreamble(e.target.value)}
        multiline
        minRows={2}
        disabled={!nodeEnabled}
        helperText="Use {callsign} to insert the connecting station's callsign"
      />
      <Box>
        <Button variant="contained" onClick={saveNode}>Save</Button>
        {nodeSaved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>
    </Stack>
  );
}
