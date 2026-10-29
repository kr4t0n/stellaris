import BoardKit
import SwiftUI

/// A channel's or a thread's messages, newest at the foot, with its draft below, on the web's
/// island gray; a channel's also holds each thread opened on it, where it was opened, and a task's
/// or a proposal's thread has what it is about in a strip above. The view opens where the user
/// left it: at the message its scroll was anchored at, or at the newest, or, once, centred at the
/// message a link named, which it marks. A link to a task, a proposal, a thread, or a message
/// opens it here, and any other in Safari.
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
      if let subject = model.subject(of: feed.conversation) {
        SubjectStrip(subject: subject)
      }
      ScrollViewReader { proxy in
        // One scroll view from the first frame, empty while the messages load: anchored at the
        // bottom, it keeps the foot in view as they come in.
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0) {
            header
              .padding(.horizontal)
              .padding(.top, 12)
            ForEach(items) { item in
              switch item {
              case .message(let message):
                MessageRow(message: message, marked: mark?.id == message.id)
              case .thread(let summary):
                ThreadRow(summary: summary)
              }
            }
            if let thread = feed.thread, thread.state == .known(.closed) {
              ClosedThread(thread: thread)
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
        .task {
          if feed.state != .loaded || feed.stale {
            await feed.load(using: model)
          }
          // A task the lists leave out, as an archived project's, is read alone for its strip.
          if let subject = feed.thread?.subject, subject.kind == .known(.task),
            model.store.task(subject.id) == nil
          {
            await model.store.lookUpTask(subject.id, using: model)
          }
          if await reachMark(with: proxy) {
            return
          }
          // The message the view was left at, which it already shows unless it was built again.
          // The newest is left to the bottom anchor: scrolled to by id before the lazy stack has
          // measured its rows, it lands a message short.
          let saved = model.memory?.anchor(feed.conversation)
          let ids = items.map(\.id)
          if let saved, saved != ids.last, ids.contains(saved), anchor != saved {
            anchor = saved
          }
        }
        // A link to a message of the conversation shown.
        .onChange(of: mark) {
          Task { await reachMark(with: proxy) }
        }
      }
      foot
    }
    .background(MessageColor.island)
    .modifier(FollowsBoardLinks())
    .onChange(of: anchor) { _, id in
      if let id {
        model.memory?.setAnchor(id, for: feed.conversation)
      }
    }
  }

  /// The message a link named here, if any.
  private var mark: MessageMark? {
    model.marks[feed.conversation]
  }

  /// What the conversation shows, in order: a channel's messages and the threads opened on it, or
  /// a thread's messages.
  private var items: [ChannelItem] {
    switch feed.conversation {
    case .channel(let ref):
      channelStream(ref, messages: feed.messages, threads: model.store.threads)
    case .thread:
      feed.messages.map(ChannelItem.message)
    }
  }

  /// Scrolls once to the message a link named, centred, as the web's `MessageItem` scrolls to its
  /// target, once the conversation holds it; whether it did.
  @discardableResult private func reachMark(with proxy: ScrollViewProxy) async -> Bool {
    guard let mark, !mark.reached, feed.messages.contains(where: { $0.id == mark.id }) else {
      return false
    }
    // Once the lazy stack holds the rows the load brought.
    await Task.yield()
    proxy.scrollTo(mark.id, anchor: .center)
    model.reachedMark(in: feed.conversation)
    return true
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

  /// The draft, or why there is none: a channel archived, or of an archived project, takes no
  /// posts, and a closed thread none either, as the web's views have it.
  @ViewBuilder private var foot: some View {
    switch feed.conversation {
    case .channel(let ref):
      if let readOnly = model.store.readOnly(ref) {
        ReadOnlyLine(readOnly: readOnly)
      } else {
        DraftField(conversation: feed.conversation)
      }
    case .thread:
      if feed.thread?.state != .known(.closed) {
        DraftField(conversation: feed.conversation)
      }
    }
  }

  @ViewBuilder private var state: some View {
    switch feed.state {
    case .idle, .loading:
      if items.isEmpty {
        ProgressView()
      }
    case .loaded:
      if items.isEmpty {
        // Drags pass through to the conversation, to pull it to refresh.
        ContentUnavailableView("No messages", systemImage: "bubble.left")
          .allowsHitTesting(false)
      }
    case .failed(let reason):
      if items.isEmpty {
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

/// Follows a link in the board's text as `AppModel.follow` says: what the board names opens in Chat,
/// after `opened`, an address on the web in Safari, and anything else nowhere.
struct FollowsBoardLinks: ViewModifier {
  @Environment(AppModel.self) private var model
  var opened: () -> Void = {}

  func body(content: Content) -> some View {
    content.environment(
      \.openURL,
      OpenURLAction { url in
        switch model.follow(url) {
        case .opened:
          opened()
          return .handled
        case .nowhere:
          return .handled
        case .safari(let address):
          return .systemAction(address)
        }
      })
  }
}

/// Why a channel takes no posts, where its draft would be, as the web's channel says it.
struct ReadOnlyLine: View {
  let readOnly: BoardStore.ReadOnly

  var body: some View {
    TimelineView(.everyMinute) { context in
      Text(text(now: context.date))
        .font(MessageType.small())
        .foregroundStyle(MessageColor.tertiary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .overlay(alignment: .top) {
          Rectangle().fill(MessageColor.line).frame(height: 1)
        }
    }
    .accessibilityIdentifier("read-only")
  }

  private func text(now: Date) -> String {
    switch readOnly {
    case .archived(let archived):
      "Archived \(BoardTime.ago(archived.at, now: now)) by \(archived.by): \(archived.reason)."
    case .projectArchived(let project):
      "\(project) is archived, so its channels are read-only."
    }
  }
}

/// The draft of the conversation's next message, kept by conversation as it is typed, in a box
/// drawn as the web's `Composer` draws one, on the island's gray below a hairline, with Send in it,
/// beside the text, or under it at the accessibility sizes, where the text takes the box's width.
/// It grows to five lines, two where the window is short, then scrolls. Typing `@` offers the
/// citizens to mention above it, as on the web, and a pick completes the name.
struct DraftField: View {
  @Environment(AppModel.self) private var model
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.dynamicTypeSize) private var typeSize
  @FocusState private var focused: Bool
  /// Where the caret is, which the mention being typed is read before.
  @State private var selection: TextSelection?
  @State private var sending = false
  /// The board's reason for not taking the last post, in its own words.
  @State private var failure: String?
  let conversation: Conversation

  var body: some View {
    let draft = Binding(
      get: { model.memory?.draft(conversation) ?? "" },
      set: { model.memory?.setDraft($0, for: conversation) })
    let typing = mention(in: draft.wrappedValue)
    let candidates = typing.map { model.store.mentionable($0.fragment.prefix) } ?? []
    let box = RoundedRectangle(cornerRadius: 12)
    VStack(alignment: .leading, spacing: 8) {
      if let typing, !candidates.isEmpty {
        MentionList(members: candidates) { name in
          let done = completeMention(
            draft.wrappedValue, caret: typing.caret, start: typing.fragment.start, name: name)
          draft.wrappedValue = done.text
          selection = TextSelection(
            insertionPoint: String.Index(utf16Offset: done.caret, in: done.text))
        }
      }
      // One layout or the other around the same field, which keeps its focus as the size changes.
      let row =
        typeSize.isAccessibilitySize
        ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 0))
        : AnyLayout(HStackLayout(alignment: .bottom, spacing: 8))
      row {
        TextField(
          text: draft, selection: $selection,
          prompt: Text("Message").foregroundStyle(MessageColor.muted), axis: .vertical
        ) {
          Text("Message")
        }
        .lineLimit(verticalSizeClass == .compact ? 1...2 : 1...5)
        .textFieldStyle(.plain)
        .font(MessageType.text())
        .foregroundStyle(MessageColor.primary)
        .focused($focused)
        .accessibilityIdentifier("draft")
        .padding(.leading, 12)
        .padding(.trailing, typeSize.isAccessibilitySize ? 12 : 0)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        SendButton(sending: sending, enabled: sendable(draft.wrappedValue)) {
          send(draft.wrappedValue)
        }
        .padding(.trailing, 6)
        .padding(.bottom, 6)
      }
      .background(MessageColor.surface2.opacity(0.5), in: box)
      // The web's inset edge, brighter while the box has the focus.
      .overlay(box.strokeBorder(Color.white.opacity(focused ? 0.16 : 0.06)))
      if let failure {
        Text(failure)
          .font(MessageType.small())
          .foregroundStyle(MessageColor.failure)
          .accessibilityIdentifier("post-failed")
      }
    }
    .padding(12)
    .overlay(alignment: .top) {
      Rectangle().fill(MessageColor.line).frame(height: 1)
    }
  }

  /// The mention being typed before the caret, and where the caret is, in UTF-16 code units as the
  /// web counts them.
  private func mention(in text: String) -> (fragment: MentionFragment, caret: Int)? {
    guard focused, let selection, case .selection(let range) = selection.indices,
      range.lowerBound <= text.endIndex
    else {
      return nil
    }
    let caret = text.utf16.distance(from: text.startIndex, to: range.lowerBound)
    return mentionAt(text, caret: caret).map { ($0, caret) }
  }

  private func sendable(_ text: String) -> Bool {
    !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Posts the draft, then empties it unless it was changed while the post went.
  private func send(_ text: String) {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard sendable(body) else {
      return
    }
    sending = true
    failure = nil
    Task {
      do {
        _ = try await model.post(body, to: conversation)
        let now = model.memory?.draft(conversation) ?? ""
        if now.trimmingCharacters(in: .whitespacesAndNewlines) == body {
          model.memory?.setDraft("", for: conversation)
          selection = nil
        }
      } catch let refusal as BoardError where refusal.status != 0 {
        failure = refusal.message
      } catch {
        failure = "The message was not sent."
      }
      sending = false
    }
  }
}

/// The web's primary button, which sends a draft: `fg-primary` with the page's dark text on it.
struct SendButton: View {
  let sending: Bool
  let enabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(sending ? "Sending…" : "Send")
        .font(MessageType.small(.medium))
        .lineLimit(1)
        .fixedSize()
        .foregroundStyle(MessageColor.surface0)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 28)
        .background(MessageColor.primary, in: RoundedRectangle(cornerRadius: 6))
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.4)
    .accessibilityIdentifier("send")
  }
}

