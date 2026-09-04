import React, { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack } from '@mui/material';

export default function ComposeDialog({ open, onClose, onSend, showCc = false, initialTo = '', initialCc = '', initialSubject = '', initialBody = '', subjectHelperText = null, subjectDisabled = false }) {
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open) { setTo(initialTo); setCc(initialCc); setSubject(initialSubject); setBody(initialBody); }
  }, [open, initialTo, initialCc, initialSubject, initialBody]);

  const submit = async () => {
    setSending(true);
    try {
      await onSend({ to: to.trim(), cc: cc.trim(), subject: subject.trim(), body });
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New message</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="To" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
          {showCc && <TextField label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} />}
          <TextField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={subjectDisabled} helperText={subjectHelperText} />
          <TextField label="Message" value={body} onChange={(e) => setBody(e.target.value)} multiline minRows={8} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!to.trim() || sending} onClick={submit}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
