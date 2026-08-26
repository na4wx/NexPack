import { createTheme } from '@mui/material/styles';

// Shares its palette/spacing conventions with the NexDigi web client's dark
// theme (client/src/theme.js in the main NexDigi repo) so the desktop
// companion app feels like part of the same product. Dark-mode only by
// design, same as the web client.
const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#5b9bff',
      light: '#8ac2ff',
      dark: '#2f6fd1',
      contrastText: '#0a0e14'
    },
    secondary: { main: '#00c9a7' },
    background: {
      default: '#0d1117',
      paper: '#161b22'
    },
    text: {
      primary: '#e6edf3',
      secondary: '#9aa7b5'
    },
    divider: 'rgba(230, 237, 243, 0.12)',
    success: { main: '#3fb950' },
    warning: { main: '#d29922' },
    error: { main: '#f85149' },
    info: { main: '#5b9bff' }
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    button: { fontWeight: 600, textTransform: 'none' }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: '#0d1117', colorScheme: 'dark' }
      }
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: '#161b22',
          backgroundImage: 'none',
          borderBottom: '1px solid rgba(230, 237, 243, 0.08)'
        }
      }
    },
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: 'none' } },
      defaultProps: { elevation: 0 }
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid rgba(230, 237, 243, 0.08)'
        }
      },
      defaultProps: { elevation: 0 }
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundImage: 'none',
          backgroundColor: '#161b22',
          border: '1px solid rgba(230, 237, 243, 0.08)'
        }
      }
    },
    MuiButton: {
      styleOverrides: { root: { borderRadius: 8 } }
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 500 } }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        notchedOutline: { borderColor: 'rgba(230, 237, 243, 0.18)' }
      }
    },
    MuiTableCell: {
      styleOverrides: { root: { borderColor: 'rgba(230, 237, 243, 0.08)' } }
    },
    MuiDivider: {
      styleOverrides: { root: { borderColor: 'rgba(230, 237, 243, 0.12)' } }
    },
    MuiTab: {
      styleOverrides: { root: { textTransform: 'none', fontWeight: 500 } }
    }
  }
});

// Colors for the monitor pane's frame-type coding. Not part of the MUI
// palette proper since they key off protocol semantics, not UI roles.
export const frameColors = {
  ui: '#5b9bff',
  iframe: '#3fb950',
  control: '#d29922',
  digipeated: '#8ac2ff',
  error: '#f85149',
  info: '#9aa7b5'
};

export default theme;
