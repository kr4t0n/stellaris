import Foundation
import Testing

@testable import BoardKit

/// The ports run the case tables the web's own `staleKeys`, `needsYou`, `postedLine`, `withTitles`,
/// link, `mentionAt`, upload placeholder, `firstParagraph`, `describeCharter`, and file tests run,
/// and the one `withoutMetadata` in `shared` runs.
@Suite struct CaseTableTests {
  struct StaleKeysCase: Decodable {
    let event: BoardEvent
    let keys: [ReadKey]
  }

  struct NeedsYouCase: Decodable {
    let name: String
    let proposals: [Proposal]
    let tasks: [BoardTask]
    let requests: [UserRequest]
    let expected: [Item]
  }

  /// An item of `needsYou` as the table writes it.
  struct Item: Decodable, Equatable {
    let kind: String
    let id: String
    let stage: String?
    let thread: String?
    let since: String
  }

  struct PostedLineCase: Decodable {
    let name: String
    let tool: String
    let input: JSONValue
    let line: String?
  }

  @Test func postedLineAgreesWithTheWeb() throws {
    let cases = try Fixture.table("posted-line", as: [PostedLineCase].self)
    #expect(cases.count > 10)
    for each in cases {
      #expect(postedLine(name: each.tool, input: each.input) == each.line, "\(each.name)")
    }
  }

  struct TitlesCase: Decodable {
    let name: String
    let text: String
    let titles: [String: String]
    let messages: [MessageRef]?
    let threads: [String: String]?
    let line: String

    /// The index the web's test builds: the messages, then the threads, then the tasks, each later
    /// one winning, with the user named "you".
    var index: [String: EntityTitle] {
      var index = messageTitles(
        messages ?? [], threadTitles: threads ?? [:], name: { $0 == "user" ? "you" : $0 })
      for (id, title) in threads ?? [:] {
        index[id] = EntityTitle(kind: .thread, title: title)
      }
      for (id, title) in titles {
        index[id] = EntityTitle(kind: .task, title: title)
      }
      return index
    }
  }

  @Test func withTitlesAgreesWithTheWeb() throws {
    let cases = try Fixture.table("with-titles", as: [TitlesCase].self)
    #expect(cases.count > 20)
    #expect(cases.contains { $0.messages != nil })
    for each in cases {
      #expect(withTitles(each.text, index: each.index) == each.line, "\(each.name)")
    }
  }

  /// A link's case as the web's `Markdown` test writes what it reads: the address its filter keeps,
  /// the entity `entityOfHref` gives, and the target `linkTarget` gives, each as the web spells it.
  struct LinkCase: Decodable {
    struct Source: Decodable {
      let kind: String
      let taskId: String?
      let slug: String?

      var source: FileSource? {
        switch kind {
        case "task": taskId.map(FileSource.task)
        case "project": slug.map(FileSource.project)
        default: nil
        }
      }
    }

    struct Base: Decodable {
      let source: Source
      let dir: String
    }

    struct Place: Decodable {
      let channel: String
      let thread: String?
    }

    struct Entity: Decodable {
      let kind: EntityKind
      let id: String
      let place: Place?
    }

    struct Target: Decodable {
      let kind: String
      let source: Source?
      let path: String?
      let line: Int?
      let id: String?
    }

    let name: String
    let href: String
    let base: Base?
    let kept: String
    let entity: Entity?
    let target: Target?

    var expectedEntity: EntityLink? {
      entity.map {
        EntityLink(kind: $0.kind, id: $0.id, channel: $0.place?.channel, thread: $0.place?.thread)
      }
    }

    var expectedTarget: LinkTarget? {
      guard let target else {
        return nil
      }
      switch target.kind {
      case "file":
        return target.source?.source.map {
          .file(source: $0, path: target.path ?? "", line: target.line)
        }
      case "upload":
        return target.id.map(LinkTarget.upload)
      default:
        return .local
      }
    }
  }

