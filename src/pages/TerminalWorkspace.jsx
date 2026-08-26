import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Tabs, Tab, IconButton, TextField, MenuItem, Button, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CallMadeIcon from '@mui/icons-material/CallMade';
import MonitorPane from '../components/MonitorPane';
import SessionPane from '../components/SessionPane';

const MAX_MONITOR_EVENTS = 3000;

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

export default function TerminalWorkspace({ tncs }) {
  const [monitorEvents, setMonitorEvents] = useState([]);
  const [tabs, setTabs] = useState([{ key: 'all', kind: 'monitor', label: 'All traffic', radioId: null, tncId: null }]);
  const [activeTab, setActiveTab] = useState('all');
  const [sessions, setSessions] = useState({}); // sessionId -> snapshot
  const [transcripts, setTranscripts] = useState({}); // sessionId -> [{dir,text}]
  const [selectedRadioKey, setSelectedRadioKey] = useState('');
  const [connectCall, setConnectCall] = useState('');
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  useEffect(() => {
    const offMonitor = window.nexdigi.onMonitor((evt) => {
      setMonitorEvents((prev) => {
        const next = prev.length >= MAX_MONITOR_EVENTS ? prev.slice(prev.length - MAX_MONITOR_EVENTS + 1) : prev.slice();
        next.push(evt);
        return next;
      });
    });
    const offState = window.nexdigi.onSessionState((snap) => {
      setSessions((prev) => ({ ...prev, [snap.id]: snap }));
      setTabs((prev) => {
        if (prev.some((t) => t.sessionId === snap.id)) return prev;
        return [...prev, { key: `session:${snap.id}`, kind: 'session', label: snap.remoteCall, sessionId: snap.id }];
      });
    });
    const offData = window.nexdigi.onSessionData(({ sessionId, text }) => {
      setTranscripts((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] || []), { dir: 'rx', text }] }));
    });
    return () => { offMonitor(); offState(); offData(); };
  }, []);

  const openMonitorTab = (radioKey) => {
    const r = radios.find((x) => x.key === radioKey);
    if (!r) return;
    const key = `monitor:${radioKey}`;
    setTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, kind: 'monitor', label: radioLabel(r.tnc, r.radio), radioId: r.radioId, tncId: r.tncId }]));
    setActiveTab(key);
  };

  const openSession = async () => {
    const r = radios.find((x) => x.key === selectedRadioKey);
    if (!r || !connectCall.trim()) return;
    const snap = await window.nexdigi.startSession(r.tncId, r.radioId, connectCall.trim().toUpperCase());
    setSessions((prev) => ({ ...prev, [snap.id]: snap }));
    const key = `session:${snap.id}`;
    setTabs((prev) => [...prev, { key, kind: 'session', label: snap.remoteCall, sessionId: snap.id }]);
    setActiveTab(key);
    setConnectCall('');
  };

  const closeTab = (key) => {
    setTabs((prev) => prev.filter((t) => t.key !== key));
    if (activeTab === key) setActiveTab('all');
  };

  const sendSessionText = (sessionId, text) => {
    window.nexdigi.sendSessionText(sessionId, text);
    setTranscripts((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] || []), { dir: 'tx', text }] }));
  };

  const disconnectSession = (sessionId) => window.nexdigi.endSession(sessionId);

  const active = tabs.find((t) => t.key === activeTab) || tabs[0];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <TextField
          select size="small" label="Radio" value={selectedRadioKey}
          onChange={(e) => setSelectedRadioKey(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          {radios.length === 0 && <MenuItem value="" disabled>No radios configured</MenuItem>}
          {radios.map((r) => <MenuItem key={r.key} value={r.key}>{radioLabel(r.tnc, r.radio)}</MenuItem>)}
        </TextField>
        <Button size="small" startIcon={<VisibilityIcon />} disabled={!selectedRadioKey} onClick={() => openMonitorTab(selectedRadioKey)}>
          Monitor
        </Button>
        <TextField
          size="small" label="Connect to callsign" value={connectCall}
          onChange={(e) => setConnectCall(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') openSession(); }}
          sx={{ width: 200 }}
        />
        <Button size="small" variant="contained" startIcon={<CallMadeIcon />} disabled={!selectedRadioKey || !connectCall.trim()} onClick={openSession}>
          Connect
        </Button>
      </Stack>

      <Tabs
        value={activeTab}
        onChange={(_e, v) => setActiveTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40 }}
      >
        {tabs.map((t) => (
          <Tab
            key={t.key}
            value={t.key}
            sx={{ minHeight: 40, py: 0.5 }}
            label={
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography variant="body2">{t.label}</Typography>
                {t.key !== 'all' && (
                  <IconButton size="small" component="span" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}>
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                )}
              </Stack>
            }
          />
        ))}
      </Tabs>

      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        {active && active.kind === 'monitor' && (
          <MonitorPane
            events={active.radioId ? monitorEvents.filter((e) => e.radioId === active.radioId) : monitorEvents}
          />
        )}
        {active && active.kind === 'session' && sessions[active.sessionId] && (
          <SessionPane
            session={sessions[active.sessionId]}
            transcript={transcripts[active.sessionId] || []}
            onSend={(text) => sendSessionText(active.sessionId, text)}
            onDisconnect={() => disconnectSession(active.sessionId)}
          />
        )}
      </Box>
    </Box>
  );
}
