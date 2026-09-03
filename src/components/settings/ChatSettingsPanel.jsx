import React, { useEffect, useMemo, useState } from 'react';
import { Box, Stack, TextField, Button, Typography, Divider, Switch, FormControlLabel, MenuItem, ToggleButtonGroup, ToggleButton, Alert } from '@mui/material';

const MAX_PATH_HOPS = 8;

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

function parsePathInput(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_PATH_HOPS);
}

// Chat shares its NexDigi server connection (host/password) with BBS —
// they're the same running server — but has its own callsign, kept
// separate deliberately: there's no real reason a user's Chat identity
// needs to match their BBS posting identity.
//
// Over RF, Chat rides a real BBS session (connect to the BBS callsign,
// type CHAT) — there is no separate wire protocol, so the BBS radio/
// callsign/digipeater-path fields live here now that BBS no longer has
// its own settings tab (its mail UI was removed; this is the only
// remaining consumer of that RF connection).
export default function ChatSettingsPanel({ tncs }) {
  const [transport, setTransport] = useState('http');
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [chatCallsign, setChatCallsign] = useState('');
  const [saved, setSaved] = useState(false);

  const [rfRadioKey, setRfRadioKey] = useState('');
  const [bbsCallsign, setBbsCallsign] = useState('');
  const [pathStr, setPathStr] = useState('');
  const [rfSaved, setRfSaved] = useState(false);

  const [inboundEnabled, setInboundEnabled] = useState(false);
  const [inboundRadioKey, setInboundRadioKey] = useState('');
  const [defaultRoom, setDefaultRoom] = useState('LOBBY');
  const [inboundSaved, setInboundSaved] = useState(false);

  const [inboundBbsEnabled, setInboundBbsEnabled] = useState(false);
  const [inboundBbsRadioKey, setInboundBbsRadioKey] = useState('');
  const [inboundBbsSaved, setInboundBbsSaved] = useState(false);

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs || []) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  useEffect(() => {
    Promise.all([window.nexdigi.bbsGetSettings(), window.nexdigi.rfBbsGetSettings()]).then(([http, rf]) => {
      if (http) {
        setHost(http.host || '');
        setPassword(http.password || '');
        setChatCallsign(http.chatCallsign || http.callsign || '');
      }
      if (rf) {
        setRfRadioKey(rf.tncId && rf.radioId ? `${rf.tncId}:${rf.radioId}` : '');
        setBbsCallsign(rf.bbsCallsign || '');
        setPathStr((rf.digiPath || []).join(','));
      }
    });
    window.nexdigi.chatGetTransport().then((t) => setTransport(t || 'http'));
    window.nexdigi.inboundServerGetSettings().then((s) => {
      setInboundEnabled(!!s.chat.enabled);
      setInboundRadioKey(s.chat.tncId && s.chat.radioId ? `${s.chat.tncId}:${s.chat.radioId}` : '');
      setDefaultRoom(s.chat.defaultRoom || 'LOBBY');
      setInboundBbsEnabled(!!s.bbs.enabled);
      setInboundBbsRadioKey(s.bbs.tncId && s.bbs.radioId ? `${s.bbs.tncId}:${s.bbs.radioId}` : '');
    });
  }, []);

  const save = async () => {
    await window.nexdigi.bbsSaveSettings({ host: host.trim(), password, chatCallsign: chatCallsign.trim() });
    await window.nexdigi.chatSetTransport(transport);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveRf = async () => {
    const r = radios.find((x) => x.key === rfRadioKey);
    await window.nexdigi.rfBbsSaveSettings({ tncId: r ? r.tncId : null, radioId: r ? r.radioId : null, bbsCallsign: bbsCallsign.trim().toUpperCase(), digiPath: parsePathInput(pathStr) });
    setRfSaved(true);
    setTimeout(() => setRfSaved(false), 2000);
  };

  const saveInbound = async () => {
    const r = radios.find((x) => x.key === inboundRadioKey);
    await window.nexdigi.inboundServerSaveSettings({ chat: { enabled: inboundEnabled, tncId: r ? r.tncId : null, radioId: r ? r.radioId : null, defaultRoom: defaultRoom.trim() || 'LOBBY' } });
    setInboundSaved(true);
    setTimeout(() => setInboundSaved(false), 2000);
  };

  const saveInboundBbs = async () => {
    const r = radios.find((x) => x.key === inboundBbsRadioKey);
    await window.nexdigi.inboundServerSaveSettings({ bbs: { enabled: inboundBbsEnabled, tncId: r ? r.tncId : null, radioId: r ? r.radioId : null } });
    setInboundBbsSaved(true);
    setTimeout(() => setInboundBbsSaved(false), 2000);
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <ToggleButtonGroup exclusive size="small" value={transport} onChange={(_e, v) => v && setTransport(v)}>
        <ToggleButton value="http">Internet</ToggleButton>
        <ToggleButton value="rf">Radio (RF)</ToggleButton>
      </ToggleButtonGroup>
      {transport === 'http' ? (
        <Typography variant="body2" color="text.secondary">
          Chat runs on the same NexDigi server as BBS mail, so the connection below is shared — saving here
          updates it for both. Your Chat callsign is its own separate identity.
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Connects directly to the BBS callsign over AX.25 (typing CHAT once connected) — no internet required.
        </Typography>
      )}
      {transport === 'http' && (
        <>
          <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost:3010" />
          <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <TextField label="Your Chat callsign" value={chatCallsign} onChange={(e) => setChatCallsign(e.target.value)} placeholder="N0CALL" />
        </>
      )}
      <Box>
        <Button variant="contained" onClick={save}>Save</Button>
        {saved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>

      {transport === 'rf' && (
        <>
          <Divider />
          <Typography variant="subtitle2">Radio (RF)</Typography>
          <TextField select label="Radio" value={rfRadioKey} onChange={(e) => setRfRadioKey(e.target.value)}>
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
            <Button variant="contained" onClick={saveRf}>Save</Button>
            {rfSaved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
          </Box>
        </>
      )}

      <Divider />
      <Typography variant="subtitle1">Accept incoming Chat connections</Typography>
      <Typography variant="body2" color="text.secondary">
        A remote station connecting directly to the radio below lands straight in a live chat relay — no menu.
        Each visitor appears in the room under their own callsign. Give this its own SSID, separate from
        Terminal and BBS's radios, if more than one might be live at once.
      </Typography>
      <FormControlLabel control={<Switch checked={inboundEnabled} onChange={(e) => setInboundEnabled(e.target.checked)} />} label="Serve Chat to incoming connections" />
      <TextField select label="Radio" value={inboundRadioKey} onChange={(e) => setInboundRadioKey(e.target.value)} disabled={!inboundEnabled}>
        <MenuItem value="">None</MenuItem>
        {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
      </TextField>
      <TextField label="Default room" value={defaultRoom} onChange={(e) => setDefaultRoom(e.target.value)} disabled={!inboundEnabled} />
      <Box>
        <Button variant="contained" onClick={saveInbound}>Save</Button>
        {inboundSaved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>

      <Divider />
      <Typography variant="subtitle1">Accept incoming BBS connections</Typography>
      <Typography variant="body2" color="text.secondary">
        A remote station connecting directly to the radio below lands straight in BBS mode — no menu. Give it
        its own callsign/SSID, separate from Terminal and Chat's radios, if more than one might be live at once.
      </Typography>
      <FormControlLabel control={<Switch checked={inboundBbsEnabled} onChange={(e) => setInboundBbsEnabled(e.target.checked)} />} label="Serve BBS to incoming connections" />
      <TextField select label="Radio" value={inboundBbsRadioKey} onChange={(e) => setInboundBbsRadioKey(e.target.value)} disabled={!inboundBbsEnabled}>
        <MenuItem value="">None</MenuItem>
        {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
      </TextField>
      <Box>
        <Button variant="contained" onClick={saveInboundBbs}>Save</Button>
        {inboundBbsSaved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>
    </Stack>
  );
}
