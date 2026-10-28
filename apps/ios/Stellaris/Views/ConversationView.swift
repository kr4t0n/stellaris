import BoardKit
import SwiftUI

/// A channel's or a thread's messages, newest at the foot, with its draft below, on the web's
/// island gray. The view opens where the user left it: at the message its scroll was anchored at,
/// or at the newest. A link to a task, a proposal, a thread, or a message opens it here, and any
/// other in Safari.
struct ConversationView: View {
  @Environment(AppModel.self) private var model
  let feed: ConversationFeed
  /// The message at the foot of the view.
  @State private var anchor: String?
  /// How tall the messages' view is, which caps an image's height.
  @State private var height: CGFloat = .infinity

  var body: some View {
    // The draft is a row below the messages, not laid over them, so the foot of the messages'
    // view is the top of the draft and the newest message stays in sight above it.
    VStack(spacing: 0) {
      // One scroll view from the first frame, empty while the messages load: anchored at the
      // bottom, it keeps the foot in view as they come in.
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          header
            .padding(.horizontal)
            .padding(.top, 12)
          ForEach(feed.messages) { message in
            MessageRow(message: message)
          }
        }
        .scrollTargetLayout()
        .padding(.bottom, 6)
      }
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
      .environment(\.conversationHeight, height)
      .scrollPosition(id: $anchor, anchor: .bottom)
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.immediately)
      .accessibilityIdentifier("messages")
      .overlay { state }
      .refreshable { await feed.load(using: model) }
      DraftField(conversation: feed.conversation)
    }
    .background(MessageColor.island)
    .environment(
      \.openURL,
      OpenURLAction { url in
        switch model.follow(url) {
        case .opened, .nowhere: .handled
        case .safari(let address): .systemAction(address)
        }
      }
    )
    .task {
      if feed.state != .loaded {
        await feed.load(using: model)
      }
      // The message the view was left at, which it already shows unless it was built again. The
      // newest is left to the bottom anchor: scrolled to by id before the lazy stack has measured
      // its rows, it lands a message short.
      let saved = model.memory?.anchor(feed.conversation)
      let ids = feed.messages.map(\.id)
      if let saved, saved != ids.last, ids.contains(saved), anchor != saved {
        anchor = saved
      }
    }
    .onChange(of: anchor) { _, id in
      if let id {
        model.memory?.setAnchor(id, for: feed.conversation)
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
          .lineLimit(1)
          .truncationMode(.middle)
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

  /// How long ago, as the web's `ago` says it: "3 minutes ago", "yesterday", or "just now" for
  /// anything under a minute, in whole days, hours, or minutes, rounded as `Math.round` rounds.
  static func ago(_ iso: String, now: Date = .now) -> String {
    guard let date = date(iso) else {
      return iso
    }
    let seconds = (date.timeIntervalSince(now)).rounded()
    let units: [(Calendar.Component, Double)] = [(.day, 86_400), (.hour, 3_600), (.minute, 60)]
    for (unit, size) in units where abs(seconds) >= size {
      var count = DateComponents()
      count.setValue(Int((seconds / size + 0.5).rounded(.down)), for: unit)
      let formatter = RelativeDateTimeFormatter()
      formatter.dateTimeStyle = .named
      formatter.unitsStyle = .full
      return formatter.localizedString(from: count)
    }
    return "just now"
  }
}
