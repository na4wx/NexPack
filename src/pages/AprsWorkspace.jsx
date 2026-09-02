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
import RouterIcon from '@mui/icons-material/Router';
import SendIcon from '@mui/icons-material/Send';
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CachedOsmTileLayer from '../aprs/CachedOsmTileLayer';
import { getStationIconHtml, GLYPHS } from '../aprs/aprsIcons';
import MonitorPane from '../components/MonitorPane';

const STALE_MS = 30 * 60 * 1000; // 30 minutes — matches typical real-client defaults (UI-View etc.)
const MAX_MONITOR_EVENTS = 3000;
const DOCK_WIDTH = 340;

// Lightweight drag-to-resize for a panel's width — no extra dependency,
// just a narrow draggable strip plus a hook tracking the width. `edge`
// says which side of the panel the handle (and the panel itself) is on:
// 'right' for a panel anchored to the left (dragging right grows it, like
// the station list), 'left' for a panel anchored to the right (dragging
// left grows it, like the docked Messages/Monitor/station-detail panels).
// Width persists per-panel across restarts via localStorage.
function useResizableWidth(storageKey, defaultWidth, { min = 220, max = 640, edge = 'right' } = {}) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(storageKey));
      return saved >= min && saved <= max ? saved : defaultWidth;
    } catch (e) { return defaultWidth; }
  });
  const drag = useRef(null);

  useEffect(() => {
    const onMove = (e) => {
      if (!drag.current) return;
      const delta = e.clientX - drag.current.startX;
      const signedDelta = edge === 'right' ? delta : -delta;
      const next = Math.min(max, Math.max(min, drag.current.startWidth + signedDelta));
      setWidth(next);
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [edge, min, max]);

  useEffect(() => {
    try { window.localStorage.setItem(storageKey, String(width)); } catch (e) { /* ignore */ }
  }, [storageKey, width]);

  const onMouseDown = (e) => {
    drag.current = { startX: e.clientX, startWidth: width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return [width, onMouseDown];
}

function ResizeHandle({ onMouseDown }) {
  return (
    <Box
      onMouseDown={onMouseDown}
      sx={{
        width: 6, flexShrink: 0, cursor: 'col-resize', alignSelf: 'stretch',
        '&:hover': { bgcolor: 'action.hover' }
      }}
    />
  );
}

// Same idea as useResizableWidth/ResizeHandle but for the vertical split
// between two panels stacked in one column (Messages above Packet Monitor)
// — a ratio (0..1, how much of the container's height the top panel gets)
// instead of a pixel width, since the container itself can resize.
function useResizableSplit(storageKey, defaultRatio = 0.5, { min = 0.15, max = 0.85 } = {}) {
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(storageKey));
      return saved >= min && saved <= max ? saved : defaultRatio;
    } catch (e) { return defaultRatio; }
  });
  const drag = useRef(null);

  useEffect(() => {
    const onMove = (e) => {
      if (!drag.current) return;
      const deltaRatio = (e.clientY - drag.current.startY) / drag.current.containerHeight;
      const next = Math.min(max, Math.max(min, drag.current.startRatio + deltaRatio));
      setRatio(next);
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [min, max]);

  useEffect(() => {
    try { window.localStorage.setItem(storageKey, String(ratio)); } catch (e) { /* ignore */ }
  }, [storageKey, ratio]);

  // containerRef: the stack's own Box, so the drag can convert pixel
  // movement into a fraction of however tall the stack currently is.
  const onMouseDown = (e, containerRef) => {
    const rect = containerRef.current ? containerRef.current.getBoundingClientRect() : { height: 400 };
    drag.current = { startY: e.clientY, startRatio: ratio, containerHeight: rect.height };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return [ratio, onMouseDown];
}

function SplitHandle({ onMouseDown }) {
  return (
    <Box
      onMouseDown={onMouseDown}
      sx={{
        height: 6, flexShrink: 0, cursor: 'row-resize', alignSelf: 'stretch',
        borderTop: 1, borderBottom: 1, borderColor: 'divider',
        '&:hover': { bgcolor: 'action.hover' }
      }}
    />
  );
}

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

// Shared title bar for anything that can either float as a modal Dialog or
// dock in the strip to the right of the map — same content component is
// used in both places, this just gives it a consistent header with a
// dock/undock toggle plus a close button.
function DockableHeader({ title, docked, onToggleDock, onClose }) {
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ px: docked ? 1.5 : 3, py: docked ? 1 : 1.5, borderBottom: docked ? 1 : 0, borderColor: 'divider' }}>
      <Typography variant={docked ? 'subtitle1' : 'h6'} sx={{ flexGrow: 1 }}>{title}</Typography>
      <Tooltip title={docked ? 'Open as a window' : 'Dock to the side'}>
        <IconButton size="small" onClick={onToggleDock}>
          {docked ? <OpenInNewIcon fontSize="small" /> : <VerticalSplitIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
    </Stack>
  );
}

