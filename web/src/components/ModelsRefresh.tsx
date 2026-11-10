import { useState } from 'react';
import { api } from '../api';
import type { ReviewersPayload } from '../types';
import { Icon, IconButton } from './ui';

/**
 * A small button next to the reviewer and model pickers: asks the server to
 * discover every model list again and hands the fresh payload back.
 */
export function ModelsRefresh({
  onRefreshed,
  size = 'md',
}: {
  onRefreshed: (payload: ReviewersPayload) => void;
  size?: 'md' | 'sm';
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const refresh = async (): Promise<void> => {
    setBusy(true);
    setFailed(null);
    try {
      onRefreshed(await api.reviewers(true));
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <IconButton
      label="Refresh models"
      title={failed ? `Refresh models (last try failed: ${failed})` : 'Refresh models: ask every reviewer CLI again'}
      size={size}
      disabled={busy}
      aria-busy={busy}
      onClick={() => void refresh()}
    >
      <Icon name="rerun" />
    </IconButton>
  );
}
