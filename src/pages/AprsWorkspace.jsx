import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Box, Stack, TextField, List, ListItemButton, ListItemText, Typography, IconButton,
  Chip, Dialog, DialogTitle, DialogContent, DialogActions, Button, Switch, FormControlLabel
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { getStationIconHtml } from '../aprs/aprsIcons';

function stationIcon(symbol) {
  return L.divIcon({ html: getStationIconHtml(symbol), className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
}

function RecenterOnSelect({ station }) {
  const map = useMap();
  useEffect(() => {
    if (station && station.lastPosition) map.setView([station.lastPosition.lat, station.lastPosition.lon], Math.max(map.getZoom(), 10));
  }, [station, map]);
  return null;
}

function AprsSettingsDialog({ open, onClose, onSaved }) {
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState('noam.aprs2.net');
  const [port, setPort] = useState(14580);
  const [callsign, setCallsign] = useState('');
  const [passcode, setPasscode] = useState('-1');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open) return;
    window.nexdigi.aprsGetSettings().then((s) => {
      const cfg = (s && s.aprsIs) || {};
      setEnabled(!!cfg.enabled);
      setHost(cfg.host || 'noam.aprs2.net');
      setPort(cfg.port || 14580);
      setCallsign(cfg.callsign || '');
      setPasscode(cfg.passcode || '-1');
      setFilter(cfg.filter || '');
    });
  }, [open]);

  const submit = async () => {
    await window.nexdigi.aprsSaveSettings({ aprsIs: { enabled, host: host.trim(), port: Number(port), callsign: callsign.trim(), passcode: passcode.trim() || '-1', filter: filter.trim() } });
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>APRS settings</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            RF monitoring works automatically with no settings — any UI frame heard on a configured radio is checked for APRS content. APRS-IS below is optional and off by default.
          </Typography>
          <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="Connect to APRS-IS" />
          <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} disabled={!enabled} />
          <TextField label="Port" type="number" value={port} onChange={(e) => setPort(e.target.value)} disabled={!enabled} />
          <TextField label="Your callsign" value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="N0CALL-1" disabled={!enabled} />
          <TextField
            label="Passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} disabled={!enabled}
            helperText="-1 = receive-only (no transmit/gate), the default. Enter your real passcode only if you have one."
          />
          <TextField label="Filter (optional)" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="r/33.5/-96.5/50" disabled={!enabled} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function AprsWorkspace() {
  const [stations, setStations] = useState({});
  const [selectedCallsign, setSelectedCallsign] = useState(null);
  const [search, setSearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aprsIsConnected, setAprsIsConnected] = useState(false);

  useEffect(() => {
    window.nexdigi.aprsGetStations().then((list) => {
      const map = {};
      for (const s of list || []) map[s.callsign] = s;
      setStations(map);
    });
    const offStation = window.nexdigi.onAprsStation((record) => {
      setStations((prev) => ({ ...prev, [record.callsign]: record }));
    });
    const offStatus = window.nexdigi.onAprsIsStatus((status) => setAprsIsConnected(!!status.connected));
    return () => { offStation(); offStatus(); };
  }, []);

  const list = useMemo(() => {
    const all = Object.values(stations).sort((a, b) => b.lastSeen - a.lastSeen);
    if (!search.trim()) return all;
    const q = search.trim().toUpperCase();
    return all.filter((s) => s.callsign.includes(q));
  }, [stations, search]);

  const withPosition = list.filter((s) => s.lastPosition);
  const selected = selectedCallsign ? stations[selectedCallsign] : null;
  const defaultCenter = withPosition.length ? [withPosition[0].lastPosition.lat, withPosition[0].lastPosition.lon] : [39.8, -98.6]; // center of contiguous US as a sane default

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      <Box sx={{ width: 280, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
          <Chip size="small" label={aprsIsConnected ? 'APRS-IS connected' : 'APRS-IS off'} color={aprsIsConnected ? 'success' : 'default'} />
          <Box sx={{ flexGrow: 1 }} />
          <IconButton size="small" onClick={() => setSettingsOpen(true)}><SettingsIcon fontSize="small" /></IconButton>
        </Stack>
        <TextField size="small" placeholder="Search callsign…" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ mx: 1, mb: 1 }} />
        <List dense sx={{ overflowY: 'auto', flexGrow: 1 }}>
          {list.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No stations heard yet.</Typography>}
          {list.map((s) => (
            <ListItemButton key={s.callsign} selected={s.callsign === selectedCallsign} onClick={() => setSelectedCallsign(s.callsign)} disabled={!s.lastPosition}>
              <ListItemText
                primary={s.callsign}
                secondary={`${s.source}${s.lastPosition ? '' : ' · no position'} · ${new Date(s.lastSeen).toLocaleTimeString()}`}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <MapContainer center={defaultCenter} zoom={withPosition.length ? 8 : 4} style={{ height: '100%', width: '100%', background: '#0d1117' }}>
          <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {withPosition.map((s) => (
            <Marker key={s.callsign} position={[s.lastPosition.lat, s.lastPosition.lon]} icon={stationIcon(s.symbol)} eventHandlers={{ click: () => setSelectedCallsign(s.callsign) }}>
              <Popup>
                <strong>{s.callsign}</strong><br />
                {s.comment && <>{s.comment}<br /></>}
                {s.lastPosition.course !== undefined && s.lastPosition.speed !== undefined && (
                  <>Course {Math.round(s.lastPosition.course)}° @ {Math.round(s.lastPosition.speed)}kt<br /></>
                )}
                {s.weather && (
                  <>{s.weather.temperature !== undefined ? `${s.weather.temperature}°F ` : ''}{s.weather.humidity !== undefined ? `${s.weather.humidity}% RH` : ''}<br /></>
                )}
                via {s.source} · heard {new Date(s.lastSeen).toLocaleString()}
              </Popup>
            </Marker>
          ))}
          {selected && selected.positionHistory && selected.positionHistory.length > 1 && (
            <Polyline positions={selected.positionHistory.map((p) => [p.lat, p.lon])} pathOptions={{ color: '#5b9bff', weight: 2 }} />
          )}
          <RecenterOnSelect station={selected} />
        </MapContainer>
      </Box>

      <AprsSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={() => {}} />
    </Box>
  );
}
