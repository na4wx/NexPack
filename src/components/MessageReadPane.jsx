import React from 'react';
import { Box, Typography, Stack, IconButton, Tooltip, Divider } from '@mui/material';
import ReplyIcon from '@mui/icons-material/Reply';
import DeleteIcon from '@mui/icons-material/Delete';
import ArchiveIcon from '@mui/icons-material/Archive';

export default function MessageReadPane({ message, subject, from, to, date, body, onReply, onDelete, onArchive }) {
  if (!message) {
    return (
      <Box sx={{ p: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Typography color="text.secondary">Select a message to read.</Typography>
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h6" sx={{ wordBreak: 'break-word' }}>{subject || '(no subject)'}</Typography>
          <Typography variant="body2" color="text.secondary">From: {from}</Typography>
          {to && <Typography variant="body2" color="text.secondary">To: {to}</Typography>}
          <Typography variant="caption" color="text.secondary">{date}</Typography>
        </Box>
        <Stack direction="row" spacing={0.5}>
          {onReply && <Tooltip title="Reply"><IconButton size="small" onClick={onReply}><ReplyIcon fontSize="small" /></IconButton></Tooltip>}
          {onArchive && <Tooltip title="Archive"><IconButton size="small" onClick={onArchive}><ArchiveIcon fontSize="small" /></IconButton></Tooltip>}
          {onDelete && <Tooltip title="Delete"><IconButton size="small" color="error" onClick={onDelete}><DeleteIcon fontSize="small" /></IconButton></Tooltip>}
        </Stack>
      </Stack>
      <Divider />
      <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 2 }}>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body}</Typography>
      </Box>
    </Box>
  );
}
