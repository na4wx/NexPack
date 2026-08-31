import React, { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack, Typography } from '@mui/material';

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export default function MapCacheSettingsDialog({ open, onClose }) {
  const [info, setInfo] = useState(null);
  const [budgetMb, setBudgetMb] = useState('');
  const [clearing, setClearing] = useState(false);

  const refresh = () => window.nexdigi.getMapCacheInfo().then((i) => {
    setInfo(i);
    setBudgetMb(String(Math.round(i.budgetBytes / (1024 * 1024))));
  });

  useEffect(() => { if (open) refresh(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveBudget = async () => {
    const mb = Math.max(0, Number(budgetMb) || 0);
    await window.nexdigi.setMapCacheBudget(mb * 1024 * 1024);
    refresh();
  };

  const clear = async () => {
    setClearing(true);
    try { await window.nexdigi.clearMapCache(); await refresh(); } finally { setClearing(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Map Cache</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Map tiles are cached on disk as you view them, so the map keeps working
            offline. A tile stays cached indefinitely unless OpenStreetMap has
            actually updated it, or the budget below needs the space for newer tiles.
          </Typography>
          {info && (
            <Typography variant="body2">
              {info.tileCount.toLocaleString()} tiles cached — {formatBytes(info.totalBytes)} of {formatBytes(info.budgetBytes)} used
            </Typography>
          )}
          <TextField
            label="Cache budget (MB)"
            type="number"
            size="small"
            value={budgetMb}
            onChange={(e) => setBudgetMb(e.target.value)}
            onBlur={saveBudget}
            inputProps={{ min: 0 }}
            helperText="Default is 1024 MB (1 GB)"
          />
          <Button color="error" variant="outlined" onClick={clear} disabled={clearing}>
            {clearing ? 'Clearing…' : 'Clear cached tiles'}
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
