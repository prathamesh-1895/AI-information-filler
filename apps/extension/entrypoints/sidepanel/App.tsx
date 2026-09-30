import { APP_NAME } from '@/src/app-info';

export function App() {
  return (
    <main className="min-h-screen bg-white p-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <h1 className="text-lg font-semibold">{APP_NAME}</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400" data-testid="status">
        Not configured yet.
      </p>
    </main>
  );
}