function MessagesContent({ initialTarget }) {
  const [messages, setMessages] = useState([]);
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');

  useEffect(() => {
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
  }, [initialTarget]);

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
    <Box sx={{ display: 'flex', gap: 2, flexGrow: 1, minHeight: 0, p: 0 }}>
      <Box sx={{ width: 140, flexShrink: 0, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
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
            <Box key={m.id} sx={{ alignSelf: m.direction === 'out' ? 'flex-end' : 'flex-start', maxWidth: '90%' }}>
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
    </Box>
  );
}

// Modal-only now — a docked Messages panel is rendered by DockedSidebar
// below instead, stacked with Packet Monitor rather than sitting beside it.
function MessagesModal({ open, onClose, onToggleDock, initialTarget }) {
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DockableHeader title="APRS Messages" docked={false} onToggleDock={onToggleDock} onClose={onClose} />
      <DialogContent sx={{ display: 'flex', height: 420, p: 0 }}>
        <MessagesContent initialTarget={initialTarget} />
      </DialogContent>
    </Dialog>
  );
}

// Modal-only — see MessagesModal above.
function PacketMonitorModal({ open, onClose, onToggleDock, events }) {
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DockableHeader title="Packet Monitor" docked={false} onToggleDock={onToggleDock} onClose={onClose} />
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', height: 520, p: 0 }}>
        <Box sx={{ flexGrow: 1, minHeight: 0 }}>
          <MonitorPane events={events} />
        </Box>
      </DialogContent>
    </Dialog>
  );
}

