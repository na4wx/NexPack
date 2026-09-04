import React, { useEffect, useRef, useState } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';

const PULSE_MS = 250;
const LIGHTS = [
  { key: 'tx', mutedColor: '#5c2323', brightColor: '#ff1a1a', label: 'TX — transmitting' },
  { key: 'rx', mutedColor: '#1f4a26', brightColor: '#00e676', label: 'RX — channel activity heard' },
  { key: 'dec', mutedColor: '#5c531f', brightColor: '#ffea00', label: 'DEC — decoded a valid packet' }
];

// Always shows its color (muted when idle, bright when active) instead of
// going fully grey — a real TNC's panel LEDs are colored whether lit or
// not, so an idle light still tells you at a glance which is which.
function Light({ mutedColor, brightColor, active, label }) {
  return (
    <Tooltip title={label} placement="top">
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: active ? brightColor : mutedColor,
          boxShadow: active ? `0 0 4px ${brightColor}` : 'none',
          transition: 'background-color 80ms linear, box-shadow 80ms linear'
        }}
      />
    </Tooltip>
  );
}

// Minimal, always-on view of every configured TNC — three small lights
// (TX/RX/DEC) that flash briefly on real traffic, driven by the same
// 'monitor' event stream the Terminal packet monitor uses. RX flashes on
// ANY heard activity, including a frame that failed to parse as valid
// AX.25 (TncManager emits frameType:'error' for that — the real signal
// distinguishing "something was heard" from "and it decoded cleanly",
// which is what DEC represents). Toggleable in Settings → General for
// smaller screens.
export default function TncStatusBar({ tncs }) {
  const [pulses, setPulses] = useState({}); // tncId -> {tx,rx,dec}
  const timersRef = useRef({});

  useEffect(() => {
    const setLight = (tncId, light, on) => {
      setPulses((prev) => ({ ...prev, [tncId]: { ...(prev[tncId] || {}), [light]: on } }));
    };
    const pulse = (tncId, light) => {
      setLight(tncId, light, true);
      const timerKey = `${tncId}:${light}`;
      clearTimeout(timersRef.current[timerKey]);
      timersRef.current[timerKey] = setTimeout(() => setLight(tncId, light, false), PULSE_MS);
    };
    const off = window.nexdigi.onMonitor((evt) => {
      if (evt.direction === 'tx') { pulse(evt.tncId, 'tx'); return; }
      pulse(evt.tncId, 'rx');
      if (evt.frameType !== 'error') pulse(evt.tncId, 'dec');
    });
    const timers = timersRef.current;
    return () => { off(); Object.values(timers).forEach(clearTimeout); };
  }, []);

  if (!tncs || tncs.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, px: 2, py: 0.5, borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper', overflowX: 'auto', flexShrink: 0 }}>
      {tncs.map((t) => {
        const p = pulses[t.id] || {};
        return (
          <Stack key={t.id} direction="row" spacing={0.75} alignItems="center" sx={{ flexShrink: 0, opacity: t.status === 'connected' ? 1 : 0.4 }}>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {t.name}
            </Typography>
            {LIGHTS.map((l) => <Light key={l.key} mutedColor={l.mutedColor} brightColor={l.brightColor} active={!!p[l.key]} label={l.label} />)}
          </Stack>
        );
      })}
    </Box>
  );
}
