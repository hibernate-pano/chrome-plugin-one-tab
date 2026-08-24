import React, { useEffect, useState } from 'react';
import { LoginPage } from './LoginPage';
import { DashboardPage } from './DashboardPage';
import { getCurrentUser } from './webApi';

export const App: React.FC = () => {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const user = await getCurrentUser();
        if (active) setAuthenticated(Boolean(user));
      } catch {
        if (active) setAuthenticated(false);
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">加载中...</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <LoginPage onSuccess={() => setAuthenticated(true)} />
      </div>
    );
  }

  return <DashboardPage onSignOut={() => setAuthenticated(false)} />;
};
