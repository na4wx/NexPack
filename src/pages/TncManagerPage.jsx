import React, { useState } from 'react';
import {
  Box, Typography, Button, Card, CardContent, CardActions, Chip, IconButton,
  Stack, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  List, ListItem, ListItemText, Divider
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import SettingsInputAntennaIcon from '@mui/icons-material/SettingsInputAntenna';
import AddTncDialog from '../components/AddTncDialog';
import AddRadioDialog from '../components/AddRadioDialog';

const STATUS_COLOR = { connected: 'success', connecting: 'warning', error: 'error', disconnected: 'default' };

export default function TncManagerPage({ tncs, onChange }) {
  const [addOpen, setAddOpen] = useState(false);
  const [radioTargetTnc, setRadioTargetTnc] = useState(null);

  const handleConnect = async (tnc) => {
    if (tnc.status === 'connected' || tnc.status === 'connecting') await window.nexdigi.disconnectTnc(tnc.id);
    else await window.nexdigi.connectTnc(tnc.id);
    onChange();
  };

  return (
    <Box sx={{ p: 3, overflowY: 'auto', height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5">TNCs &amp; Radios</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
          Add TNC
        </Button>
      </Stack>

      {tncs.length === 0 && (
        <Card sx={{ p: 4, textAlign: 'center' }}>
          <SettingsInputAntennaIcon sx={{ fontSize: 40, color: 'text.secondary', mb: 1 }} />
          <Typography color="text.secondary">
            No TNCs configured yet. Add a serial, KISS-TCP, or AGWPE TNC to get started.
          </Typography>
        </Card>
      )}

      <Stack spacing={2}>
        {tncs.map((tnc) => (
          <Card key={tnc.id}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">{tnc.name}</Typography>
                    <Chip size="small" label={tnc.type} variant="outlined" />
                    <Chip size="small" label={tnc.status || 'disconnected'} color={STATUS_COLOR[tnc.status] || 'default'} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {tnc.type === 'serial' ? `${tnc.connection.path} @ ${tnc.connection.baud || 9600} baud` : `${tnc.connection.host}:${tnc.connection.port}`}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    variant="outlined"
                    color={tnc.status === 'connected' || tnc.status === 'connecting' ? 'error' : 'primary'}
                    startIcon={tnc.status === 'connected' || tnc.status === 'connecting' ? <StopIcon /> : <PlayArrowIcon />}
                    onClick={() => handleConnect(tnc)}
                  >
                    {tnc.status === 'connected' || tnc.status === 'connecting' ? 'Disconnect' : 'Connect'}
                  </Button>
                  <IconButton
                    size="small"
                    onClick={async () => { await window.nexdigi.removeTnc(tnc.id); onChange(); }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </Stack>

              <Divider sx={{ my: 1.5 }} />

              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Radios</Typography>
              {tnc.radios.length === 0 && (
                <Typography variant="body2" color="text.secondary">No radios added yet.</Typography>
              )}
              <List dense disablePadding>
                {tnc.radios.map((r) => (
                  <ListItem
                    key={r.id}
                    disableGutters
                    secondaryAction={
                      <IconButton edge="end" size="small" onClick={async () => { await window.nexdigi.removeRadio(tnc.id, r.id); onChange(); }}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    }
                  >
                    <ListItemText
                      primary={`${r.callsign}${r.name ? ` — ${r.name}` : ''}`}
                      secondary={`port ${r.portNumber || 0}`}
                    />
                  </ListItem>
                ))}
              </List>
            </CardContent>
            <CardActions>
              <Button size="small" onClick={() => setRadioTargetTnc(tnc)}>Add radio</Button>
            </CardActions>
          </Card>
        ))}
      </Stack>

      <AddTncDialog open={addOpen} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); onChange(); }} />
      <AddRadioDialog tnc={radioTargetTnc} onClose={() => setRadioTargetTnc(null)} onCreated={() => { setRadioTargetTnc(null); onChange(); }} />
    </Box>
  );
}
