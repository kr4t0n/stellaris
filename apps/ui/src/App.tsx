const VIEWS = [
  { title: "Inbox", detail: "Mentions and pending decisions across projects." },
  { title: "Project", detail: "Channels, tasks, threads, and the dashboard agents may edit." },
  { title: "Society", detail: "Members, roles, runners, proposals, and operations metrics." },
] as const;

export function App() {
  return (
    <main className="min-h-screen bg-board-bg p-8 text-board-text">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Stellaris board</h1>
        <p className="text-board-muted">Phase 0 scaffold. The three views arrive in Phase 3.</p>
      </header>
      <section className="grid gap-4 md:grid-cols-3">
        {VIEWS.map((view) => (
          <article
            key={view.title}
            className="rounded-lg border border-board-border bg-board-panel p-4"
          >
            <h2 className="mb-2 font-medium text-board-accent">{view.title}</h2>
            <p className="text-sm text-board-muted">{view.detail}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
