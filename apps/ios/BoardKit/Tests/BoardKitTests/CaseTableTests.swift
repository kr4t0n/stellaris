import Foundation
import Testing

@testable import BoardKit

/// The ports run the case tables the web's own `staleKeys`, `needsYou`, `postedLine`, `withTitles`,
/// link, `mentionAt`, `firstParagraph`, and `describeCharter` tests run.
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
}
