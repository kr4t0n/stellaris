import BoardKit
import SwiftUI

/// A channel's or a thread's messages, newest at the foot, with its draft below. The view opens
/// where the user left it: at the message its scroll was anchored at, or at the newest.
struct ConversationView: View {
  @Environment(AppModel.self) private var model
  let feed: ConversationFeed

  var body: some View {
    Group {
      if feed.messages.isEmpty {
        ScrollView {
          header
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.vertical, 12)
        }
        .accessibilityIdentifier("messages")
        .overlay { state }
      } else {
        // Built once the messages are there, so it opens at its anchor rather than laying out
        // empty first and staying at the top.
        MessageList(
          feed: feed, header: header, start: model.memory?.anchor(feed.conversation))
      }
    }
    .scrollDismissesKeyboard(.immediately)
    .safeAreaInset(edge: .bottom) {
      DraftField(conversation: feed.conversation)
    }
    .refreshable { await feed.load(using: model) }
    .task {
      if feed.state != .loaded {
        await feed.load(using: model)
      }
    }
  }

  /// The view's title, as the first line of its content, since a vertical bar has no room for one.
  private var header: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(model.name(of: feed.conversation))
        .font(.title2.bold())
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("conversation-title")
      if let place {
        Text(place)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.bottom, 4)
  }

  /// Where the conversation is: a project's name for its channel, and the channel, with its
  /// project's name, for a thread.
  private var place: String? {
    switch feed.conversation {
    case .channel(let ref):
      return project(of: ref)
    case .thread:
      guard let channel = feed.thread?.channel else {
        return nil
      }
      let name = model.name(of: .channel(channel))
      return project(of: channel).map { "\($0) · \(name)" } ?? name
    }
  }

  private func project(of channel: String) -> String? {
    let parts = channel.split(separator: "/")
    return parts.count > 1 ? model.store.projectName(String(parts[0])) : nil
  }

  @ViewBuilder private var state: some View {
    switch feed.state {
    case .idle, .loading:
      if feed.messages.isEmpty {
        ProgressView()
      }
    case .loaded:
      if feed.messages.isEmpty {
        // Drags pass through to the conversation, to pull it to refresh.
        ContentUnavailableView("No messages", systemImage: "bubble.left")
          .allowsHitTesting(false)
      }
    case .failed(let reason):
      if feed.messages.isEmpty {
        ContentUnavailableView {
          Label(reason, systemImage: "wifi.exclamationmark")
        } actions: {
          Button("Retry") {
            Task { await feed.load(using: model) }
          }
        }
      }
    }
  }
}

/// The messages, opened at `start` when it is one of them, else at the newest, and keeping the
/// message at the foot of the view as the conversation's anchor once the user scrolls. A stack
/// that measures every row, not a lazy one: a conversation runs to a few hundred messages, and a
/// lazy stack's estimated rows left the list short of where it was sent.
private struct MessageList<Header: View>: View {
  @Environment(AppModel.self) private var model
  let feed: ConversationFeed
  let header: Header
  /// Where the list opens.
  let start: String?
  /// The message at the foot of the view.
  @State private var anchor: String?
  /// Whether the user has scrolled since the list opened.
  @State private var moved = false

  init(feed: ConversationFeed, header: Header, start: String?) {
    self.feed = feed
    self.header = header
    let ids = feed.messages.map(\.id)
    self.start = start.flatMap { ids.contains($0) ? $0 : nil } ?? ids.last
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          header
          ForEach(feed.messages) { message in
            MessageRow(message: message)
          }
        }
        .scrollTargetLayout()
        .padding(.horizontal)
        .padding(.vertical, 12)
      }
      .scrollPosition(id: $anchor, anchor: .bottom)
      .defaultScrollAnchor(.bottom)
      .accessibilityIdentifier("messages")
      // Until the user scrolls, the list holds to where it opens whenever it appears or its
      // content's height changes, as when a rotation rewraps it.
      .onAppear { hold(proxy) }
      .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
        hold(proxy)
      }
      .onScrollPhaseChange { _, phase in
        if phase == .tracking || phase == .interacting {
          moved = true
        }
      }
      .onChange(of: anchor) { _, id in
        if moved, let id {
          model.memory?.setAnchor(id, for: feed.conversation)
        }
      }
    }
  }

  private func hold(_ proxy: ScrollViewProxy) {
    guard !moved, let start else {
      return
    }
    anchor = start
    proxy.scrollTo(start, anchor: .bottom)
  }
}

/// One message: who wrote it, when, and its text. Markdown, images, and links render from a later
/// change; here the text shows as written.
struct MessageRow: View {
  let message: Message

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(message.author)
          .font(.subheadline.bold())
        Text(BoardTime.text(message.ts))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Text(message.body)
        .font(.body)
        .textSelection(.enabled)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("message-\(message.id)")
  }
}

/// The draft of the conversation's next message, kept by conversation as it is typed.
struct DraftField: View {
  @Environment(AppModel.self) private var model
  let conversation: Conversation

  var body: some View {
    let draft = Binding(
      get: { model.memory?.draft(conversation) ?? "" },
      set: { model.memory?.setDraft($0, for: conversation) })
    TextField("Message", text: draft, axis: .vertical)
      .lineLimit(1...5)
      .textFieldStyle(.roundedBorder)
      .accessibilityIdentifier("draft")
      .padding(.horizontal)
      .padding(.vertical, 8)
      .background(.bar)
  }
}

/// A time the board sent, as the user's own clock reads it.
enum BoardTime {
  static func date(_ iso: String) -> Date? {
    (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso))
      ?? (try? Date.ISO8601FormatStyle().parse(iso))
  }

  static func text(_ iso: String) -> String {
    date(iso)?.formatted(date: .abbreviated, time: .shortened) ?? iso
  }

  /// How long ago, as "3 hours ago".
  static func ago(_ iso: String) -> String {
    guard let date = date(iso) else {
      return iso
    }
    return date.formatted(.relative(presentation: .named, unitsStyle: .wide))
  }
}
