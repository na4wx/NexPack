import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Popup, Polyline, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Box, Stack, TextField, List, ListItemButton, ListItemText, Typography, IconButton,
  Chip, Dialog, DialogTitle, DialogContent, DialogActions, Button, Divider, Badge, Tooltip
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import PersonIcon from '@mui/icons-material/Person';
import ChatIcon from '@mui/icons-material/Chat';
import PlaceIcon from '@mui/icons-material/Place';
import CloseIcon from '@mui/icons-material/Close';
import CachedOsmTileLayer from '../aprs/CachedOsmTileLayer';
import { getStationIconHtml, GLYPHS } from '../aprs/aprsIcons';

const STALE_MS = 30 * 60 * 1000; // 30 minutes — matches typical real-client defaults (UI-View etc.)

function stationIcon(symbol) {
  return L.divIcon({ html: getStationIconHtml(symbol), className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
}

function objectIcon(symbol) {
  const html = `<div style="border:2px dashed #ffb74d;border-radius:50%;padding:1px;background:rgba(0,0,0,0.25)">${getStationIconHtml(symbol)}</div>`;
  return L.divIcon({ html, className: '', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16] });
}

function isStale(lastSeen) { return Date.now() - lastSeen > STALE_MS; }

function distanceLabel(s) {
  if (s.distanceMiles === undefined) return null;
  return `${s.distanceMiles.toFixed(1)} mi @ ${Math.round(s.bearing)}°`;
}

function RecenterOnSelect({ station }) {
  const map = useMap();
  useEffect(() => {
    if (station && station.lastPosition) map.setView([station.lastPosition.lat, station.lastPosition.lon], Math.max(map.getZoom(), 10));
  }, [station, map]);
  return null;
}

function SymbolPicker({ value, onChange }) {
  const codes = Object.keys(GLYPHS);
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 0.5, maxHeight: 180, overflowY: 'auto', p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      {codes.map((code) => (
        <Tooltip key={code} title={code}>
          <IconButton
            size="small"
            onClick={() => onChange(code)}
            sx={{ border: code === value ? '2px solid #5b9bff' : '2px solid transparent', borderRadius: 1 }}
          >
            <Box component="span" dangerouslySetInnerHTML={{ __html: getStationIconHtml(code) }} />
          </IconButton>
        </Tooltip>
      ))}
    </Box>
  );
}

