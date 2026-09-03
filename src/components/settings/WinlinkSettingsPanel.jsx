import React, { useEffect, useState } from 'react';
import { Box, Stack, TextField, Button, Typography, Alert } from '@mui/material';

export default function WinlinkSettingsPanel() {
  const [callsign, setCallsign] = useState('');
  const [password, setPassword] = useState('');
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
    });
  }, []);

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
      <TextField label="AGWPE host" value={agwpeHost} onChange={(e) => setAgwpeHost(e.target.value)} helperText="Where your KISS-TCP/AGWPE TNC (e.g. Direwolf) is listening" />
      <TextField label="AGWPE port" type="number" value={agwpePort} onChange={(e) => setAgwpePort(e.target.value)} />
      <Typography variant="caption" color="text.secondary">
        This just points Winlink at the TNC — the actual RMS Gateway callsign to connect to (e.g. NA4WX-10) is
        entered on the Winlink page itself when you connect, since it's the kind of thing that changes trip to
        trip rather than staying fixed.
      </Typography>
      <Box>
        <Button variant="contained" disabled={!callsign.trim() || saving} onClick={save}>Save</Button>
        {saved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
      </Box>
    </Stack>
  );
}
