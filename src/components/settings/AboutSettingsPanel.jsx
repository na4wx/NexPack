import React, { useEffect, useState } from 'react';
import { Box, Stack, Typography, Button, Alert, CircularProgress } from '@mui/material';

export default function AboutSettingsPanel() {
  const [version, setVersion] = useState(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

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

  // Show the current version right away without waiting on a network
  // round-trip — the check itself still runs manually via the button.
  useEffect(() => {
    window.nexdigi.checkForUpdate().then((r) => setVersion(r.currentVersion)).catch(() => {});
  }, []);

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
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