/// The citizens a mention being typed offers, as the web's composer lists them on a card above
/// the box: each one's CLI mark, name, and role. At the accessibility sizes the card takes the
/// draft's width and each role sits under its name, so the name shows whole.
struct MentionList: View {
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var markSize: CGFloat = 14
  let members: [Member]
  let pick: (String) -> Void

  var body: some View {
    let card = RoundedRectangle(cornerRadius: 8)
    let stacked = typeSize.isAccessibilitySize
    VStack(alignment: .leading, spacing: 0) {
      ForEach(members, id: \.name) { member in
        Button {
          pick(member.name)
        } label: {
          HStack(spacing: 8) {
            if let cli = member.cli {
              CliMarkGlyph(cli: cli, size: markSize)
            }
            let words =
              stacked
              ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0))
              : AnyLayout(HStackLayout(spacing: 8))
            words {
              Text(member.name)
                .font(MessageType.text())
                .foregroundStyle(MessageColor.primary)
                .lineLimit(1)
              if !stacked {
                Spacer(minLength: 8)
              }
              if let role = member.role {
                // The web's 11 pixels, following the type size as everything else does.
                Text(role)
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(MessageColor.muted)
                  .lineLimit(1)
              }
            }
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("mention-\(member.name)")
      }
    }
    .padding(.vertical, 4)
    .frame(maxWidth: stacked ? .infinity : 240, alignment: .leading)
    .background(MessageColor.surface1, in: card)
    .overlay(card.strokeBorder(Color.white.opacity(0.06)))
    .shadow(color: .black.opacity(0.5), radius: 6, y: 4)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Citizens to mention")
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
