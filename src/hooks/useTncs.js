import { useEffect, useState, useCallback } from 'react';

export function useTncs() {
  const [tncs, setTncs] = useState([]);

  const refresh = useCallback(() => {
    window.nexdigi.listTncs().then(setTncs);
  }, []);

  useEffect(() => {
    refresh();
    const offList = window.nexdigi.onTncListChanged(refresh);
    const offStatus = window.nexdigi.onTncStatus(({ tncId, status }) => {
      setTncs((prev) => prev.map((t) => (t.id === tncId ? { ...t, status } : t)));
    });
    return () => { offList(); offStatus(); };
  }, [refresh]);

  return { tncs, refresh };
}
