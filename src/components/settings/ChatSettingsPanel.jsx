import React, { useEffect, useMemo, useState } from 'react';
import { Box, Stack, TextField, Button, Typography, Divider, Switch, FormControlLabel, MenuItem, ToggleButtonGroup, ToggleButton } from '@mui/material';

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

// Chat shares its NexDigi server connection (host/password) with BBS —
// they're the same running server — but has its own callsign, kept
// separate deliberately: there's no real reason a user's Chat identity
// needs to match their BBS posting identity.
export default function ChatSettingsPanel({ tncs }) {
  const [transport, setTransport] = useState('http');
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [chatCallsign, setChatCallsign] = useState('');
  const [saved, setSaved] = useState(false);

  const [inboundEnabled, setInboundEnabled] = useState(false);
  const [inboundRadioKey, setInboundRadioKey] = useState('');
  const [defaultRoom, setDefaultRoom] = useState('LOBBY');
  const [inboundSaved, setInboundSaved] = useState(false);

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs || []) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  useEffect(() => {
    window.nexdigi.bbsGetSettings().then((s) => {
      if (!s) return;
      setHost(s.host || '');
      setPassword(s.password || '');
      setChatCallsign(s.chatCallsign || s.callsign || '');
    });
    window.nexdigi.chatGetTransport().then((t) => setTransport(t || 'http'));
    window.nexdigi.inboundServerGetSettings().then((s) => {
      setInboundEnabled(!!s.chat.enabled);
      setInboundRadioKey(s.chat.tncId && s.chat.radioId ? `${s.chat.tncId}:${s.chat.radioId}` : '');
      setDefaultRoom(s.chat.defaultRoom || 'LOBBY');
    });
  }, []);

  const save = async () => {
    await window.nexdigi.bbsSaveSettings({ host: host.trim(), password, chatCallsign: chatCallsign.trim() });
    await window.nexdigi.chatSetTransport(transport);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveInbound = async () => {
    const r = radios.find((x) => x.key === inboundRadioKey);
    await window.nexdigi.inboundServerSaveSettings({ chat: { enabled: inboundEnabled, tncId: r ? r.tncId : null, radioId: r ? r.radioId : null, defaultRoom: defaultRoom.trim() || 'LOBBY' } });
    setInboundSaved(true);
    setTimeout(() => setInboundSaved(false), 2000);
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <ToggleButtonGroup exclusive size="small" value={transport} onChange={(_e, v) => v && setTransport(v)}>
        <ToggleButton value="http">Internet</ToggleButton>
        <ToggleButton value="rf">Radio (RF)</ToggleButton>
      </ToggleButtonGroup>
      {transport === 'http' ? (
        <Typography variant="body2" color="text.secondary">
          Chat runs on the same NexDigi server as BBS, so the connection below is shared with the BBS tab —
          saving here updates it for both. Your Chat callsign is its own separate identity.
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Connects to the same BBS callsign configured on the BBS tab's Radio (RF) section, over AX.25 — no
          internet required. Chat rides that same BBS session (typing CHAT once connected), so there's no
          separate TNC/radio/callsign to set here; configure those under BBS &rarr; Radio (RF).
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
    </Stack>
  );
}
