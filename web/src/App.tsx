import { useEffect, useState } from 'react';
import { api } from './api';
import Home from './pages/Home';
import Previews from './pages/Previews';
import ReviewDetail from './pages/ReviewDetail';
import TicketView from './pages/TicketView';
import { Link, usePath } from './router';
import type { Health } from './types';

export default function App() {
  const path = usePath();
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const review = /^\/review\/(\d+)$/.exec(path);
  // Ticket keys are not always ABC-123: a GitHub issue key looks like
  // owner/repo#610, so the segment is decoded rather than pattern-matched.
  const ticket = /^\/ticket\/(.+)$/.exec(path);
  const previews = path === '/previews';
  const previewsOn = health?.previews?.enabled ?? false;
  const previewsRunning = health?.previews?.running ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Code<span> Review</span>
        </Link>
        <nav className="topnav">
          <Link to="/" className={!review && !ticket && !previews ? 'navlink current' : 'navlink'}>
            Reviews
          </Link>
          {previewsOn && (
            <Link to="/previews" className={previews ? 'navlink current' : 'navlink'}>
              Previews
              {previewsRunning > 0 && <span className="nav-count mono">{previewsRunning}</span>}
            </Link>
          )}
        </nav>
        <div className="topbar-meta mono">
          {health ? (
            <>
              <span className={health.trackers.length > 0 ? 'ok' : 'muted'}>
                {health.trackers.length > 0 ? health.trackers.join(' ') : 'no tracker'}
              </span>
              <span className="muted">{health.dockerImage}</span>
              <span className="muted">v{health.version}</span>
            </>
          ) : (
            <span className="warn">api offline</span>
          )}
        </div>
      </header>
      <main className="content">
        {previews ? (
          <Previews />
        ) : review ? (
          <ReviewDetail id={Number(review[1])} />
        ) : ticket ? (
          <TicketView ticketKey={decodeTicketKey(ticket[1]!)} />
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}

/** Only ABC-123 style keys are case-insensitive; anything else is used verbatim. */
function decodeTicketKey(raw: string): string {
  let key = raw;
  try {
    key = decodeURIComponent(raw);
  } catch {
    // A malformed escape stays as typed rather than blanking the page.
  }
  return /^[A-Za-z]+-\d+$/.test(key) ? key.toUpperCase() : key;
}