  @Test func linksAgreeWithTheWeb() throws {
    let cases = try Fixture.table("links", as: [LinkCase].self)
    #expect(cases.count > 30)
    for each in cases {
      let base = each.base.flatMap { base in
        base.source.source.map { FileBase(source: $0, dir: base.dir) }
      }
      #expect(keptHref(each.href) == each.kept, "\(each.name)")
      #expect(entityOfHref(each.href) == each.expectedEntity, "\(each.name)")
      #expect(linkTarget(each.href, base: base) == each.expectedTarget, "\(each.name)")
    }
  }

  @Test func staleKeysAgreesWithTheWeb() throws {
    let cases = try Fixture.table("stale-keys", as: [StaleKeysCase].self)
    #expect(cases.count > 60)
    for each in cases {
      #expect(staleKeys(for: each.event) == each.keys, "\(each.event.type)")
    }
  }

  @Test func anEventTypeTheClientDoesNotKnowTouchesNothing() throws {
    let cases = try Fixture.table("stale-keys", as: [StaleKeysCase].self)
    let known = try #require(cases.first).event
    let unknown = BoardEvent(
      id: known.id, ts: known.ts, type: "garden.watered", actor: known.actor, payload: [:])
    #expect(staleKeys(for: unknown).isEmpty)
  }

  @Test func needsYouAgreesWithTheWeb() throws {
    let cases = try Fixture.table("needs-you", as: [NeedsYouCase].self)
    #expect(cases.count > 10)
    for each in cases {
      let items = needsYou(proposals: each.proposals, tasks: each.tasks, requests: each.requests)
        .map { item -> Item in
          switch item {
          case .proposal(let proposal, let since):
            Item(kind: "proposal", id: proposal.id, stage: nil, thread: nil, since: since)
          case .stage(let task, let stage, let since):
            Item(kind: "stage", id: task.id, stage: stage.id, thread: nil, since: since)
          case .request(let message, let thread, let since):
            Item(kind: "request", id: message.id, stage: nil, thread: thread?.id, since: since)
          }
        }
      #expect(items == each.expected, "\(each.name)")
    }
  }

  struct ComposeCase: Decodable {
    struct Completed: Decodable {
      let name: String
      let text: String
      let caret: Int
    }

    let name: String
    let text: String
    let caret: Int
    let mention: MentionFragment?
    let completed: Completed?
  }

