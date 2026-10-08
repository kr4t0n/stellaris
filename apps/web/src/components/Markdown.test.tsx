import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.js";

describe("Markdown", () => {
  it("highlights mentions in text, but not in code, links, or addresses", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={"@ada please look, and @ref too. `@not-code` [@not-link](https://x.y) a@b.c"}
      />,
    );
    expect(html).toContain('<span class="mention">@ada</span>');
    expect(html).toContain('<span class="mention">@ref</span>');
    expect(html).toContain("<code>@not-code</code>");
    expect(html).not.toContain('<span class="mention">@not-link</span>');
    expect(html).not.toContain('<span class="mention">@b</span>');
  });

  it("reads a path on a runner's machine as text, never as a link to the board's own address", () => {
    const html = renderToStaticMarkup(
      <Markdown text="[notes](/tmp/notes.md), ![the plot](/tmp/plot.png), [web](https://x.y)" />,
    );
    expect(html).not.toContain('href="/tmp/notes.md"');
    expect(html).toContain('title="/tmp/notes.md, on a runner');
    expect(html).toContain(">notes</span>");
    expect(html).not.toContain("<img");
    expect(html).toContain(">the plot</span>");
    expect(html).toContain('href="https://x.y"');
  });

  it("never renders raw HTML or script URLs from a message", () => {
    const html = renderToStaticMarkup(
      <Markdown text={'<script>alert(1)</script> <img src=x onerror="alert(1)">'} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    const link = renderToStaticMarkup(<Markdown text="[x](javascript:alert(1))" />);
    expect(link).not.toContain('href="javascript:');
  });
});
