import React, { useEffect, useRef, useState } from 'react';
import { Box, Stack, Tabs, Tab, Button, IconButton, Typography, MenuItem, Select, Chip, Alert, TextField, Autocomplete, CircularProgress } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import CallMadeIcon from '@mui/icons-material/CallMade';
import CallEndIcon from '@mui/icons-material/CallEnd';
import MessageList from '../components/MessageList';
import MessageReadPane from '../components/MessageReadPane';
import ComposeDialog from '../components/ComposeDialog';

// Connect-alias keys are stored/matched verbatim — this only prettifies how
// they're displayed in the dropdown.
const ALIAS_LABEL = { telnet: 'Telnet (CMS)' };
const aliasLabel = (key) => ALIAS_LABEL[key] || key;

// RF is a synthetic option, not a saved alias: which RMS gateway is actually
// in range changes trip to trip, so instead of a fixed callsign baked into
// Settings, the node is typed here at connect time and turned straight into
// an ax25:///CALLSIGN target (the AGWPE TNC to reach it through is still
// configured once, in Winlink settings).
const RF_OPTION = '__rf__';
const CALLSIGN_RE = /^[A-Z0-9]{3,7}(-\d{1,2})?$/;

const FOLDERS = [
  { key: 'in', label: 'Inbox' },
  { key: 'out', label: 'Outbox' },
  { key: 'sent', label: 'Sent' },
  { key: 'archive', label: 'Archive' }
];

