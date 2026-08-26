import React, { useEffect, useRef, useState } from 'react';
import {
  Box, Stack, List, ListItemButton, ListItemText, Typography, Button, IconButton,
  TextField, Chip, Dialog, DialogTitle, DialogContent, DialogActions
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import SendIcon from '@mui/icons-material/Send';
import NexDigiServerSettingsDialog from '../components/NexDigiServerSettingsDialog';

function CreateRoomDialog({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const submit = async () => {
    await window.nexdigi.chatCreateRoom(name.trim(), description.trim());
    setName(''); setDescription('');
    onCreated();
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>New room</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Room name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <TextField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!name.trim()} onClick={submit}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ChatWorkspace() {
  const [configured, setConfigured] = useState(null);
  const [connected, setConnected] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [currentRoom, setCurrentRoom] = useState(null);
  const [messagesByRoom, setMessagesByRoom] = useState({});
  const [users, setUsers] = useState([]);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const currentRoomRef = useRef(null);
  currentRoomRef.current = currentRoom;

  const appendMessage = (roomName, message) => {
    setMessagesByRoom((prev) => ({ ...prev, [roomName]: [...(prev[roomName] || []), message] }));
  };

  const refreshRooms = () => window.nexdigi.chatListRooms().then((r) => setRooms(r || []));

  const boot = async () => {
    const settings = await window.nexdigi.bbsGetSettings();
    setConfigured(!!settings);
    if (!settings) return;
    await window.nexdigi.chatConnect();
    await refreshRooms();
  };

  useEffect(() => { boot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const off = window.nexdigi.onChatEvent((msg) => {
      switch (msg.type) {
        case 'chat-connected':
          setConnected(true);
          if (msg.defaultRoom) switchRoom(msg.defaultRoom);
          break;
        case 'chat-message':
          if (msg.roomName && msg.message) {
            appendMessage(msg.roomName, { kind: 'chat', from: msg.message.from, text: msg.message.text, timestamp: msg.message.timestamp, id: msg.message.id });
          } else if (msg.text && currentRoomRef.current) {
            appendMessage(currentRoomRef.current, { kind: 'system', text: msg.text, timestamp: Date.now() });
          }
          break;
        case 'user-joined':
          if (msg.roomName) {
            appendMessage(msg.roomName, { kind: 'system', text: `${msg.callsign} joined`, timestamp: Date.now() });
            refreshRooms(); // userCount changed
            if (msg.roomName === currentRoomRef.current) refreshUsers(msg.roomName);
          }
          break;
        case 'user-left':
          if (msg.roomName) {
            appendMessage(msg.roomName, { kind: 'system', text: `${msg.callsign} left`, timestamp: Date.now() });
            refreshRooms();
            if (msg.roomName === currentRoomRef.current) refreshUsers(msg.roomName);
          }
          break;
        case 'topic-changed':
          if (msg.roomName) appendMessage(msg.roomName, { kind: 'system', text: `${msg.by} changed the topic to: ${msg.topic}`, timestamp: Date.now() });
          break;
        case 'user-muted':
          if (msg.roomName) appendMessage(msg.roomName, { kind: 'system', text: `${msg.callsign} was muted`, timestamp: Date.now() });
          break;
        case 'chat-private-message':
          if (currentRoomRef.current && msg.message) {
            appendMessage(currentRoomRef.current, { kind: 'system', text: `[private from ${msg.message.from}] ${msg.message.text}`, timestamp: Date.now() });
          }
          break;
        case 'chat-disconnected':
          setConnected(false);
          break;
        default:
          break;
      }
    });
    const offErr = window.nexdigi.onChatError((e) => setError(e.message));
    return () => { off(); offErr(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messagesByRoom, currentRoom]);

  const refreshUsers = async (roomName) => {
    setUsers(await window.nexdigi.chatGetRoomUsers(roomName));
  };

  const switchRoom = async (name) => {
    try {
      const result = await window.nexdigi.chatSwitchRoom(name);
      setCurrentRoom(name);
      setMessagesByRoom((prev) => ({
        ...prev,
        [name]: (result.history || []).map((m) => ({ kind: 'chat', from: m.from, text: m.text, timestamp: m.timestamp, id: m.id }))
      }));
      setUsers(result.users || []);
      refreshRooms();
    } catch (e) {
      setError(e.message);
    }
  };

  const send = async () => {
    if (!input.trim() || !currentRoom) return;
    try {
      await window.nexdigi.chatSendMessage(input.trim());
      setInput('');
    } catch (e) {
      setError(e.message);
    }
  };

  const messages = messagesByRoom[currentRoom] || [];

  if (configured === false) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1 }}>Connect to a NexDigi server</Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Chat runs on your NexDigi digipeater — add its address and password to join rooms.
        </Typography>
        <Button variant="contained" onClick={() => setSettingsOpen(true)}>NexDigi server settings</Button>
        <NexDigiServerSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={boot} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      <Box sx={{ width: 220, borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" alignItems="center" sx={{ p: 1 }}>
          <Chip size="small" label={connected ? 'connected' : 'offline'} color={connected ? 'success' : 'default'} sx={{ mr: 1 }} />
          <Box sx={{ flexGrow: 1 }} />
          <IconButton size="small" onClick={() => setCreateRoomOpen(true)}><AddIcon fontSize="small" /></IconButton>
          <IconButton size="small" onClick={() => setSettingsOpen(true)}><SettingsIcon fontSize="small" /></IconButton>
        </Stack>
        <List dense sx={{ overflowY: 'auto' }}>
          {rooms.map((r) => (
            <ListItemButton key={r.name} selected={r.name === currentRoom} onClick={() => switchRoom(r.name)}>
              <ListItemText primary={r.name} secondary={`${r.userCount ?? 0} online`} />
            </ListItemButton>
          ))}
        </List>
      </Box>

      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {error && <Chip size="small" color="error" label={error} onDelete={() => setError(null)} sx={{ m: 1, alignSelf: 'flex-start' }} />}
        <Box ref={scrollRef} sx={{ flexGrow: 1, overflowY: 'auto', p: 2 }}>
          {!currentRoom && <Typography color="text.secondary">Select a room to join the conversation.</Typography>}
          {messages.map((m, i) => (
            <Box key={m.id || i} sx={{ mb: 0.75 }}>
              {m.kind === 'system' ? (
                <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>{m.text}</Typography>
              ) : (
                <Typography variant="body2">
                  <Typography component="span" variant="body2" sx={{ fontWeight: 700, color: 'primary.main' }}>{m.from}: </Typography>
                  {m.text}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
        <Stack direction="row" spacing={1} sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>
          <TextField
            size="small" fullWidth placeholder={currentRoom ? `Message #${currentRoom}` : 'Select a room first'}
            value={input} disabled={!currentRoom}
            onChange={(e) => { setInput(e.target.value); window.nexdigi.chatSendTyping(true); }}
            onBlur={() => window.nexdigi.chatSendTyping(false)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          <IconButton color="primary" disabled={!currentRoom || !input.trim()} onClick={send}><SendIcon /></IconButton>
        </Stack>
      </Box>

      <Box sx={{ width: 180, borderLeft: 1, borderColor: 'divider', overflowY: 'auto' }}>
        <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>Users</Typography>
        <List dense>
          {users.map((u) => (
            <ListItemText key={u.callsign || u} sx={{ pl: 1 }} primary={u.callsign || u} />
          ))}
        </List>
      </Box>

      <NexDigiServerSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={boot} />
      <CreateRoomDialog open={createRoomOpen} onClose={() => setCreateRoomOpen(false)} onCreated={refreshRooms} />
    </Box>
  );
}
