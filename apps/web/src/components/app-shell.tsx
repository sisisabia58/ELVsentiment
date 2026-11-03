"use client";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-stone-900">
      <header className="border-b px-4 py-3">
        <p className="text-sm font-semibold">Pemantau sentimen merek</p>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">{children}</main>
    </div>
  );
}
