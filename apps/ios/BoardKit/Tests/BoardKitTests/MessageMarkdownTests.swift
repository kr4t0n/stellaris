import Testing

@testable import BoardKit

/// A message's markdown read as the web's `Markdown` component reads it.
@Suite struct MessageMarkdownTests {
  static let task = "01M5A00000000000000000T001"
  static let proposal = "01M5A00000000000000000P001"
  static let image = "01M5A00000000000000000G001"
  static let entities = [
    task: EntityTitle(kind: .task, title: "Add the export view"),
    proposal: EntityTitle(kind: .proposal, title: "Hire eng-2"),
  ]

  /// The inline content of the document's only block.
  private func inlines(
    _ markdown: String, entities: [String: EntityTitle] = [:]
  ) -> [MessageInline] {
    let document = MessageDocument(markdown: markdown, entities: entities)
    guard document.blocks.count == 1, case .paragraph(let inlines) = document.blocks[0] else {
      Issue.record("not one paragraph: \(document.blocks)")
      return []
    }
    return inlines
  }

  private func runs(_ markdown: String, entities: [String: EntityTitle] = [:]) -> [MessageRun] {
    inlines(markdown, entities: entities).compactMap { inline in
      if case .run(let run) = inline {
        return run
      }
      return nil
    }
  }

  /// Every name a document marks as a mention, in its blocks at any depth.
  private func mentions(_ markdown: String) -> [String] {
    func inBlocks(_ blocks: [MessageBlock]) -> [String] {
      blocks.flatMap { block -> [String] in
        switch block {
        case .paragraph(let inlines), .heading(_, let inlines): inInlines(inlines)
        case .list(_, let items): items.flatMap { inBlocks($0.blocks) }
        case .quote(let blocks): inBlocks(blocks)
        case .table(let table): (table.head + table.rows.flatMap { $0 }).flatMap(inInlines)
        case .code, .rule: []
        }
      }
    }
    func inInlines(_ inlines: [MessageInline]) -> [String] {
      inlines.compactMap { inline in
        if case .run(let run) = inline, run.kind == .mention {
          return String(run.text.dropFirst())
        }
        return nil
      }
    }
    return Array(Set(inBlocks(MessageDocument(markdown: markdown).blocks))).sorted()
  }

  // MARK: Blocks