function MessagesDialog({ open, onClose, initialTarget }) {
  const [messages, setMessages] = useState([]);
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');

  useEffect(() => {
    if (!open) return;
    window.nexdigi.aprsGetMessages().then(setMessages);
    setTarget(initialTarget || '');
    const off = window.nexdigi.onAprsMessage((entry) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === entry.id);
        if (idx === -1) return [...prev, entry];
        const next = prev.slice();
        next[idx] = entry;
        return next;
      });
    });
    return off;
  }, [open, initialTarget]);

  const conversations = useMemo(() => {
    const set = new Set(messages.map((m) => m.callsign));
    return Array.from(set);
  }, [messages]);

  const thread = useMemo(() => messages.filter((m) => m.callsign === target).sort((a, b) => a.timestamp - b.timestamp), [messages, target]);

  const send = async () => {
    if (!target.trim() || !text.trim()) return;
    await window.nexdigi.aprsSendMessage(target.trim().toUpperCase(), text.trim());
    setText('');
  };

  const statusColor = { sent: 'default', acked: 'success', failed: 'error', rejected: 'error', received: 'info', cancelled: 'default' };
  const cancel = (msgId) => window.nexdigi.aprsCancelMessage(msgId);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>APRS Messages</DialogTitle>
      <DialogContent sx={{ display: 'flex', gap: 2, height: 420, p: 0 }}>
        <Box sx={{ width: 160, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
          <List dense>
            {conversations.map((c) => (
              <ListItemButton key={c} selected={c === target} onClick={() => setTarget(c)}>
                <ListItemText primary={c} />
              </ListItemButton>
            ))}
          </List>
        </Box>
        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', p: 1, minWidth: 0 }}>
          <TextField size="small" label="To callsign" value={target} onChange={(e) => setTarget(e.target.value.toUpperCase())} sx={{ mb: 1 }} />
          <Box sx={{ flexGrow: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {thread.map((m) => (
              <Box key={m.id} sx={{ alignSelf: m.direction === 'out' ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                <Box sx={{ bgcolor: m.direction === 'out' ? 'primary.dark' : 'action.selected', borderRadius: 1, px: 1, py: 0.5 }}>
                  <Typography variant="body2">{m.text}</Typography>
                </Box>
                {m.direction === 'out' && (
                  <Chip
                    size="small"
                    label={m.status}
                    color={statusColor[m.status] || 'default'}
                    sx={{ mt: 0.3 }}
                    onDelete={m.status === 'sent' ? () => cancel(m.msgId) : undefined}
                    deleteIcon={m.status === 'sent' ? <Tooltip title="Cancel — stop retrying"><CloseIcon fontSize="small" /></Tooltip> : undefined}
                  />
                )}
              </Box>
            ))}
            {thread.length === 0 && <Typography variant="body2" color="text.secondary">No messages with this station yet.</Typography>}
          </Box>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField size="small" fullWidth placeholder="Message text (max 67 chars)" value={text} onChange={(e) => setText(e.target.value.slice(0, 67))} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
            <Button variant="contained" onClick={send} disabled={!target.trim() || !text.trim()}>Send</Button>
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

function ObjectsDialog({ open, onClose }) {
  const [objects, setObjects] = useState({});
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [symbol, setSymbol] = useState('/#');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (!open) return;
    window.nexdigi.aprsGetObjects().then((list) => {
      const map = {};
      for (const o of list || []) map[o.name] = o;
      setObjects(map);
    });
    const off = window.nexdigi.onAprsObject((record) => setObjects((prev) => ({ ...prev, [record.name]: record })));
    return off;
  }, [open]);

  const create = async () => {
    if (!name.trim() || !lat.trim() || !lon.trim()) return;
    await window.nexdigi.aprsCreateObject(name.trim().toUpperCase(), { lat: Number(lat), lon: Number(lon), symbol, comment: comment.trim() });
    setName(''); setLat(''); setLon(''); setComment('');
  };

  const list = Object.values(objects);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>APRS Objects</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <List dense>
            {list.length === 0 && <Typography variant="body2" color="text.secondary">No objects yet.</Typography>}
            {list.map((o) => (
              <ListItemButton key={o.name} disableRipple sx={{ opacity: o.killed ? 0.5 : 1 }}>
                <ListItemText primary={o.name} secondary={`${o.killed ? 'killed' : 'active'} · ${o.ownedByMe ? 'mine' : `via ${o.ownerCallsign || 'RF'}`}`} />
                {o.ownedByMe && !o.killed && (
                  <Button size="small" color="error" onClick={() => window.nexdigi.aprsKillObject(o.name)}>Kill</Button>
                )}
              </ListItemButton>
            ))}
          </List>
          <Divider />
          <Typography variant="subtitle2">Create object</Typography>
          <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} inputProps={{ maxLength: 9 }} />
          <Stack direction="row" spacing={1}>
            <TextField size="small" label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} />
            <TextField size="small" label="Longitude" value={lon} onChange={(e) => setLon(e.target.value)} />
          </Stack>
          <Typography variant="caption" color="text.secondary">Symbol</Typography>
          <SymbolPicker value={symbol} onChange={setSymbol} />
          <TextField size="small" label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
          <Button variant="contained" onClick={create} disabled={!name.trim() || !lat.trim() || !lon.trim()}>Create</Button>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

function StationDetailPanel({ station, onClose, onMessage }) {
  if (!station) return null;
  const t = station.telemetry;
  return (
    <Box sx={{ width: 320, borderLeft: 1, borderColor: 'divider', overflowY: 'auto', p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h6" sx={{ flexGrow: 1 }}>{station.callsign}</Typography>
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </Stack>
      <Typography variant="body2" color="text.secondary">{station.source} · last heard {new Date(station.lastSeen).toLocaleString()}</Typography>
      {station.comment && <Typography variant="body2" sx={{ mt: 1 }}>{station.comment}</Typography>}
      {station.distanceMiles !== undefined && (
        <Chip size="small" icon={<PlaceIcon />} label={distanceLabel(station)} sx={{ mt: 1 }} />
      )}
      <Button size="small" startIcon={<ChatIcon />} sx={{ mt: 1 }} onClick={() => onMessage(station.callsign)}>Message</Button>

      {station.weather && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="subtitle2">Weather</Typography>
          <Typography variant="body2">
            {station.weather.temperature !== undefined && `${station.weather.temperature}°F `}
            {station.weather.humidity !== undefined && `${station.weather.humidity}% RH `}
            {station.weather.windSpeed !== undefined && `wind ${station.weather.windSpeed}mph`}
          </Typography>
        </>
      )}

      {t && t.last && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="subtitle2">Telemetry (seq {t.last.seq})</Typography>
          {t.last.analog.map((v, i) => {
            const name = t.metadata && t.metadata.names && t.metadata.names[i];
            const unit = t.metadata && t.metadata.units && t.metadata.units[i];
            const scaled = t.last.scaled && t.last.scaled[i];
            return (
              <Typography key={i} variant="body2">
                {name || `Ch${i + 1}`}: {scaled !== undefined && scaled !== null ? scaled.toFixed(2) : v}{unit ? ` ${unit}` : ''}
              </Typography>
            );
          })}
        </>
      )}

      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2">Position history ({(station.positionHistory || []).length})</Typography>
      <List dense sx={{ maxHeight: 140, overflowY: 'auto' }}>
        {(station.positionHistory || []).slice().reverse().slice(0, 20).map((p, i) => (
          <ListItemText key={i} primary={`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`} secondary={new Date(p.timestamp).toLocaleTimeString()} />
        ))}
      </List>

      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2">Packet log ({(station.packetLog || []).length})</Typography>
      <List dense sx={{ maxHeight: 160, overflowY: 'auto' }}>
        {(station.packetLog || []).slice().reverse().slice(0, 30).map((p, i) => (
          <ListItemText key={i} primary={p.raw} secondary={new Date(p.timestamp).toLocaleTimeString()} primaryTypographyProps={{ variant: 'caption', sx: { wordBreak: 'break-all' } }} />
        ))}
      </List>
    </Box>
  );
}

export default function AprsWorkspace({ onOpenSettings }) {
  const [stations, setStations] = useState({});
  const [objects, setObjects] = useState({});
  const [selectedCallsign, setSelectedCallsign] = useState(null);
  const [search, setSearch] = useState('');
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [messageTarget, setMessageTarget] = useState('');
  const [aprsIsConnected, setAprsIsConnected] = useState(false);
  const [unread, setUnread] = useState(0);
  const [homePosition, setHomePosition] = useState(null);

  useEffect(() => {
    window.nexdigi.aprsGetStations().then((list) => {
      const map = {};
      for (const s of list || []) map[s.callsign] = s;
      setStations(map);
    });
    window.nexdigi.aprsGetObjects().then((list) => {
      const map = {};
      for (const o of list || []) map[o.name] = o;
      setObjects(map);
    });
    window.nexdigi.aprsGetMyStation().then((my) => setHomePosition(my.homePosition || null));
    const offStation = window.nexdigi.onAprsStation((record) => {
      setStations((prev) => ({ ...prev, [record.callsign]: record }));
    });
    const offStatus = window.nexdigi.onAprsIsStatus((status) => setAprsIsConnected(!!status.connected));
    const offObject = window.nexdigi.onAprsObject((record) => setObjects((prev) => ({ ...prev, [record.name]: record })));
    const offMessage = window.nexdigi.onAprsMessage((entry) => {
      if (entry.direction === 'in' && !entry.read && !messagesOpen) setUnread((n) => n + 1);
    });
    return () => { offStation(); offStatus(); offObject(); offMessage(); };
  }, [messagesOpen]);

  const list = useMemo(() => {
    let all = Object.values(stations).sort((a, b) => b.lastSeen - a.lastSeen);
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      all = all.filter((s) => s.callsign.includes(q));
    }
    if (homePosition) all = all.slice().sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity));
    return all;
  }, [stations, search, homePosition]);

  const withPosition = list.filter((s) => s.lastPosition);
  const objectList = Object.values(objects).filter((o) => !o.killed && o.lat !== undefined);
  const selected = selectedCallsign ? stations[selectedCallsign] : null;
  const defaultCenter = homePosition ? [homePosition.lat, homePosition.lon] : (withPosition.length ? [withPosition[0].lastPosition.lat, withPosition[0].lastPosition.lon] : [39.8, -98.6]);

  const openMessages = (target) => {
    setMessageTarget(target || '');
    setUnread(0);
    setMessagesOpen(true);
  };

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      <Box sx={{ width: 280, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
          <Chip size="small" label={aprsIsConnected ? 'APRS-IS connected' : 'APRS-IS off'} color={aprsIsConnected ? 'success' : 'default'} />
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title="My Station"><IconButton size="small" onClick={() => onOpenSettings('aprs')}><PersonIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Messages">
            <IconButton size="small" onClick={() => openMessages('')}>
              <Badge badgeContent={unread} color="error"><ChatIcon fontSize="small" /></Badge>
            </IconButton>
          </Tooltip>
          <Tooltip title="Objects"><IconButton size="small" onClick={() => setObjectsOpen(true)}><PlaceIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="APRS settings"><IconButton size="small" onClick={() => onOpenSettings('aprs')}><SettingsIcon fontSize="small" /></IconButton></Tooltip>
        </Stack>
        <TextField size="small" placeholder="Search callsign…" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ mx: 1, mb: 1 }} />
        <List dense sx={{ overflowY: 'auto', flexGrow: 1 }}>
          {list.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No stations heard yet.</Typography>}
          {list.map((s) => (
            <ListItemButton key={s.callsign} selected={s.callsign === selectedCallsign} onClick={() => setSelectedCallsign(s.callsign)} disabled={!s.lastPosition} sx={{ opacity: isStale(s.lastSeen) ? 0.5 : 1 }}>
              <ListItemText
                primary={s.callsign}
                secondary={`${distanceLabel(s) ? distanceLabel(s) + ' · ' : ''}${s.source}${s.lastPosition ? '' : ' · no position'} · ${new Date(s.lastSeen).toLocaleTimeString()}`}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <MapContainer center={defaultCenter} zoom={withPosition.length ? 8 : 4} style={{ height: '100%', width: '100%', background: '#0d1117' }}>
          <CachedOsmTileLayer attribution='&copy; OpenStreetMap contributors' />
          {homePosition && <Circle center={[homePosition.lat, homePosition.lon]} radius={16093} pathOptions={{ color: '#5b9bff', weight: 1, fillOpacity: 0.03 }} />}
          {withPosition.map((s) => (
            <Marker key={s.callsign} position={[s.lastPosition.lat, s.lastPosition.lon]} icon={stationIcon(s.symbol)} opacity={isStale(s.lastSeen) ? 0.4 : 1} eventHandlers={{ click: () => setSelectedCallsign(s.callsign) }}>
              <Popup>
                <strong>{s.callsign}</strong><br />
                {s.comment && <>{s.comment}<br /></>}
                {s.lastPosition.course !== undefined && s.lastPosition.speed !== undefined && (
                  <>Course {Math.round(s.lastPosition.course)}° @ {Math.round(s.lastPosition.speed)}kt<br /></>
                )}
                {s.weather && (
                  <>{s.weather.temperature !== undefined ? `${s.weather.temperature}°F ` : ''}{s.weather.humidity !== undefined ? `${s.weather.humidity}% RH` : ''}<br /></>
                )}
                {distanceLabel(s) && <>{distanceLabel(s)}<br /></>}
                via {s.source} · heard {new Date(s.lastSeen).toLocaleString()}
              </Popup>
            </Marker>
          ))}
          {objectList.map((o) => (
            <Marker key={`obj-${o.name}`} position={[o.lat, o.lon]} icon={objectIcon(o.symbol)}>
              <Popup>
                <strong>{o.name}</strong> (object)<br />
                {o.comment && <>{o.comment}<br /></>}
                {o.ownedByMe ? 'owned by me' : `via ${o.ownerCallsign || 'RF'}`}
              </Popup>
            </Marker>
          ))}
          {selected && selected.positionHistory && selected.positionHistory.length > 1 && (
            <Polyline positions={selected.positionHistory.map((p) => [p.lat, p.lon])} pathOptions={{ color: '#5b9bff', weight: 2 }} />
          )}
          <RecenterOnSelect station={selected} />
        </MapContainer>
      </Box>

      {selected && (
        <StationDetailPanel station={selected} onClose={() => setSelectedCallsign(null)} onMessage={openMessages} />
      )}

      <MessagesDialog open={messagesOpen} onClose={() => setMessagesOpen(false)} initialTarget={messageTarget} />
      <ObjectsDialog open={objectsOpen} onClose={() => setObjectsOpen(false)} />
    </Box>
  );
}
