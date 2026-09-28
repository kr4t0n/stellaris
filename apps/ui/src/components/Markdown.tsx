import { useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidReady ??= import("mermaid").then((module) => {
    module.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    return module.default;
  });
  return mermaidReady;
}

/** The text inside a code block as react-markdown hands it over: a string, or nested strings. */
function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const render = async (): Promise<void> => {
      try {
        const mermaid = await loadMermaid();
        const result = await mermaid.render(`m${id}`, code);
        if (!cancelled) setSvg(result.svg);
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "diagram failed to render");
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [code, id]);
  if (error !== null) {
    return (
      <pre className="rounded border border-rose-800 bg-rose-950/40 p-2 text-xs text-rose-300">
        {error}
      </pre>
    );
  }
  if (svg === null) {
    return <div className="text-xs text-board-muted">Rendering diagram…</div>;
  }
  // Mermaid runs with securityLevel strict, which sanitizes the SVG it produces.
  return <div className="my-3 overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Code({ className, children }: { className?: string | undefined; children?: ReactNode }) {
  const language = /language-(\w+)/.exec(className ?? "")?.[1];
  const text = textOf(children).replace(/\n$/, "");
  if (language === "mermaid") {
    return <Mermaid code={text} />;
  }
  if (language === undefined && !text.includes("\n")) {
    return (
      <code className="rounded bg-board-bg px-1 py-0.5 text-[0.9em] text-board-accent">{text}</code>
    );
  }
  return (
    <pre className="my-3 overflow-x-auto rounded border border-board-border bg-board-bg p-3 text-xs">
      <code>{text}</code>
    </pre>
  );
}

function Pre({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function Anchor({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  return (
    <a href={href} className="text-board-accent underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function H1({ children }: { children?: ReactNode }) {
  return <h1 className="text-xl font-semibold">{children}</h1>;
}

function H2({ children }: { children?: ReactNode }) {
  return <h2 className="mt-4 text-lg font-semibold">{children}</h2>;
}

function H3({ children }: { children?: ReactNode }) {
  return <h3 className="mt-3 font-semibold">{children}</h3>;
}

function Ul({ children }: { children?: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

function Ol({ children }: { children?: ReactNode }) {
  return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
}

function Table({ children }: { children?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th className="border border-board-border px-2 py-1 text-left">{children}</th>;
}

function Td({ children }: { children?: ReactNode }) {
  return <td className="border border-board-border px-2 py-1 align-top">{children}</td>;
}

function Blockquote({ children }: { children?: ReactNode }) {
  return (
    <blockquote className="border-l-2 border-board-accent pl-3 text-board-muted">
      {children}
    </blockquote>
  );
}

const components: Components = {
  code: Code,
  pre: Pre,
  a: Anchor,
  h1: H1,
  h2: H2,
  h3: H3,
  ul: Ul,
  ol: Ol,
  table: Table,
  th: Th,
  td: Td,
  blockquote: Blockquote,
};

/** Markdown as agents write it: GitHub flavored, with fenced mermaid blocks rendered as diagrams. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