  @Test func readsEachKindOfBlock() {
    let markdown = """
      ## Findings

      First paragraph.

      - one
      - two
        - nested

      3. three
      4. four

      - [ ] open
      - [x] done

      > quoted

      ```swift
      let x = 1
      ```

      | Name | Count |
      |:-----|------:|
      | a    | 1     |

      ---
      """
    let blocks = MessageDocument(markdown: markdown).blocks
    #expect(blocks.count == 9)
    #expect(blocks[0] == .heading(level: 2, [.run(MessageRun("Findings"))]))
    #expect(blocks[1] == .paragraph([.run(MessageRun("First paragraph."))]))
    guard case .list(nil, let bullets) = blocks[2] else {
      Issue.record("not a bulleted list: \(blocks[2])")
      return
    }
    #expect(bullets.count == 2)
    #expect(bullets[1].blocks.count == 2)
    #expect(
      bullets[1].blocks[1]
        == .list(
          start: nil,
          items: [MessageListItem(checked: nil, blocks: [.paragraph([.run(MessageRun("nested"))])])]
        ))
    guard case .list(3, let numbered) = blocks[3] else {
      Issue.record("not a list from 3: \(blocks[3])")
      return
    }
    #expect(numbered.count == 2)
    guard case .list(nil, let tasks) = blocks[4] else {
      Issue.record("not a task list: \(blocks[4])")
      return
    }
    #expect(tasks.map(\.checked) == [false, true])
    #expect(blocks[5] == .quote([.paragraph([.run(MessageRun("quoted"))])]))
    #expect(blocks[6] == .code(language: "swift", text: "let x = 1"))
    #expect(
      blocks[7]
        == .table(
          MessageTable(
            alignments: [.leading, .trailing],
            head: [[.run(MessageRun("Name"))], [.run(MessageRun("Count"))]],
            rows: [[[.run(MessageRun("a"))], [.run(MessageRun("1"))]]])))
    #expect(blocks[8] == .rule)
  }

  @Test func keepsACodeBlockAsWritten() {
    let code = "  indented\n\nlong line with *stars* and @ada and \(Self.task)"
    #expect(
      MessageDocument(markdown: "```\n\(code)\n```", entities: Self.entities).blocks == [
        .code(language: nil, text: code)
      ])
  }

  @Test func showsRawHTMLAsWritten() {
    #expect(
      MessageDocument(markdown: "<div>block</div>").blocks == [
        .paragraph([.run(MessageRun("<div>block</div>"))])
      ])
    let html = "a <script>alert(1)</script> b"
    #expect(runs(html).map(\.text).joined() == html)
  }

  @Test func keepsQuotesAndDashesAsWritten() {
    #expect(runs("\"quoted\" -- and --- it's").map(\.text) == ["\"quoted\" -- and --- it's"])
  }

  // MARK: Inline text

  @Test func setsEmphasisStrongStrikethroughAndCode() {
    #expect(
      runs("*em* **strong** ~~gone~~ `code` ***both***") == [
        MessageRun("em", style: .emphasis),
        MessageRun(" "),
        MessageRun("strong", style: .strong),
        MessageRun(" "),
        MessageRun("gone", style: .strikethrough),
        MessageRun(" "),
        MessageRun("code", kind: .code),
        MessageRun(" "),
        MessageRun("both", style: [.emphasis, .strong]),
      ])
  }

  @Test func readsASoftBreakAsASpaceAndKeepsAHardOne() {
    #expect(
      inlines("one\ntwo\\\nthree") == [
        .run(MessageRun("one two")), .lineBreak, .run(MessageRun("three")),
      ])
  }

  // MARK: Links

  @Test func linksToTheBoardAndTheWeb() {
    #expect(
      runs("[the task](/task/\(Self.task)) [web](https://example.com/x)") == [
        MessageRun("the task", link: .entity(EntityLink(kind: .task, id: Self.task))),
        MessageRun(" "),
        MessageRun("web", link: .web("https://example.com/x")),
      ])
    let worktree = "/data/worktrees/eng-1/.tasks/\(Self.task)/report.md:12"
    #expect(
      runs("[report](\(worktree))") == [
        MessageRun("report", link: .file(source: .task(Self.task), path: "report.md", line: 12))
      ])
  }

  @Test func readsALinkThatGoesNowhereAsText() {
    for href in ["/tmp/notes.md", "report.md:67", "image:\(Self.image)", "javascript:alert(1)"] {
      #expect(runs("[words](\(href))") == [MessageRun("words")], "\(href)")
    }
  }

  @Test func linksLiteralAddressesAsTheWebDoes() {
    #expect(
      runs("see https://example.com/x. and www.example.com, or (https://a.bc/d)") == [
        MessageRun("see "),
        MessageRun("https://example.com/x", link: .web("https://example.com/x")),
        MessageRun(". and "),
        MessageRun("www.example.com", link: .web("http://www.example.com")),
        MessageRun(", or ("),
        MessageRun("https://a.bc/d", link: .web("https://a.bc/d")),
        MessageRun(")"),
      ])
    let wiki = "https://en.wikipedia.org/wiki/Fold_(geology)"
    #expect(runs("\(wiki).") == [MessageRun(wiki, link: .web(wiki)), MessageRun(".")])
    #expect(
      runs("write to a.b+c@example.com.") == [
        MessageRun("write to "),
        MessageRun("a.b+c@example.com", link: .web("mailto:a.b+c@example.com")),
        MessageRun("."),
      ])
    for text in ["1http://a.bc", "https://localhost", "www.ex_ample.com", "path/a@b.cd", "a@b.c1"] {
      #expect(runs(text) == [MessageRun(text)], "\(text)")
    }
  }

  // MARK: Ids

  @Test func readsAKnownIdAsALinkNamedByItsTitle() {
    let link = MessageLink.entity(EntityLink(kind: .task, id: Self.task))
    #expect(
      runs("Done with \(Self.task) \"Add the export view\".", entities: Self.entities) == [
        MessageRun("Done with "),
        MessageRun("Add the export view", link: link),
        MessageRun("."),
      ])
    #expect(
      runs("See `\(Self.proposal)`.", entities: Self.entities) == [
        MessageRun("See "),
        MessageRun(
          "Hire eng-2", link: .entity(EntityLink(kind: .proposal, id: Self.proposal))),
        MessageRun("."),
      ])
    #expect(
      runs("*\(Self.task)*", entities: Self.entities) == [
        MessageRun("Add the export view", style: .emphasis, link: link)
      ])
  }

  @Test func leavesIdsInLinksCodeAndPathsAsWritten() {
    let unknown = "01M5A00000000000000000Z999"
    let text = "task/\(Self.task) `x \(Self.task)` [\(Self.task)](https://x.y) \(unknown)"
    #expect(runs(text, entities: Self.entities).allSatisfy { $0.text != "Add the export view" })
  }

  // MARK: Mentions

  @Test func marksMentionsOutsideCodeAndLinks() {
    #expect(
      runs("@ada please, and @ref-2. `@code` [@link](https://x.y) a@b.c") == [
        MessageRun("@ada", kind: .mention),
        MessageRun(" please, and "),
        MessageRun("@ref-2", kind: .mention),
        MessageRun(". "),
        MessageRun("@code", kind: .code),
        MessageRun(" "),
        MessageRun("@link", link: .web("https://x.y")),
        MessageRun(" "),
        MessageRun("a@b.c", link: .web("mailto:a@b.c")),
      ])
  }

  /// The names the web highlights, which are the names the board's `mentionsIn` counts where code
  /// alone is around them (the web's `Markdown.test.tsx`).
  @Test func marksTheNamesTheBoardCounts() {
    let cases: [(String, [String])] = [
      ("Run `@ada --fix`, then @ref", ["ref"]),
      ("``a ` @ada`` and @ref", ["ref"]),
      ("```\n@ada\n```\n\n@ref", ["ref"]),
      ("Log:\n\n~~~\n@ada\n\nstill code, @ref", []),
      ("Run:\n\n    @ada\n\nthen @ref", ["ref"]),
      ("- item\n\n      @ada\n- @ref", ["ref"]),
      ("> ```\n> @ada\n> ```\n\n@ref", ["ref"]),
      ("A lone ` opens no span, @ada", ["ada"]),
      ("`x`@ada and @ref`y`", ["ada", "ref"]),
      ("@ada@ref and *@eng-1* x_@rev-1", ["ada", "eng-1"]),
    ]
    for (text, names) in cases {
      #expect(mentions(text) == names, "\(text)")
    }
  }

  // MARK: Images

  @Test func readsWhereEachImageLoadsFrom() {
    let worktree = "/data/worktrees/eng-1/.tasks/\(Self.task)/evidence/plot.png"
    let images = inlines(
      "![The board](image:\(Self.image)) ![plot](\(worktree)) ![web](https://example.com/a.png)"
        + " ![run](/tmp/run.png) ![](/tmp/bare.png) ![x](javascript:alert(1))"
    ).compactMap { inline -> MessageImage? in
      if case .image(let image) = inline {
        return image
      }
      return nil
    }
    #expect(images.map(\.source) == [
      .upload(Self.image), .file(source: .task(Self.task), path: "evidence/plot.png"),
      .web("https://example.com/a.png"), nil, nil, nil,
    ])
    #expect(images.map(\.alt) == ["The board", "plot", "web", "run", "", "x"])
    #expect(images.map(\.text) == ["The board", "plot", "web", "run", "/tmp/bare.png", "x"])
  }

  @Test func keepsTheLinkAnImageSitsIn() {
    let inlines = inlines("[![shot](image:\(Self.image))](/task/\(Self.task))")
    #expect(
      inlines == [
        .image(
          MessageImage(
            source: .upload(Self.image), alt: "shot", text: "shot",
            link: .entity(EntityLink(kind: .task, id: Self.task))))
      ])
  }
}
