import React, { useEffect, useState } from 'react';
import {
  Box, Stack, TextField, List, ListItemButton, ListItemText, Typography, IconButton,
  Dialog, DialogTitle, DialogContent, DialogActions, Button, MenuItem, Divider
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';

const STEP_TYPES = [
  { value: 'send', label: 'Send text' },
  { value: 'wait', label: 'Wait (ms)' },
  { value: 'waitFor', label: 'Wait for text' }
];

function emptyStep(type) {
  if (type === 'wait') return { type: 'wait', ms: 1000 };
  if (type === 'waitFor') return { type: 'waitFor', pattern: '' };
  return { type: 'send', text: '' };
}

function StepEditor({ steps, onChange }) {
  const update = (i, patch) => onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const remove = (i) => onChange(steps.filter((_, idx) => idx !== i));
  const add = () => onChange([...steps, emptyStep('send')]);

  return (
    <Stack spacing={1}>
      {steps.map((step, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center">
          <TextField
            select size="small" value={step.type}
            onChange={(e) => update(i, emptyStep(e.target.value))}
            sx={{ minWidth: 140 }}
          >
            {STEP_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
          </TextField>
          {step.type === 'send' && (
            <TextField size="small" fullWidth placeholder="Text to send" value={step.text} onChange={(e) => update(i, { text: e.target.value })} />
          )}
          {step.type === 'wait' && (
            <TextField size="small" type="number" placeholder="Milliseconds" value={step.ms} onChange={(e) => update(i, { ms: Number(e.target.value) })} />
          )}
          {step.type === 'waitFor' && (
            <TextField size="small" fullWidth placeholder="Substring to wait for" value={step.pattern} onChange={(e) => update(i, { pattern: e.target.value })} />
          )}
          <IconButton size="small" onClick={() => remove(i)}><DeleteIcon fontSize="small" /></IconButton>
        </Stack>
      ))}
      <Button size="small" startIcon={<AddIcon />} onClick={add}>Add step</Button>
    </Stack>
  );
}

export default function ScriptEditorDialog({ open, onClose, onChanged }) {
  const [scripts, setScripts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState([]);

  const load = () => window.nexdigi.listScripts().then(setScripts);

  useEffect(() => { if (open) load(); }, [open]);

  const selectScript = (script) => {
    setSelectedId(script.id);
    setName(script.name);
    setSteps(script.steps);
  };

  const newScript = () => {
    setSelectedId(null);
    setName('New script');
    setSteps([]);
  };

  const save = async () => {
    await window.nexdigi.saveScript({ id: selectedId, name: name.trim() || 'Untitled', steps });
    await load();
    onChanged();
  };

  const remove = async () => {
    if (!selectedId) return;
    await window.nexdigi.deleteScript(selectedId);
    newScript();
    await load();
    onChanged();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Connect scripts</DialogTitle>
      <DialogContent sx={{ display: 'flex', gap: 2, height: 420, p: 0 }}>
        <Box sx={{ width: 160, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
          <List dense>
            {scripts.map((s) => (
              <ListItemButton key={s.id} selected={s.id === selectedId} onClick={() => selectScript(s)}>
                <ListItemText primary={s.name} />
              </ListItemButton>
            ))}
          </List>
          <Button size="small" startIcon={<AddIcon />} onClick={newScript} sx={{ ml: 1 }}>New</Button>
        </Box>
        <Box sx={{ flexGrow: 1, p: 1, overflowY: 'auto' }}>
          {(selectedId !== null || name) ? (
            <Stack spacing={2}>
              <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} />
              <Divider />
              <Typography variant="subtitle2">Steps</Typography>
              <StepEditor steps={steps} onChange={setSteps} />
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">Select a script or create a new one.</Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        {selectedId && <Button color="error" onClick={remove}>Delete</Button>}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" onClick={save} disabled={!name.trim()}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
