import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, TextField, IconButton, Tooltip, Typography, InputAdornment } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import { frameColors } from '../theme';

const LABELS = {
  ui: 'UI', iframe: 'I', sabm: 'SABM', ua: 'UA', disc: 'DISC', dm: 'DM',
  supervisory: 'RR', error: 'ERR', unknown: '?'
};

const COLOR_KEY = {
  ui: 'ui', iframe: 'iframe', sabm: 'control', ua: 'control', disc: 'control',
  dm: 'control', supervisory: 'control', error: 'error', unknown: 'info'
};

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export default function MonitorPane({ events }) {
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState([]);
  const [cleared, setCleared] = useState(0);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (paused && frozen.length === 0) setFrozen(events);
  }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const source = (paused ? frozen : events).slice(cleared);
    if (!filter.trim()) return source;
    const q = filter.toLowerCase();
    return source.filter((e) =>
      (e.addresses || []).join(' ').toLowerCase().includes(q) ||
      (e.text || '').toLowerCase().includes(q) ||
      (LABELS[e.frameType] || '').toLowerCase().includes(q)
    );
  }, [events, frozen, paused, filter, cleared]);

  useEffect(() => {
    if (!paused && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visible, paused]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}>
        <TextField
          size="small"
          placeholder="Filter by callsign, text, or frame type…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          fullWidth
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <Tooltip title={paused ? 'Resume live updates' : 'Pause'}>
          <IconButton size="small" onClick={() => { setPaused((p) => !p); if (paused) setFrozen([]); }}>
            {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Clear">
          <IconButton size="small" onClick={() => setCleared(events.length)}>
            <ClearAllIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box ref={scrollRef} sx={{ flexGrow: 1, overflowY: 'auto', px: 1.5, py: 1, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: 13 }}>
        {visible.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            No traffic yet.
          </Typography>
        )}
        {visible.map((e, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1, py: 0.25, alignItems: 'baseline', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <Typography component="span" variant="caption" sx={{ color: 'text.secondary', flexShrink: 0, width: 96 }}>
              {fmtTime(e.timestamp)}
            </Typography>
            <Typography component="span" variant="caption" sx={{ color: e.direction === 'tx' ? 'secondary.main' : 'text.secondary', flexShrink: 0, width: 22 }}>
              {e.direction === 'tx' ? 'TX' : 'RX'}
            </Typography>
            <Typography component="span" variant="caption" sx={{ color: frameColors[COLOR_KEY[e.frameType]] || frameColors.info, fontWeight: 700, flexShrink: 0, width: 44 }}>
              {LABELS[e.frameType] || e.frameType}
            </Typography>
            <Typography component="span" variant="caption" sx={{ color: 'text.primary', flexShrink: 0 }}>
              {(e.addresses || []).join(' → ')}
            </Typography>
            {e.text ? (
              <Typography component="span" variant="caption" sx={{ color: 'text.primary' }}>
                {e.text}
              </Typography>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
