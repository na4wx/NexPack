import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Tabs, Tab, IconButton, TextField, MenuItem, Button, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CallMadeIcon from '@mui/icons-material/CallMade';
import CodeIcon from '@mui/icons-material/Code';
import MonitorPane from '../components/MonitorPane';
import SessionPane from '../components/SessionPane';
import ScriptEditorDialog from '../components/ScriptEditorDialog';

const MAX_MONITOR_EVENTS = 3000;
const MAX_PATH_HOPS = 8;

function radioLabel(tnc, radio) {
  return `${radio.callsign} · ${tnc.name}`;
}

function parsePathInput(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_PATH_HOPS);
}

export default function TerminalWorkspace({ tncs }) {
  const [monitorEvents, setMonitorEvents] = useState([]);
  const [tabs, setTabs] = useState([{ key: 'all', kind: 'monitor', label: 'All traffic', radioId: null, tncId: null }]);
  const [activeTab, setActiveTab] = useState('all');
  const [sessions, setSessions] = useState({}); // sessionId -> snapshot
  const [transcripts, setTranscripts] = useState({}); // sessionId -> [{dir,text}]
  const [selectedRadioKey, setSelectedRadioKey] = useState('');
  const [connectCall, setConnectCall] = useState('');
  const [connectPath, setConnectPath] = useState('');
  const [connectScriptId, setConnectScriptId] = useState('');
  const [scripts, setScripts] = useState([]);
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [fileOffers, setFileOffers] = useState({}); // sessionId -> {filename, totalBytes}
  const [transferProgress, setTransferProgress] = useState({}); // sessionId -> progress
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const radios = useMemo(() => {
    const list = [];
    for (const tnc of tncs) for (const r of tnc.radios) list.push({ key: `${tnc.id}:${r.id}`, tncId: tnc.id, radioId: r.id, tnc, radio: r });
    return list;
  }, [tncs]);

  const loadScripts = () => window.nexdigi.listScripts().then(setScripts);

  useEffect(() => {
    loadScripts();
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
    const offTx = window.nexdigi.onSessionTx(({ sessionId, text }) => {
      setTranscripts((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] || []), { dir: 'tx', text }] }));
    });
    const offOffer = window.nexdigi.onFileTransferOffer((evt) => {
      setFileOffers((prev) => ({ ...prev, [evt.sessionId]: evt }));
    });
    const offProgress = window.nexdigi.onFileTransferProgress((evt) => {
      setTransferProgress((prev) => ({ ...prev, [evt.sessionId]: evt }));
    });
    const offComplete = window.nexdigi.onFileTransferComplete((evt) => {
      setFileOffers((prev) => { const next = { ...prev }; delete next[evt.sessionId]; return next; });
      setTransferProgress((prev) => { const next = { ...prev }; delete next[evt.sessionId]; return next; });
      setTranscripts((prev) => ({ ...prev, [evt.sessionId]: [...(prev[evt.sessionId] || []), { dir: 'rx', text: `[file transfer complete: ${evt.filename}]` }] }));
    });
    const offError = window.nexdigi.onFileTransferError((evt) => {
      setFileOffers((prev) => { const next = { ...prev }; delete next[evt.sessionId]; return next; });
      setTransferProgress((prev) => { const next = { ...prev }; delete next[evt.sessionId]; return next; });
      setTranscripts((prev) => ({ ...prev, [evt.sessionId]: [...(prev[evt.sessionId] || []), { dir: 'rx', text: `[file transfer failed: ${evt.message}]` }] }));
    });
    return () => { offMonitor(); offState(); offData(); offTx(); offOffer(); offProgress(); offComplete(); offError(); };
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
    const path = parsePathInput(connectPath);
    const snap = await window.nexdigi.startSession(r.tncId, r.radioId, connectCall.trim().toUpperCase(), path, connectScriptId || undefined);
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

  // The 'session-tx' event (below) appends to the transcript for every
  // send regardless of source (user-typed, scripted, etc.) — no local
  // append needed here.
  const sendSessionText = (sessionId, text) => window.nexdigi.sendSessionText(sessionId, text);

  const disconnectSession = (sessionId) => window.nexdigi.endSession(sessionId);

  const sendFile = async (sessionId) => {
    const filePath = await window.nexdigi.pickFileToSend();
    if (!filePath) return;
    await window.nexdigi.sendFile(sessionId, filePath);
  };

  const respondFileOffer = async (sessionId, accept) => {
    const offer = fileOffers[sessionId];
    if (accept) {
      const savePath = await window.nexdigi.pickSaveLocation(offer && offer.filename);
      if (!savePath) return; // user cancelled the save dialog — leave the offer pending
      await window.nexdigi.respondFileOffer(sessionId, true, savePath);
    } else {
      await window.nexdigi.respondFileOffer(sessionId, false);
      setFileOffers((prev) => { const next = { ...prev }; delete next[sessionId]; return next; });
    }
  };

  const runScript = async (sessionId, scriptId) => {
    await window.nexdigi.runScript(sessionId, scriptId);
  };

  const active = tabs.find((t) => t.key === activeTab) || tabs[0];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap', rowGap: 1 }}>
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
          sx={{ width: 180 }}
        />
        <TextField
          size="small" label="Path (optional)" value={connectPath}
          onChange={(e) => setConnectPath(e.target.value)}
          placeholder="WIDE1-1,WIDE2-1"
          sx={{ width: 180 }}
        />
        <TextField select size="small" label="Script" value={connectScriptId} onChange={(e) => setConnectScriptId(e.target.value)} sx={{ minWidth: 140 }}>
          <MenuItem value="">None</MenuItem>
          {scripts.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
        </TextField>
        <IconButton size="small" onClick={() => setScriptEditorOpen(true)} title="Manage scripts">
          <CodeIcon fontSize="small" />
        </IconButton>
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
            onSendFile={() => sendFile(active.sessionId)}
            fileOffer={fileOffers[active.sessionId]}
            onRespondOffer={(accept) => respondFileOffer(active.sessionId, accept)}
            transferProgress={transferProgress[active.sessionId]}
            onAbortTransfer={() => window.nexdigi.abortFileTransfer(active.sessionId)}
            scripts={scripts}
            onRunScript={(scriptId) => runScript(active.sessionId, scriptId)}
          />
        )}
      </Box>

      <ScriptEditorDialog open={scriptEditorOpen} onClose={() => setScriptEditorOpen(false)} onChanged={loadScripts} />
    </Box>
  );
}
