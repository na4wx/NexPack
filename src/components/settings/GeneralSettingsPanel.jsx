import React, { useEffect, useState } from 'react';
import { Box, Stack, Typography, Button, Alert, CircularProgress, TextField, MenuItem, Divider } from '@mui/material';

const DEFAULT_PAGE_OPTIONS = [
  { value: 'terminal', label: 'Terminal' },
  { value: 'winlink', label: 'Winlink' },
  { value: 'chat', label: 'NexChat' },
  { value: 'aprs', label: 'APRS' },
  { value: 'tncs', label: 'TNCs & Radios' }
];

// App-wide settings — things that apply to NexPack as a whole rather than
// to any one workspace. Currently just where to land at launch; app
// version/update info (previously its own "About" tab) lives here too,
// since that's app-wide as well.
export default function GeneralSettingsPanel() {
  const [defaultPage, setDefaultPage] = useState('terminal');
  const [saved, setSaved] = useState(false);

  const [version, setVersion] = useState(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    window.nexdigi.appGetSettings().then((s) => setDefaultPage(s.defaultPage || 'terminal'));
    window.nexdigi.checkForUpdate().then((r) => setVersion(r.currentVersion)).catch(() => {});
  }, []);

  const saveDefaultPage = async (value) => {
    setDefaultPage(value);
    await window.nexdigi.appSaveSettings({ defaultPage: value });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const check = async () => {
    setChecking(true);
    setError('');
    try {
      const r = await window.nexdigi.checkForUpdate();
      setResult(r);
      setVersion(r.currentVersion);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <Typography variant="subtitle1">Startup</Typography>
      <TextField select label="Open on launch" value={defaultPage} onChange={(e) => saveDefaultPage(e.target.value)}>
        {DEFAULT_PAGE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
      </TextField>
      {saved && <Typography variant="body2" color="success.main">Saved</Typography>}

      <Divider />
      <Typography variant="subtitle1">About NexPack</Typography>
      <Typography variant="body2" color="text.secondary">
        {version ? `Version ${version}` : 'NexPack'}
      </Typography>

      <Box>
        <Button variant="contained" onClick={check} disabled={checking} startIcon={checking ? <CircularProgress size={16} /> : null}>
          Check for updates
        </Button>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {result && !error && (
        result.updateAvailable ? (
          <Alert
            severity="info"
            action={
              <Button color="inherit" size="small" onClick={() => window.nexdigi.openExternal(result.releaseUrl)}>
                Open release page
              </Button>
            }
          >
            NexPack {result.latestVersion} is available — you have {result.currentVersion}.
          </Alert>
        ) : (
          <Alert severity="success">You're up to date (v{result.currentVersion}).</Alert>
        )
      )}
    </Stack>
  );
}
