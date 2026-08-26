import React from 'react';
import { Box, List, ListItemButton, ListItemText, Typography, Chip } from '@mui/material';

// Generic message list, shared between the Winlink and BBS mail panes —
// they have different backing APIs but the same "list of subject/from/date
// rows, click to read" shape.
export default function MessageList({ messages, selectedId, onSelect, getId, getSubject, getFrom, getDate, getUnread }) {
  if (!messages || messages.length === 0) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography color="text.secondary">No messages.</Typography>
      </Box>
    );
  }
  return (
    <List dense disablePadding sx={{ overflowY: 'auto', height: '100%' }}>
      {messages.map((m) => {
        const id = getId(m);
        const unread = getUnread ? getUnread(m) : false;
        return (
          <ListItemButton key={id} selected={id === selectedId} onClick={() => onSelect(m)} sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <ListItemText
              primary={
                <Typography variant="body2" sx={{ fontWeight: unread ? 700 : 400 }}>
                  {getSubject(m) || '(no subject)'}
                </Typography>
              }
              secondary={
                <Typography variant="caption" color="text.secondary">
                  {getFrom(m)} · {getDate(m)}
                </Typography>
              }
            />
            {unread && <Chip size="small" label="new" color="primary" sx={{ ml: 1 }} />}
          </ListItemButton>
        );
      })}
    </List>
  );
}
