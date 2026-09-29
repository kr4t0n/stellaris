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