  @Test func mentionsAgreeWithTheWeb() throws {
    let cases = try Fixture.table("compose", as: [ComposeCase].self)
    #expect(cases.count > 10)
    for each in cases {
      let mention = mentionAt(each.text, caret: each.caret)
      #expect(mention == each.mention, "\(each.name)")
      if let completed = each.completed, let mention {
        let done = completeMention(
          each.text, caret: each.caret, start: mention.start, name: completed.name)
        #expect(
          done == CompletedMention(text: completed.text, caret: completed.caret), "\(each.name)")
      }
    }
  }

  struct UploadCases: Decodable {
    struct Placeholder: Decodable {
      let name: String
      let file: String
      let placeholder: String
    }

    struct Insert: Decodable {
      let name: String
      let text: String
      let start: Int
      let end: Int
      let inserted: String
      let result: DraftEdit
    }

    struct Settle: Decodable {
      let name: String
      let text: String
      let caret: Int
      let placeholder: String
      let markdown: String
      let result: DraftEdit?
    }

    struct Numbered: Decodable {
      let name: String
      let file: String
      let text: String
      let held: [String]
      let placeholder: String
    }

    struct Draft: Decodable {
      let name: String
      let text: String
      let held: [String]
      let images: [DraftImage]
    }

    struct Removal: Decodable {
      let name: String
      let text: String
      let caret: Int
      let image: DraftImage
      let result: DraftEdit
    }

    let placeholders: [Placeholder]
    let inserts: [Insert]
    let settles: [Settle]
    let numbered: [Numbered]
    let drafts: [Draft]
    let removals: [Removal]
  }

  @Test func uploadsHoldTheirPlaceAsOnTheWeb() throws {
    let cases = try Fixture.table("uploads", as: UploadCases.self)
    #expect(cases.settles.count > 5)
    for each in cases.placeholders {
      #expect(uploadingImage(each.file) == each.placeholder, "\(each.name)")
    }
    for each in cases.inserts {
      let done = insertAt(each.text, start: each.start, end: each.end, inserted: each.inserted)
      #expect(done == each.result, "\(each.name)")
    }
    for each in cases.drafts {
      #expect(draftImages(each.text, held: each.held) == each.images, "\(each.name)")
    }
    for each in cases.removals {
      #expect(
        removeDraftImage(each.text, caret: each.caret, image: each.image) == each.result,
        "\(each.name)")
    }
    for each in cases.numbered {
      #expect(
        uploadPlaceholder(for: each.file, in: each.text, held: each.held) == each.placeholder,
        "\(each.name)")
    }
    for each in cases.settles {
      let settled = settleUpload(
        each.text, caret: each.caret, placeholder: each.placeholder, markdown: each.markdown)
      #expect(settled == each.result, "\(each.name)")
    }
  }

  /// A draft saved with an upload's line, as when the app ended mid-upload, loads without it; the
  /// rest of the draft, an image kept included, stays.
  @Test func aSavedDraftDropsTheLinesNoUploadHolds() {
    let kept = "![shot.png](image:01ARZ3NDEKTSV4RRFFQ69G5FAV)"
    #expect(
      droppingUploadLines(
        "See ![Uploading image…]()\n![Uploading image (2)…]() and \(kept) then")
        == "See \n and \(kept) then")
    #expect(droppingUploadLines("![Uploading image…](not empty) words") == "![Uploading image…](not empty) words")
    #expect(droppingUploadLines("No images.") == "No images.")
  }

  struct CharterCase: Decodable {
    let name: String
    let kind: OrUnknown<Proposal.Kind>
    let charter: [String: JSONValue]
    let line: String
    let title: String
  }

  struct ParagraphCase: Decodable {
    let name: String
    let markdown: String
    let limit: Int?
    let paragraph: String
  }

  @Test func firstParagraphAgreesWithTheWeb() throws {
    let cases = try Fixture.table("first-paragraph", as: [ParagraphCase].self)
    #expect(cases.count > 10)
    for each in cases {
      let paragraph =
        each.limit.map { firstParagraph(each.markdown, limit: $0) } ?? firstParagraph(each.markdown)
      #expect(paragraph == each.paragraph, "\(each.name)")
    }
  }

  @Test func describeCharterAgreesWithTheWeb() throws {
    let cases = try Fixture.table("describe-charter", as: [CharterCase].self)
    #expect(cases.count > 40)
    for each in cases {
      let proposal = try JSONDecoder().decode(
        Proposal.self,
        from: JSONEncoder().encode(
          [
            "id": .string("01M5A0000000000000000000PA"), "kind": .string(each.kind.rawValue),
            "proposedBy": .string("concierge-1"), "status": .string("proposed"),
            "createdAt": .string("2026-10-26T10:00:00.000Z"), "charter": .object(each.charter),
            "body": .string(""),
          ] as [String: JSONValue]))
      #expect(describeCharter(each.kind, each.charter) == each.line, "\(each.name)")
      #expect(proposalTitle(proposal) == each.title, "\(each.name)")
    }
  }

  /// An image and what the board keeps of it, both in base64, or nil when it keeps none.
  struct ImageMetadataCase: Decodable {
    let name: String
    let image: String
    let kept: String?
  }

  @Test func withoutMetadataAgreesWithTheBoard() throws {
    let cases = try Fixture.table("image-metadata", as: [ImageMetadataCase].self)
    #expect(cases.count > 40)
    for each in cases {
      let image = try #require(Data(base64Encoded: each.image), "\(each.name)")
      let kept = try each.kept.map { try #require(Data(base64Encoded: $0), "\(each.name)") }
      #expect(withoutMetadata(image) == kept, "\(each.name)")
    }
  }

  struct FileCases: Decodable {
    struct Entry: Decodable {
      let name: String
      let kind: String
    }
    struct Order: Decodable {
      let name: String
      let entries: [Entry]
      let ordered: [String]
    }
    struct Size: Decodable {
      let bytes: Int
      let label: String
    }
    struct Shown: Decodable {
      let kind: String
      let text: String?
      let type: String?
      let rows: [[String]]?
    }
    struct View: Decodable {
      let name: String
      let path: String
      let base64: String
      let view: Shown
    }
    struct Delimited: Decodable {
      let name: String
      let text: String
      let separator: String
      let rows: [[String]]
    }
    struct Lines: Decodable {
      let name: String
      let text: String
      let lines: [String]
    }
    struct Parent: Decodable {
      let path: String
      let parent: String
    }
    struct Runner: Decodable {
      struct Project: Decodable {
        let runner: String?
        let name: String
      }
      let project: Project?
      let words: String
    }
    struct Limits: Decodable {
      let tableRows: Int
      let numberedLines: Int
      let fileBytes: Int
    }
    let orders: [Order]
    let sizes: [Size]
    let views: [View]
    let delimited: [Delimited]
    let lines: [Lines]
    let parents: [Parent]
    let runners: [Runner]
    let limits: Limits
  }

  /// Text as the web compares it, by UTF-16 code units: Swift's `==` takes a decomposed accent for
  /// the composed one, and would pass an order the web doesn't give.
  private func units(_ texts: [String]) -> [[UInt16]] {
    texts.map { Array($0.utf16) }
  }

  @Test func filesAgreeWithTheWeb() throws {
    let cases = try Fixture.table("files", as: FileCases.self)
    #expect(cases.orders.count > 5 && cases.views.count > 20 && cases.delimited.count > 10)
    for each in cases.orders {
      let entries = each.entries.map {
        BranchEntry(name: $0.name, kind: OrUnknown(rawValue: $0.kind))
      }
      let ordered = entriesInOrder(entries).map { "\($0.kind.rawValue):\($0.name)" }
      #expect(units(ordered) == units(each.ordered), "\(each.name)")
    }
    for each in cases.sizes {
      #expect(sizeLabel(each.bytes) == each.label, "\(each.bytes)")
    }
    for each in cases.views {
      let data = try #require(Data(base64Encoded: each.base64), "\(each.name)")
      let shown: FileView? =
        switch each.view.kind {
        case "markdown": each.view.text.map(FileView.markdown)
        case "image": each.view.type.map(FileView.image)
        case "table": each.view.rows.map(FileView.table)
        case "text": each.view.text.map(FileView.text)
        case "binary": .binary
        default: nil
        }
      let view = viewOf(each.path, data)
      #expect(view == shown, "\(each.name)")
      if case .text(let text) = view, let expected = each.view.text {
        #expect(units([text]) == units([expected]), "\(each.name)")
      }
    }
    for each in cases.delimited {
      let separator = try #require(each.separator.unicodeScalars.first)
      let rows = parseDelimited(each.text, separator: separator)
      #expect(rows.map(units) == each.rows.map(units), "\(each.name)")
    }
    for each in cases.lines {
      #expect(units(fileLines(each.text)) == units(each.lines), "\(each.name)")
    }
    for each in cases.parents {
      #expect(parentOf(each.path) == each.parent, "\(each.path)")
    }
    for each in cases.runners {
      #expect(runnerOf(runner: each.project?.runner, name: each.project?.name) == each.words)
    }
    #expect(cases.limits.tableRows == fileTableRows)
    #expect(cases.limits.numberedLines == fileNumberedLines)
    #expect(cases.limits.fileBytes == branchFileLimitBytes)
  }
}
