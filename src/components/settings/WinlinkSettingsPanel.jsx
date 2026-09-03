import React, { useEffect, useMemo, useState } from 'react';
import { Box, Stack, TextField, Button, Typography, Alert, MenuItem } from '@mui/material';

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

export default function WinlinkSettingsPanel({ tncs }) {
  const [callsign, setCallsign] = useState('');
  const [password, setPassword] = useState('');
  const [radioKey, setRadioKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // pat (the Winlink client) can only ever speak AGWPE for AX.25 — never
  // raw KISS — so only 'agwpe' TNCs (already an AGWPE endpoint) and
  // NexPack's own 'soundmodem' (built-in Direwolf, which opens a real AGWPE
  // port alongside its KISS one specifically so this works) are usable
  // here. A 'serial'/'kiss-tcp' TNC has no AGWPE endpoint pat could reach.
  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs || []) {
      if (tnc.type !== 'agwpe' && tnc.type !== 'soundmodem') continue;
      for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    }
    return list;
  }, [tncs]);

  useEffect(() => {
    Promise.all([window.nexdigi.winlinkGetSettings(), window.nexdigi.winlinkGetRfRadio()]).then(([s, rf]) => {
      if (s) {
        setCallsign(s.mycall || '');
        setPassword(s.secure_login_password || '');
      }
      if (rf && rf.tncId && rf.radioId) setRadioKey(`${rf.tncId}:${rf.radioId}`);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = radios.find((x) => x.key === radioKey);
      await window.nexdigi.winlinkSaveSettings({
        callsign: callsign.trim(),
        winlinkPassword: password,
        connectAliases: { telnet: 'telnet://{mycall}:CMSTelnet@cms.winlink.org:8772/wl2k' },
        rfRadio: r ? { tncId: r.tncId, radioId: r.radioId } : null
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <Alert severity="info" sx={{ fontSize: 13 }}>
        Serial TNCs can't be shared between Terminal and Winlink at the same time — use a KISS-TCP/AGWPE TNC (e.g. Direwolf) to run both together.
      </Alert>
      <TextField label="Your callsign" value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="N0CALL" />
      <Typography variant="caption" color="text.secondary">
        Give Winlink its own SSID (e.g. N0CALL-10) distinct from Terminal/BBS/APRS if they might all be
        active on the same AGWPE TNC at the same time.
      </Typography>
      <TextField label="Winlink account password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} helperText="Used for Telnet CMS access" />
      <Typography variant="subtitle2">RF (RMS Gateway)</Typography>
      <TextField select label="Radio" value={radioKey} onChange={(e) => setRadioKey(e.target.value)}>
        <MenuItem value="">None</MenuItem>
        {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
      </TextField>
      {radios.length === 0 && (
        <Alert severity="info">
          No AGWPE-capable radios configured yet — add an AGWPE TNC, or use the built-in Sound Modem, under
          TNCs &amp; Radios in the nav. (A serial/KISS-TCP TNC can't be used here — Winlink's client only speaks AGWPE.)
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary">
        This is which radio Winlink reaches an RMS Gateway through — the actual gateway callsign to connect to
        (e.g. NA4WX-10) is entered on the Winlink page itself when you connect, since it's the kind of thing
        that changes trip to trip rather than staying fixed.
      </Typography>
      <Box>
        <Button variant="contained" disabled={!callsign.trim() || saving} onClick={save}>Save</Button>
        {saved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>
    </Stack>
  );
}
