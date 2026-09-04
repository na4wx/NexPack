import React, { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, List, ListItemButton, ListItemText, Collapse, Typography, Alert, CircularProgress, IconButton, InputAdornment } from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/FolderOutlined';
import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';

// Flattens the catalog tree into {name, template_path, folderPath}[] for search.
function flatten(node, folderPath = []) {
  const out = [];
  for (const f of node.forms || []) out.push({ name: f.name, template_path: f.template_path, folderPath });
  for (const sub of node.folders || []) out.push(...flatten(sub, [...folderPath, sub.name]));
  return out;
}

function Folder({ node, depth, expanded, toggle, onSelect }) {
  const isOpen = expanded.has(node.path);
  return (
    <>
      <ListItemButton onClick={() => toggle(node.path)} sx={{ pl: 2 + depth * 2 }}>
        <FolderIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
        <ListItemText primary={node.name} secondary={`${node.form_count} form${node.form_count === 1 ? '' : 's'}`} />
        {isOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
      </ListItemButton>
      <Collapse in={isOpen} unmountOnExit>
        <List dense disablePadding>
          {(node.folders || []).map((sub) => (
            <Folder key={sub.path} node={sub} depth={depth + 1} expanded={expanded} toggle={toggle} onSelect={onSelect} />
          ))}
          {(node.forms || []).map((f) => (
            <ListItemButton key={f.template_path} onClick={() => onSelect(f)} sx={{ pl: 4 + depth * 2 }}>
              <DescriptionIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
              <ListItemText primary={f.name} />
            </ListItemButton>
          ))}
        </List>
      </Collapse>
    </>
  );
}

// Browses pat's real Winlink Standard Forms catalog (ICS-213, radiograms,
// ARES/RACES forms, etc.) — the same official templates Winlink Express
// uses, downloaded and rendered by pat itself (see PatManager.js). Picking
// one opens the real form in its own window; onSelect only fires once
// that's actually submitted.
export default function WinlinkFormPicker({ open, onClose, onSelect }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const [updating, setUpdating] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await window.nexdigi.winlinkListFormCatalog());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const updateForms = async () => {
    setUpdating(true);
    setError(null);
    try {
      await window.nexdigi.winlinkUpdateForms();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setUpdating(false);
    }
  };

  const flatMatches = useMemo(() => {
    if (!catalog || !search.trim()) return null;
    const q = search.trim().toLowerCase();
    return flatten(catalog).filter((f) => f.name.toLowerCase().includes(q) || f.template_path.toLowerCase().includes(q));
  }, [catalog, search]);

  const handleSelect = (f) => {
    onSelect(f.template_path, f.name);
    setSearch('');
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New message from form</DialogTitle>
      <DialogContent sx={{ minHeight: 400, display: 'flex', flexDirection: 'column' }}>
        <TextField
          size="small"
          placeholder="Search forms…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ mb: 1 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        {loading && <CircularProgress size={24} sx={{ alignSelf: 'center', mt: 4 }} />}
        {error && <Alert severity="error">{error}</Alert>}
        {!loading && !error && catalog && catalog.form_count === 0 && (
          <Alert severity="info">
            No form templates downloaded yet — click "Update forms" below to fetch the official set from winlink.org.
          </Alert>
        )}
        {!loading && !error && catalog && catalog.form_count > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
            {catalog.form_count} forms, version {catalog.version}
          </Typography>
        )}
        {!loading && !error && flatMatches && (
          <List dense sx={{ flexGrow: 1, overflowY: 'auto' }}>
            {flatMatches.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No forms match "{search}".</Typography>}
            {flatMatches.map((f) => (
              <ListItemButton key={f.template_path} onClick={() => handleSelect(f)}>
                <DescriptionIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                <ListItemText primary={f.name} secondary={f.folderPath.join(' / ')} />
              </ListItemButton>
            ))}
          </List>
        )}
        {!loading && !error && !flatMatches && catalog && (
          <List dense sx={{ flexGrow: 1, overflowY: 'auto' }}>
            {(catalog.folders || []).map((f) => (
              <Folder key={f.path} node={f} depth={0} expanded={expanded} toggle={toggle} onSelect={handleSelect} />
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button startIcon={<RefreshIcon />} onClick={updateForms} disabled={updating}>
          {updating ? 'Updating…' : 'Update forms'}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
