import React, { useEffect, useRef, useState } from 'react';
import { Box, Stack, Chip, TextField, IconButton, Typography, Divider } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import LinkOffIcon from '@mui/icons-material/LinkOff';

const STATE_COLOR = { connecting: 'warning', connected: 'success', disconnected: 'default' };

export default function SessionPane({ session, transcript, onSend, onDisconnect }) {
  const [input, setInput] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript]);

  const send = () => {
    if (!input.trim() || session.state !== 'connected') return;
    onSend(input);
    setInput('');
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle2">{session.remoteCall}</Typography>
        <Chip size="small" label={session.state} color={STATE_COLOR[session.state] || 'default'} />
        <Box sx={{ flexGrow: 1 }} />
        <IconButton size="small" color="error" onClick={onDisconnect} disabled={session.state === 'disconnected'}>
          <LinkOffIcon fontSize="small" />
        </IconButton>
      </Stack>

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
          placeholder={session.state === 'connected' ? 'Type and press Enter…' : 'Waiting for connection…'}
          value={input}
          disabled={session.state !== 'connected'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <IconButton color="primary" onClick={send} disabled={session.state !== 'connected'}>
          <SendIcon />
        </IconButton>
      </Stack>
    </Box>
  );
}
