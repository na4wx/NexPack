import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Stack, TextField, Typography, IconButton, Tooltip, Switch, FormControlLabel,
  MenuItem, Divider, Button, Alert
} from '@mui/material';
import { getStationIconHtml, GLYPHS } from '../../aprs/aprsIcons';

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
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

export default function AprsSettingsPanel({ tncs }) {
  // My Station / beacon
  const [mycall, setMycall] = useState('');
  const [symbol, setSymbol] = useState('/>');
  const [comment, setComment] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [beaconEnabled, setBeaconEnabled] = useState(false);
  const [interval_, setInterval_] = useState(30);
  const [pathStr, setPathStr] = useState('WIDE1-1,WIDE2-1');
  const [radioKey, setRadioKey] = useState('');
  const [myStationError, setMyStationError] = useState('');
  const [myStationSaved, setMyStationSaved] = useState(false);

  // APRS-IS
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState('noam.aprs2.net');
  const [port, setPort] = useState(14580);
  const [isCallsign, setIsCallsign] = useState('');
  const [passcode, setPasscode] = useState('-1');
  const [filter, setFilter] = useState('');
  const [txPasscode, setTxPasscode] = useState('');
  const [aprsIsSaved, setAprsIsSaved] = useState(false);

  // Map cache
  const [cacheInfo, setCacheInfo] = useState(null);
  const [budgetMb, setBudgetMb] = useState('');
  const [clearing, setClearing] = useState(false);

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs || []) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  useEffect(() => {
    window.nexdigi.aprsGetMyStation().then((my) => {
      setMycall(my.mycall || '');
      setSymbol(my.symbol || '/>');
      setComment(my.comment || '');
      setLat(my.homePosition ? String(my.homePosition.lat) : '');
      setLon(my.homePosition ? String(my.homePosition.lon) : '');
      const beacon = my.beacon || {};
      setBeaconEnabled(!!beacon.enabled);
      setInterval_(beacon.intervalMinutes || 30);
      setPathStr(beacon.path || 'WIDE1-1,WIDE2-1');
      setRadioKey(beacon.tncId && beacon.radioId ? `${beacon.tncId}:${beacon.radioId}` : '');
    });
    window.nexdigi.aprsGetSettings().then((s) => {
      const cfg = (s && s.aprsIs) || {};
      setEnabled(!!cfg.enabled);
      setHost(cfg.host || 'noam.aprs2.net');
      setPort(cfg.port || 14580);
      setIsCallsign(cfg.callsign || '');
      setPasscode(cfg.passcode || '-1');
      setFilter(cfg.filter || '');
      setTxPasscode(cfg.txPasscode || '');
    });
    refreshCacheInfo();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshCacheInfo = () => window.nexdigi.getMapCacheInfo().then((i) => {
    setCacheInfo(i);
    setBudgetMb(String(Math.round(i.budgetBytes / (1024 * 1024))));
  });

  const saveMyStation = async () => {
    const r = radios.find((x) => x.key === radioKey);
    const homePosition = (lat.trim() && lon.trim()) ? { lat: Number(lat), lon: Number(lon) } : null;
    await window.nexdigi.aprsSaveMyStation({
      mycall: mycall.trim().toUpperCase(),
      symbol,
      comment: comment.trim(),
      homePosition,
      beacon: { enabled: beaconEnabled, intervalMinutes: Number(interval_) || 30, path: pathStr.trim(), tncId: r ? r.tncId : null, radioId: r ? r.radioId : null }
    });
  };

  const saveMyStationClick = async () => {
    setMyStationError('');
    try {
      await saveMyStation();
      setMyStationSaved(true);
      setTimeout(() => setMyStationSaved(false), 2000);
    } catch (e) {
      setMyStationError(e.message || String(e));
    }
  };

  const beaconNow = async () => {
    setMyStationError('');
    try {
      await saveMyStation();
      await window.nexdigi.aprsBeaconNow();
      setMyStationSaved(true);
      setTimeout(() => setMyStationSaved(false), 2000);
    } catch (e) {
      setMyStationError(e.message || String(e));
    }
  };

  const saveAprsIs = async () => {
    await window.nexdigi.aprsSaveSettings({ aprsIs: { enabled, host: host.trim(), port: Number(port), callsign: isCallsign.trim(), passcode: passcode.trim() || '-1', filter: filter.trim(), txPasscode: txPasscode.trim() } });
    setAprsIsSaved(true);
    setTimeout(() => setAprsIsSaved(false), 2000);
  };

  const saveBudget = async () => {
    const mb = Math.max(0, Number(budgetMb) || 0);
    await window.nexdigi.setMapCacheBudget(mb * 1024 * 1024);
    refreshCacheInfo();
  };

  const clearCache = async () => {
    setClearing(true);
    try { await window.nexdigi.clearMapCache(); await refreshCacheInfo(); } finally { setClearing(false); }
  };

  return (
    <Stack spacing={4} sx={{ maxWidth: 480 }}>
      <Stack spacing={2}>
        <Typography variant="subtitle1">My Station</Typography>
        <TextField label="Callsign" value={mycall} onChange={(e) => setMycall(e.target.value)} placeholder="N0CALL-9" />
        <Typography variant="caption" color="text.secondary">
          Give APRS its own SSID (e.g. N0CALL-9) distinct from Terminal/BBS if beaconing might run at the
          same time as a connected-mode session on the same radio.
        </Typography>
        <Typography variant="caption" color="text.secondary">Symbol</Typography>
        <SymbolPicker value={symbol} onChange={setSymbol} />
        <TextField label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="NexPack" />
        <Stack direction="row" spacing={1}>
          <TextField label="Home latitude" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="39.8000" />
          <TextField label="Home longitude" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-98.6000" />
        </Stack>

        <Divider />
        <Typography variant="subtitle2">Beacon</Typography>
        <FormControlLabel control={<Switch checked={beaconEnabled} onChange={(e) => setBeaconEnabled(e.target.checked)} />} label="Periodic beacon" />
        <TextField label="Interval (minutes)" type="number" value={interval_} onChange={(e) => setInterval_(e.target.value)} disabled={!beaconEnabled} />
        <TextField label="Path" value={pathStr} onChange={(e) => setPathStr(e.target.value)} disabled={!beaconEnabled} />
        <TextField select label="Radio" value={radioKey} onChange={(e) => setRadioKey(e.target.value)}>
          <MenuItem value="">None</MenuItem>
          {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
        </TextField>
        {radios.length === 0 && (
          <Alert severity="info">No radios configured yet — add one under TNCs &amp; Radios in the nav.</Alert>
        )}
        {myStationError && <Typography variant="body2" color="error">{myStationError}</Typography>}
        <Box>
          <Button variant="contained" onClick={saveMyStationClick}>Save</Button>
          <Button onClick={beaconNow} sx={{ ml: 1 }}>Beacon now</Button>
          {myStationSaved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
        </Box>
      </Stack>

      <Stack spacing={2}>
        <Typography variant="subtitle1">APRS-IS</Typography>
        <Typography variant="body2" color="text.secondary">
          RF monitoring works automatically with no settings — any UI frame heard on a configured radio is
          checked for APRS content. APRS-IS below is optional and off by default.
        </Typography>
        <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="Connect to APRS-IS" />
        <TextField label="Host" value={host} onChange={(e) => setHost(e.target.value)} disabled={!enabled} />
        <TextField label="Port" type="number" value={port} onChange={(e) => setPort(e.target.value)} disabled={!enabled} />
        <TextField label="APRS-IS login callsign" value={isCallsign} onChange={(e) => setIsCallsign(e.target.value)} placeholder="N0CALL-1" disabled={!enabled} helperText="Separate from My Station's callsign above — APRS-IS conventionally uses its own SSID (e.g. -1)" />
        <TextField
          label="Receive passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} disabled={!enabled}
          helperText="-1 = receive-only (no transmit/gate), the default. Enter your real passcode only if you have one."
        />
        <TextField label="Filter (optional)" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="r/33.5/-96.5/50" disabled={!enabled} />
        <TextField
          label="Transmit passcode (optional)" value={txPasscode} onChange={(e) => setTxPasscode(e.target.value)} disabled={!enabled}
          helperText="Only needed if you also want beacons/messages gated to APRS-IS. Leave blank to transmit RF-only."
        />
        <Box>
          <Button variant="contained" onClick={saveAprsIs}>Save</Button>
          {aprsIsSaved && <Typography component="span" variant="body2" color="success.main" sx={{ ml: 2 }}>Saved</Typography>}
        </Box>
      </Stack>

      <Stack spacing={2}>
        <Typography variant="subtitle1">Map Cache</Typography>
        <Typography variant="body2" color="text.secondary">
          Map tiles are cached on disk as you view them, so the map keeps working offline. A tile stays
          cached indefinitely unless OpenStreetMap has actually updated it, or the budget below needs the
          space for newer tiles.
        </Typography>
        {cacheInfo && (
          <Typography variant="body2">
            {cacheInfo.tileCount.toLocaleString()} tiles cached — {formatBytes(cacheInfo.totalBytes)} of {formatBytes(cacheInfo.budgetBytes)} used
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
        <Box>
          <Button color="error" variant="outlined" onClick={clearCache} disabled={clearing}>
            {clearing ? 'Clearing…' : 'Clear cached tiles'}
          </Button>
        </Box>
      </Stack>
    </Stack>
  );
}
