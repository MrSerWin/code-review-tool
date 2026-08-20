import { useEffect, useState } from 'react';
import { api } from './api';
import Home from './pages/Home';
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
  const ticket = /^\/ticket\/([A-Za-z]+-\d+)$/.exec(path);

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Code<span> Review</span>
        </Link>
        <div className="topbar-meta mono">
          {health ? (
            <>
              <span className={health.linear ? 'ok' : 'warn'}>linear</span>
              <span className="muted">{health.dockerImage}</span>
              <span className="muted">v{health.version}</span>
            </>
          ) : (
            <span className="warn">api offline</span>
          )}
        </div>
      </header>
      <main className="content">
        {review ? (
          <ReviewDetail id={Number(review[1])} />
        ) : ticket ? (
          <TicketView ticketKey={ticket[1]!.toUpperCase()} />
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}
