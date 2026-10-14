import { mentionsIn } from "@stellaris/shared/mentions";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.js";

/** The names a text renders highlighted as mentions. */
function highlighted(text: string): string[] {
  const html = renderToStaticMarkup(<Markdown text={text} />);
  const marked = html.matchAll(/<span class="mention">@([a-z0-9-]+)<\/span>/g);
  return [...new Set([...marked].map((match) => match[1] ?? ""))].toSorted();
}

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

  it("highlights exactly the names the board counts when only code is around them", () => {
    const texts = [
      "Run `@ada --fix`, then @ref",
      "``a ` @ada`` and @ref",
      "```\n@ada\n```\n\n@ref",
      "Log:\n\n~~~\n@ada\n\nstill code, @ref",
      "Run:\n\n    @ada\n\nthen @ref",
      "- item\n\n      @ada\n- @ref",
      "> ```\n> @ada\n> ```\n\n@ref",
      "A lone ` opens no span, @ada",
      "`x`@ada and @ref`y`",
    ];
    expect(texts.map((text) => [text, highlighted(text)])).toEqual(
      texts.map((text) => [text, mentionsIn(text)]),
    );
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

  it("marks the block a cited source line falls in", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"# Report\n\nFirst finding.\n\n- one\n- two, line six\n"} line={6} />,
    );
    expect(html).toContain('<li class="line-target">two, line six</li>');
    expect(html.match(/line-target/g)).toHaveLength(1);
  });

  it("never renders raw HTML or script URLs from a message", () => {
    const html = renderToStaticMarkup(
      <Markdown text={'<script>alert(1)</script> <img src=x onerror="alert(1)">'} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    const cited = renderToStaticMarkup(<Markdown text="[a](report.md:67) [b](javascript:1)" />);
    expect(cited).not.toContain("href");
    const link = renderToStaticMarkup(<Markdown text="[x](javascript:alert(1))" />);
    expect(link).not.toContain('href="javascript:');
  });
});