// Messages and Packet Monitor, when both docked, stack one above the other
// in a single column (rather than sitting side by side, which got wide
// fast) — this renders whichever of the two are open+docked, with a
// drag-to-resize divider between them when both are present. Station
// detail is intentionally NOT part of this stack — it's rendered by the
// caller to this component's left, between the map and this sidebar.
function DockedSidebar({
  width, messagesOpen, monitorOpen, onCloseMessages, onCloseMonitor,
  onUndockMessages, onUndockMonitor, initialTarget, monitorEvents
}) {
  const containerRef = useRef(null);
  const [split, onSplitResizeStart] = useResizableSplit('aprs.dockSplit', 0.5);
  if (!messagesOpen && !monitorOpen) return null;
  const both = messagesOpen && monitorOpen;

  return (
    <Box ref={containerRef} sx={{ width, flexShrink: 0, borderLeft: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {messagesOpen && (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', flexBasis: both ? `${split * 100}%` : 'auto', flexGrow: both ? 0 : 1 }}>
          <DockableHeader title="Messages" docked onToggleDock={onUndockMessages} onClose={onCloseMessages} />
          <MessagesContent initialTarget={initialTarget} />
        </Box>
      )}
      {both && <SplitHandle onMouseDown={(e) => onSplitResizeStart(e, containerRef)} />}
      {monitorOpen && (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', flexBasis: both ? `${(1 - split) * 100}%` : 'auto', flexGrow: both ? 0 : 1 }}>
          <DockableHeader title="Packet Monitor" docked onToggleDock={onUndockMonitor} onClose={onCloseMonitor} />
          {/* MonitorPane fills its immediate parent via height:100%, which only
              resolves against a parent that's itself a sized flex item — same
              { flexGrow: 1, minHeight: 0 } wrapper TerminalWorkspace uses. */}
          <Box sx={{ flexGrow: 1, minHeight: 0 }}>
            <MonitorPane events={monitorEvents} />
          </Box>
        </Box>
      )}
    </Box>
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

function StationDetailPanel({ station, onClose, onMessage, width }) {
  if (!station) return null;
  const t = station.telemetry;
  return (
    <Box sx={{ width, flexShrink: 0, borderLeft: 1, borderColor: 'divider', overflowY: 'auto', p: 1.5 }}>
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
  const [messagesDocked, setMessagesDocked] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorDocked, setMonitorDocked] = useState(false);
  const [monitorEvents, setMonitorEvents] = useState([]);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [messageTarget, setMessageTarget] = useState('');
  const [aprsIsConnected, setAprsIsConnected] = useState(false);
  const [unread, setUnread] = useState(0);
  const [homePosition, setHomePosition] = useState(null);
  const [beaconSaving, setBeaconSaving] = useState(false);
  const [beaconError, setBeaconError] = useState('');

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
    const offMonitor = window.nexdigi.onMonitor((evt) => {
      setMonitorEvents((prev) => {
        const next = prev.length >= MAX_MONITOR_EVENTS ? prev.slice(prev.length - MAX_MONITOR_EVENTS + 1) : prev.slice();
        next.push(evt);
        return next;
      });
    });
    return () => { offStation(); offStatus(); offObject(); offMessage(); offMonitor(); };
  }, [messagesOpen]);

  // Always most-recently-heard first — a distance-based re-sort used to run
  // whenever a home position was set (i.e. almost always), which silently
  // overrode this and buried stations that had just been heard.
  const list = useMemo(() => {
    let all = Object.values(stations).sort((a, b) => b.lastSeen - a.lastSeen);
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      all = all.filter((s) => s.callsign.includes(q));
    }
    return all;
  }, [stations, search]);

  const withPosition = list.filter((s) => s.lastPosition);
  const objectList = Object.values(objects).filter((o) => !o.killed && o.lat !== undefined);
  const selected = selectedCallsign ? stations[selectedCallsign] : null;
  const defaultCenter = homePosition ? [homePosition.lat, homePosition.lon] : (withPosition.length ? [withPosition[0].lastPosition.lat, withPosition[0].lastPosition.lon] : [39.8, -98.6]);

  const openMessages = (target) => {
    setMessageTarget(target || '');
    setUnread(0);
    setMessagesOpen(true);
  };

  const toggleMonitor = () => {
    if (monitorOpen) { setMonitorOpen(false); return; }
    setMonitorOpen(true);
  };

  // Beacon text itself lives in Settings (My Station -> Beacon text) and is
  // included automatically on every beacon, scheduled or manual — this is
  // just a quick "send one now" action, not a place to edit that text.
  const sendBeacon = async () => {
    setBeaconSaving(true);
    setBeaconError('');
    try {
      await window.nexdigi.aprsBeaconNow();
    } catch (e) {
      setBeaconError(e.message || String(e));
    } finally {
      setBeaconSaving(false);
    }
  };

  const [sidebarWidth, onSidebarResizeStart] = useResizableWidth('aprs.sidebarWidth', 280, { min: 220, max: 480, edge: 'right' });
  const [detailWidth, onDetailResizeStart] = useResizableWidth('aprs.detailWidth', 320, { min: 260, max: 560, edge: 'left' });
  // Messages and Packet Monitor now stack in one column (DockedSidebar)
  // rather than sitting side by side, so they share a single width.
  const [dockWidth, onDockResizeStart] = useResizableWidth('aprs.dockWidth', DOCK_WIDTH, { min: 280, max: 720, edge: 'left' });

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      <Box sx={{ width: sidebarWidth, flexShrink: 0, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
          <Chip size="small" label={aprsIsConnected ? 'APRS-IS connected' : 'APRS-IS off'} color={aprsIsConnected ? 'success' : 'default'} />
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title="My Station"><IconButton size="small" onClick={() => onOpenSettings('aprs')}><PersonIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Messages">
            <IconButton size="small" onClick={() => openMessages('')}>
              <Badge badgeContent={unread} color="error"><ChatIcon fontSize="small" /></Badge>
            </IconButton>
          </Tooltip>
          <Tooltip title="Packet monitor"><IconButton size="small" onClick={toggleMonitor}><RouterIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Objects"><IconButton size="small" onClick={() => setObjectsOpen(true)}><PlaceIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Beacon now">
            <span>
              <IconButton size="small" onClick={sendBeacon} disabled={beaconSaving}><SendIcon fontSize="small" /></IconButton>
            </span>
          </Tooltip>
          <Tooltip title="APRS settings"><IconButton size="small" onClick={() => onOpenSettings('aprs')}><SettingsIcon fontSize="small" /></IconButton></Tooltip>
        </Stack>
        {beaconError && <Typography variant="caption" color="error.main" sx={{ px: 1, mb: 1 }}>{beaconError}</Typography>}
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
      <ResizeHandle onMouseDown={onSidebarResizeStart} />

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

      {/* Station detail always sits immediately left of the docked
          Messages/Monitor sidebar (between it and the map), whichever of
          the two are open. */}
      {selected && (
        <>
          <ResizeHandle onMouseDown={onDetailResizeStart} />
          <StationDetailPanel station={selected} onClose={() => setSelectedCallsign(null)} onMessage={openMessages} width={detailWidth} />
        </>
      )}

      {((messagesOpen && messagesDocked) || (monitorOpen && monitorDocked)) && <ResizeHandle onMouseDown={onDockResizeStart} />}
      <DockedSidebar
        width={dockWidth}
        messagesOpen={messagesOpen && messagesDocked}
        monitorOpen={monitorOpen && monitorDocked}
        onCloseMessages={() => setMessagesOpen(false)}
        onCloseMonitor={() => setMonitorOpen(false)}
        onUndockMessages={() => setMessagesDocked(false)}
        onUndockMonitor={() => setMonitorDocked(false)}
        initialTarget={messageTarget}
        monitorEvents={monitorEvents}
      />

      <MessagesModal
        open={messagesOpen && !messagesDocked}
        onClose={() => setMessagesOpen(false)}
        onToggleDock={() => setMessagesDocked(true)}
        initialTarget={messageTarget}
      />
      <PacketMonitorModal
        open={monitorOpen && !monitorDocked}
        onClose={() => setMonitorOpen(false)}
        onToggleDock={() => setMonitorDocked(true)}
        events={monitorEvents}
      />

      <ObjectsDialog open={objectsOpen} onClose={() => setObjectsOpen(false)} />
    </Box>
  );
}
