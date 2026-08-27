import React, { useEffect, useRef, useState } from 'react';
import { Box, Stack, Chip, TextField, IconButton, Typography, Divider, Button, LinearProgress, MenuItem, Tooltip } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

const STATE_COLOR = { connecting: 'warning', connected: 'success', disconnected: 'default' };

export default function SessionPane({ session, transcript, onSend, onDisconnect, onSendFile, fileOffer, onRespondOffer, transferProgress, onAbortTransfer, scripts, onRunScript }) {
  const [input, setInput] = useState('');
  const [scriptId, setScriptId] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript]);

  const inYapp = session.mode === 'yapp';
  const canType = session.state === 'connected' && !inYapp;

  const send = () => {
    if (!input.trim() || !canType) return;
    onSend(input);
    setInput('');
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle2">{session.remoteCall}</Typography>
        <Chip size="small" label={session.state} color={STATE_COLOR[session.state] || 'default'} />
        {session.path && session.path.length > 0 && (
          <Tooltip title="Digipeater path"><Chip size="small" variant="outlined" label={session.path.join(',')} /></Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        {scripts && scripts.length > 0 && (
          <>
            <TextField select size="small" label="Script" value={scriptId} onChange={(e) => setScriptId(e.target.value)} sx={{ minWidth: 140 }}>
              <MenuItem value="">None</MenuItem>
              {scripts.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
            </TextField>
            <IconButton size="small" disabled={!scriptId || session.state !== 'connected'} onClick={() => onRunScript(scriptId)}>
              <PlayArrowIcon fontSize="small" />
            </IconButton>
          </>
        )}
        <IconButton size="small" disabled={!canType} onClick={onSendFile}>
          <AttachFileIcon fontSize="small" />
        </IconButton>
        <IconButton size="small" color="error" onClick={onDisconnect} disabled={session.state === 'disconnected'}>
          <LinkOffIcon fontSize="small" />
        </IconButton>
      </Stack>

      {session.logPath && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 1, pt: 0.5 }}>Logging to {session.logPath}</Typography>
      )}

      {fileOffer && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1, bgcolor: 'action.selected' }}>
          <Typography variant="body2" sx={{ flexGrow: 1 }}>
            Incoming file: {fileOffer.filename} ({fileOffer.totalBytes} bytes)
          </Typography>
          <Button size="small" variant="contained" onClick={() => onRespondOffer(true)}>Accept</Button>
          <Button size="small" onClick={() => onRespondOffer(false)}>Reject</Button>
        </Stack>
      )}

      {inYapp && transferProgress && (
        <Box sx={{ p: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" sx={{ flexGrow: 1 }}>
              {transferProgress.direction === 'send' ? 'Sending' : 'Receiving'} {transferProgress.filename || ''} — {transferProgress.bytesTransferred}/{transferProgress.totalBytes} bytes
            </Typography>
            <Button size="small" color="error" onClick={onAbortTransfer}>Cancel</Button>
          </Stack>
          <LinearProgress variant="determinate" value={transferProgress.totalBytes ? Math.min(100, (transferProgress.bytesTransferred / transferProgress.totalBytes) * 100) : 0} />
        </Box>
      )}

      <Box ref={scrollRef} sx={{ flexGrow: 1, overflowY: 'auto', p: 1.5, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: 13 }}>
        {transcript.map((line, i) => (
          <Typography
            key={i}
            variant="body2"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: line.dir === 'tx' ? 'secondary.main' : 'text.primary', mb: 0.5 }}
          >
            {line.dir === 'tx' ? '> ' : ''}{line.text}
          </Typography>
        ))}
      </Box>

      <Divider />
      <Stack direction="row" spacing={1} sx={{ p: 1 }}>
        <TextField
          size="small"
          fullWidth
          placeholder={inYapp ? 'File transfer in progress…' : session.state === 'connected' ? 'Type and press Enter…' : 'Waiting for connection…'}
          value={input}
          disabled={!canType}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <IconButton color="primary" onClick={send} disabled={!canType}>
          <SendIcon />
        </IconButton>
      </Stack>
    </Box>
  );
}
