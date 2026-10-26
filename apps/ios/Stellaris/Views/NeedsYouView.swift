import BoardKit
import SwiftUI

/// What waits on the user, as the web lists it: proposals to decide, stages that name the user, and
/// what citizens asked, oldest first. Picking one opens its conversation in Chat.
struct NeedsYouView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let items = model.store.attention.map(AttentionItem.init)
    NavigationStack {
      List {
        ForEach(AttentionItem.Kind.allCases, id: \.self) { kind in
          let shown = items.filter { $0.kind == kind }
          if !shown.isEmpty {
            Section("\(kind.label) · \(shown.count)") {
              ForEach(shown) { item in
                AttentionRow(item: item)
              }
            }
          }
        }
      }
      .overlay {
        BoardState(state: model.store.state, empty: items.isEmpty ? "Nothing needs you" : nil)
      }
      .refreshable { await model.refresh() }
    }
  }
}

/// One thing that waits on the user, with the conversation it is decided or answered in.
struct AttentionItem: Identifiable {
  enum Kind: CaseIterable {
    case proposal, stage, request

    var label: String {
      switch self {
      case .proposal: "Proposals to decide"
      case .stage: "Stages that name you"
      case .request: "Asked of you"
      }
    }
  }

  let id: String
  let kind: Kind
  let title: String
  let meta: String
  let conversation: Conversation

  init(_ attention: Attention) {
    switch attention {
    case .proposal(let proposal, let since):
      id = "proposal-\(proposal.id)"
      kind = .proposal
      let name = proposal.charter["name"]?.string ?? proposal.charter["role"]?.string
      title = [proposal.kind.rawValue.capitalized, name].compactMap { $0 }.joined(separator: " · ")
      meta = "proposed by \(proposal.proposedBy) \(BoardTime.ago(since))"
      conversation = .thread(proposal.id)
    case .stage(let task, let stage, let since):
      id = "stage-\(task.id)"
      kind = .stage
      title = task.title
      meta = "\(stage.name)\(stage.gate ? " (gate)" : "") · waiting since \(BoardTime.ago(since))"
      conversation = .thread(task.id)
    case .request(let message, let thread, let since):
      id = "request-\(message.id)"
      kind = .request
      title = AttentionItem.firstParagraph(message.body)
      let place = thread?.title ?? "#\(message.channel)"
      meta = "\(message.author) in \(place) \(BoardTime.ago(since))"
      conversation = thread.map { .thread($0.id) } ?? .channel(message.channel)
    }
  }

  /// A message's first paragraph as plain words, as the web's `firstParagraph` gives it.
  static func firstParagraph(_ markdown: String, limit: Int = 160) -> String {
    let paragraph =
      markdown.components(separatedBy: "\n\n")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty && !$0.hasPrefix("#") } ?? ""
    let plain = paragraph.filter { !"*_`>".contains($0) }
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return plain.count <= limit ? plain : String(plain.prefix(limit - 1)) + "…"
  }
}

private struct AttentionRow: View {
  @Environment(AppModel.self) private var model
  let item: AttentionItem

  var body: some View {
    Button {
      model.open(item.conversation)
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        Text(item.title)
          .lineLimit(2)
        Text(item.meta)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
    }
    .foregroundStyle(.primary)
    .accessibilityIdentifier(item.id)
  }
}
