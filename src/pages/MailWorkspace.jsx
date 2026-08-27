import React, { useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import WinlinkMail from './WinlinkMail';
import BbsMail from './BbsMail';

export default function MailWorkspace({ tncs }) {
  const [tab, setTab] = useState('winlink');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="winlink" label="Winlink" />
        <Tab value="bbs" label="BBS" />
      </Tabs>
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        {tab === 'winlink' && <WinlinkMail />}
        {tab === 'bbs' && <BbsMail tncs={tncs} />}
      </Box>
    </Box>
  );
}
