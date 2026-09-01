import React, { useEffect, useState } from 'react';
import { Box, Stack, TextField, Button, Typography, Alert } from '@mui/material';

// Fixed alias key so re-saving overwrites the same RF gateway entry instead
// of accumulating a new "RF: <whatever was typed>" entry every time.
const RF_ALIAS_KEY = 'RF: RMS Gateway';
const CALLSIGN_RE = /^[A-Z0-9]{3,7}(-\d{1,2})?$/;

export default function WinlinkSettingsPanel() {
  const [callsign, setCallsign] = useState('');
  const [password, setPassword] = useState('');
  const [rmsGatewayCall, setRmsGatewayCall] = useState('');
  const [agwpeHost, setAgwpeHost] = useState('127.0.0.1');
  const [agwpePort, setAgwpePort] = useState(8000);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.nexdigi.winlinkGetSettings().then((s) => {
      if (!s) return;
      setCallsign(s.mycall || '');
      setPassword(s.secure_login_password || '');
      setAgwpeHost((s.agwpe && s.agwpe.addr && s.agwpe.addr.split(':')[0]) || '127.0.0.1');
      setAgwpePort((s.agwpe && s.agwpe.addr && Number(s.agwpe.addr.split(':')[1])) || 8000);
      const existingRfUrl = s.connect_aliases && s.connect_aliases[RF_ALIAS_KEY];
      const match = existingRfUrl && existingRfUrl.match(/^ax25:\/\/\/(.+)$/);
      setRmsGatewayCall(match ? match[1] : '');
    });
  }, []);

  const trimmedGateway = rmsGatewayCall.trim().toUpperCase();
  const gatewayValid = !trimmedGateway || CALLSIGN_RE.test(trimmedGateway);

  const save = async () => {
    setSaving(true);
    try {
      await window.nexdigi.winlinkSaveSettings({
        callsign: callsign.trim(),
        winlinkPassword: password,
        connectAliases: { telnet: 'telnet://{mycall}:CMSTelnet@cms.winlink.org:8772/wl2k' },
        ax25: { engine: 'agwpe', rig: '', beacon: { every: 0, message: '', destination: 'IDENT' } },
        agwpe: { addr: `${agwpeHost}:${agwpePort}`, radio_port: 0 }
      });
      if (trimmedGateway) {
        await window.nexdigi.winlinkSetConnectAlias(RF_ALIAS_KEY, `ax25:///${trimmedGateway}`);
      } else {
        await window.nexdigi.winlinkRemoveConnectAlias(RF_ALIAS_KEY).catch(() => {}); // fine if it never existed
      }
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
      <TextField
        label="RMS Gateway callsign"
        value={rmsGatewayCall}
        onChange={(e) => setRmsGatewayCall(e.target.value)}
        placeholder="e.g. K1ABC-10"
        error={!gatewayValid}
        helperText={gatewayValid ? "The gateway station's own amateur radio callsign (not a hostname) — leave blank if you don't have one yet" : 'Must be a callsign like K1ABC or K1ABC-10, not a hostname'}
      />
      <TextField label="AGWPE host" value={agwpeHost} onChange={(e) => setAgwpeHost(e.target.value)} helperText="Where your KISS-TCP/AGWPE TNC (e.g. Direwolf) is listening" />
      <TextField label="AGWPE port" type="number" value={agwpePort} onChange={(e) => setAgwpePort(e.target.value)} />
      <Box>
        <Button variant="contained" disabled={!callsign.trim() || !gatewayValid || saving} onClick={save}>Save</Button>
        {saved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>
    </Stack>
  );
}