export default function WinlinkMail({ active, onOpenSettings }) {
  const [configured, setConfigured] = useState(null); // null = unknown yet
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [folder, setFolder] = useState('in');
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [aliases, setAliases] = useState({});
  const [connectAlias, setConnectAlias] = useState('');
  const [rfNodeCall, setRfNodeCall] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [log, setLog] = useState([]);
  const logRef = useRef(null);
  const [rmsOptions, setRmsOptions] = useState([]);
  const [rmsLoading, setRmsLoading] = useState(false);
  const [rmsError, setRmsError] = useState(null);
  const rmsLoadedRef = useRef(false);

  const boot = async () => {
    const settings = await window.nexdigi.winlinkGetSettings();
    setConfigured(!!settings);
    if (!settings) return;
    setStarting(true);
    setStartError(null);
    try {
      await window.nexdigi.winlinkStart();
      const a = await window.nexdigi.winlinkGetConnectAliases();
      setAliases(a || {});
      const keys = Object.keys(a || {});
      if (keys.length) setConnectAlias(keys[0]);
      await refreshFolder('in');
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => { boot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // WinlinkMail stays mounted (App.jsx keeps every workspace alive under
  // display:none) so boot()'s one-time alias fetch never re-runs after a
  // connect target is added/removed in Settings — e.g. filling in an RMS
  // Gateway callsign there wouldn't show up in the "Telnet" dropdown here
  // until the whole app restarted. Re-fetch aliases each time this page is
  // actually navigated back to.
  useEffect(() => {
    if (!active || configured === false) return;
    window.nexdigi.winlinkGetConnectAliases().then((a) => {
      setAliases(a || {});
      setConnectAlias((prev) => (prev && a && a[prev] ? prev : Object.keys(a || {})[0] || ''));
    });
  }, [active, configured]);

  useEffect(() => {
    const off = window.nexdigi.onWinlinkLog((line) => setLog((prev) => [...prev.slice(-200), line]));
    return off;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const refreshFolder = async (f) => {
    setFolder(f);
    setSelected(null);
    try {
      const list = await window.nexdigi.winlinkListMessages(f);
      setMessages(list || []);
    } catch (e) { setMessages([]); }
  };

  const openMessage = async (m) => {
    const full = await window.nexdigi.winlinkGetMessage(folder, m.MID);
    setSelected(full);
    if (folder === 'in' && full.Unread) {
      await window.nexdigi.winlinkMarkRead(folder, m.MID, true);
      refreshFolder(folder);
    }
  };

  const send = async ({ to, cc, subject, body }) => {
    await window.nexdigi.winlinkSendMessage({ to, cc, subject, body });
    if (folder === 'out') refreshFolder('out');
  };

  // Winlink's own directory of active RMS Gateways (pat downloads and caches
  // it from winlink.org) — fetched lazily the first time RF is picked, not
  // on every page load, since it's a ~1000+ entry directory covering every
  // packet gateway on the air, not just local ones. Restricted to packet
  // mode: this app only ever connects over AX.25, not VARA/Pactor/Ardop,
  // which the same directory also lists. Deduped to one entry per callsign
  // (a gateway can list several channels/frequencies) — the frequency isn't
  // used for anything here, it's shown only as a hint.
  const loadRmsOptions = async () => {
    if (rmsLoadedRef.current || rmsLoading) return;
    setRmsLoading(true);
    setRmsError(null);
    try {
      const list = await window.nexdigi.winlinkSearchRms({ mode: 'packet' });
      const seen = new Set();
      const opts = [];
      for (const g of list || []) {
        if (!g || !g.callsign || seen.has(g.callsign)) continue;
        seen.add(g.callsign);
        opts.push(g);
      }
      setRmsOptions(opts);
      rmsLoadedRef.current = true;
    } catch (e) {
      setRmsError(e.message);
    } finally {
      setRmsLoading(false);
    }
  };

  useEffect(() => {
    if (connectAlias === RF_OPTION) loadRmsOptions();
  }, [connectAlias]); // eslint-disable-line react-hooks/exhaustive-deps

  const rfNodeValid = CALLSIGN_RE.test(rfNodeCall.trim().toUpperCase());

  const doConnect = async () => {
    if (!connectAlias) return;
    let url;
    if (connectAlias === RF_OPTION) {
      if (!rfNodeValid) {
        setLog((prev) => [...prev.slice(-200), 'Connect failed: enter a valid node callsign (e.g. NA4WX-10)']);
        return;
      }
      url = `ax25:///${rfNodeCall.trim().toUpperCase()}`;
    } else {
      url = aliases[connectAlias];
    }
    setConnecting(true);
    try {
      await window.nexdigi.winlinkConnect(url);
      await refreshFolder(folder);
    } catch (e) {
      setLog((prev) => [...prev.slice(-200), `Connect failed: ${e.message}`]);
    } finally {
      setConnecting(false);
    }
  };

  if (configured === false) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1 }}>Set up Winlink</Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Add your callsign and Winlink account to start sending and receiving real Winlink email.
        </Typography>
        <Button variant="contained" onClick={() => onOpenSettings('winlink')}>Winlink settings</Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setComposeOpen(true)}>Compose</Button>
        <Select size="small" value={connectAlias} onChange={(e) => setConnectAlias(e.target.value)} displayEmpty sx={{ minWidth: 220 }}>
          {Object.keys(aliases).length === 0 && <MenuItem value="" disabled>No connect targets configured</MenuItem>}
          {Object.keys(aliases).map((k) => <MenuItem key={k} value={k}>{aliasLabel(k)}</MenuItem>)}
          <MenuItem value={RF_OPTION}>RF (RMS Gateway)</MenuItem>
        </Select>
        {connectAlias === RF_OPTION && (
          <Autocomplete
            size="small"
            freeSolo
            autoSelect
            options={rmsOptions}
            loading={rmsLoading}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.callsign)}
            isOptionEqualToValue={(o, v) => o.callsign === (typeof v === 'string' ? v : v.callsign)}
            filterOptions={(opts, state) => {
              const input = state.inputValue.trim().toUpperCase();
              const matches = input ? opts.filter((o) => o.callsign.toUpperCase().includes(input)) : opts;
              return matches.slice(0, 50);
            }}
            inputValue={rfNodeCall}
            onInputChange={(_e, value) => setRfNodeCall(value.toUpperCase())}
            onChange={(_e, value) => setRfNodeCall(((typeof value === 'string' ? value : value && value.callsign) || '').toUpperCase())}
            renderOption={(props, option) => (
              <Box component="li" {...props} key={option.callsign}>
                <Box>
                  <Typography variant="body2">{option.callsign}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[option.gridsquare, Number.isFinite(option.distance) ? `${Math.round(option.distance)} mi` : null, option.modes, option.freq && option.freq.desc].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Node callsign"
                placeholder="e.g. NA4WX-10"
                error={rfNodeCall.length > 0 && !rfNodeValid}
                helperText={rmsError ? `Gateway list unavailable: ${rmsError}` : undefined}
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {rmsLoading && <CircularProgress size={16} sx={{ mr: 1 }} />}
                      {params.InputProps.endAdornment}
                    </>
                  )
                }}
              />
            )}
            sx={{ minWidth: 260 }}
          />
        )}
        <Button size="small" startIcon={<CallMadeIcon />} disabled={!connectAlias || (connectAlias === RF_OPTION && !rfNodeValid) || connecting} onClick={doConnect}>
          {connecting ? 'Connecting…' : 'Connect'}
        </Button>
        <Button size="small" color="error" startIcon={<CallEndIcon />} onClick={() => window.nexdigi.winlinkDisconnect(true)}>
          Disconnect
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {starting && <Chip size="small" label="Starting pat…" />}
        <IconButton size="small" onClick={() => onOpenSettings('winlink')}><SettingsIcon fontSize="small" /></IconButton>
      </Stack>

      {startError && <Alert severity="error" sx={{ m: 1 }}>{startError}</Alert>}

      <Tabs value={folder} onChange={(_e, v) => refreshFolder(v)} sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}>
        {FOLDERS.map((f) => <Tab key={f.key} value={f.key} label={f.label} sx={{ minHeight: 36, py: 0.5 }} />)}
      </Tabs>

      <Box sx={{ flexGrow: 1, display: 'flex', minHeight: 0 }}>
        <Box sx={{ width: 340, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
          <MessageList
            messages={messages}
            selectedId={selected && selected.MID}
            onSelect={openMessage}
            getId={(m) => m.MID}
            getSubject={(m) => m.Subject}
            getFrom={(m) => (m.From && m.From.Addr) || ''}
            getDate={(m) => new Date(m.Date).toLocaleString()}
            getUnread={(m) => m.Unread}
          />
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <MessageReadPane
            message={selected}
            subject={selected && selected.Subject}
            from={selected && selected.From && selected.From.Addr}
            to={selected && selected.To && selected.To.map((t) => t.Addr).join(', ')}
            date={selected && new Date(selected.Date).toLocaleString()}
            body={selected && selected.Body}
            onReply={selected ? () => setComposeOpen(true) : null}
            onArchive={selected ? async () => { await window.nexdigi.winlinkArchiveMessage(folder, selected.MID); refreshFolder(folder); } : null}
            onDelete={selected ? async () => { await window.nexdigi.winlinkDeleteMessage(folder, selected.MID); refreshFolder(folder); } : null}
          />
        </Box>
      </Box>

      <Box ref={logRef} sx={{ height: 100, overflowY: 'auto', borderTop: 1, borderColor: 'divider', p: 1, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'text.secondary' }}>
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </Box>

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onSend={send}
        showCc
        initialTo={selected ? selected.From.Addr : ''}
        initialSubject={selected ? `Re: ${selected.Subject}` : ''}
      />
    </Box>
  );
}
