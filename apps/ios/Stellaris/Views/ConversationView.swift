import BoardKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

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
  /// The window's safe area beyond the conversation's edges, the keyboard left out, which places
  /// the draft against the side bar. Read here, where the draft's own padding can't move it.
  @State private var room = EdgeInsets()

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
    .background {
      Color.clear
        .ignoresSafeArea(.keyboard)
        .onGeometryChange(for: EdgeInsets.self) { proxy in
          let insets = proxy.safeAreaInsets
          return EdgeInsets(
            top: 0, leading: 0, bottom: insets.bottom.rounded(), trailing: insets.trailing.rounded())
        } action: {
          room = $0
        }
    }
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
        DraftField(conversation: feed.conversation, room: room)
      }
    case .thread:
      if feed.thread?.state != .known(.closed) {
        DraftField(conversation: feed.conversation, room: room)
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

/// The draft of the conversation's next message, kept by conversation as it is typed, in a capsule
/// drawn as Safari's address bar is: Liquid Glass, 48 points tall at one line with its ends round
/// all the way, floating on the conversation's gray. It grows to five lines, two where the window is
/// short, then scrolls, keeping the same ends. At rest its bottom meets the foot of iOS's side bar,
/// as Safari's address bar meets its own. Photos sits inside its trailing end, where Safari has the
/// mic, or under the text at the accessibility sizes, where the text takes the capsule's width.
/// Send shows only while the field is focused, as Safari shows its × only while its bar has the
/// keyboard: a round button as tall as the capsule beside it, in the side bar's column where iOS
/// draws one, which the keyboard covers then. Return breaks the line, and only Send posts. Typing
/// `@` offers the citizens to mention above it, as on the web, and a pick completes the name.
/// Photos, and Paste in the menu a long press on the draft opens, put images in it as the web's
/// composer does: each holds its place at the caret with a line saying it uploads, which the
/// board's markdown for it replaces, and Send waits for them. A row above the capsule shows each
/// image the draft holds as a thumbnail, with a × that takes it out.
struct DraftField: View {
  @Environment(AppModel.self) private var model
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.sideBarEdge) private var sideBarEdge
  @FocusState private var focused: Bool
  /// Where the caret is, which the mention being typed is read before.
  @State private var selection: TextSelection?
  @State private var sending = false
  /// The board's reason for not taking the last post, in its own words.
  @State private var failure: String?
  /// The photos just picked, until their uploads start.
  @State private var picked: [PhotosPickerItem] = []
  let conversation: Conversation
  /// The window's safe area beyond the conversation's bottom and trailing edges, the keyboard left
  /// out, which places the draft against the side bar; none where the draft is drawn alone.
  var room = EdgeInsets()

  /// Safari's address bar is 48 points tall, as wide as iOS's side bar: the capsule's height at one
  /// line, and Send's.
  static let height: CGFloat = 48
  /// How far in from the window's trailing edge and from its foot iOS 27.1 draws the side bar on
  /// the outer display, as the simulator's pictures measure it.
  static let sideBarMargin: CGFloat = 24

  var body: some View {
    let draft = Binding(
      get: { model.memory?.draft(conversation) ?? "" },
      set: { model.memory?.setDraft($0, for: conversation) })
    let typing = mention(in: draft.wrappedValue)
    let candidates = typing.map { model.store.mentionable($0.fragment.prefix) } ?? []
    let capsule = RoundedRectangle(cornerRadius: Self.height / 2, style: .continuous)
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
      let images = model.draftImages(in: conversation)
      if !images.isEmpty {
        ScrollView(.horizontal) {
          HStack(spacing: 8) {
            ForEach(images, id: \.self) { image in
              DraftImageView(
                image: image, preview: model.uploadPreviews[conversation.key]?[image.text]
              ) {
                remove(image)
              }
            }
          }
        }
        .scrollIndicators(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Images in the draft")
        .accessibilityIdentifier("draft-images")
      }
      HStack(alignment: .bottom, spacing: 10) {
        // One layout or the other around the same field, which keeps its focus as the size
        // changes.
        let field =
          typeSize.isAccessibilitySize
          ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 0))
          : AnyLayout(HStackLayout(alignment: .bottom, spacing: 8))
        field {
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
          // The draft's own Paste, from its menu, hands over an image it can't hold as text; text
          // still pastes as the field's own.
          .pasteDestination(for: PastedImage.self) { images in
            upload(images.map(\.data))
          }
          .padding(.leading, 16)
          .padding(.trailing, typeSize.isAccessibilitySize ? 16 : 0)
          .padding(.vertical, 10)
          .frame(minHeight: Self.height)
          .frame(maxWidth: .infinity, alignment: .leading)
          PhotosPicker(
            selection: $picked, maxSelectionCount: 10, matching: .images,
            preferredItemEncoding: .compatible
          ) {
            ComposerGlyph(symbol: "photo")
          }
          .accessibilityLabel("Add photos")
          .accessibilityIdentifier("add-photos")
          .padding(.trailing, 12)
          // Centred on a line of text, the first or the last.
          .padding(.bottom, (Self.height - ComposerGlyph.target) / 2)
        }
        .glassEffect(.regular, in: capsule)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer")
        if focused {
          SendButton(sending: sending, enabled: sendable(draft.wrappedValue)) {
            send(draft.wrappedValue)
          }
          .transition(.opacity)
        }
      }
      .padding(.trailing, sendReach)
      if let failure {
        Text(failure)
          .font(MessageType.small())
          .foregroundStyle(MessageColor.failure)
          .accessibilityIdentifier("post-failed")
      }
      if let refused = model.uploadFailures[conversation.key] {
        Text(refused)
          .font(MessageType.small())
          .foregroundStyle(MessageColor.failure)
          .accessibilityIdentifier("upload-failed")
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 12)
    .padding(.bottom, drop > 0 ? -drop : 12)
    .animation(.smooth(duration: 0.2), value: focused)
    .onChange(of: picked) { _, items in
      guard !items.isEmpty else {
        return
      }
      picked = []
      attach(items)
    }
  }

  /// Where iOS draws its side bar on the trailing edge, as on the outer display.
  private var besideSideBar: Bool {
    sideBarEdge == .trailing
  }

  /// How far Send reaches past the draft's own trailing edge: while the keyboard covers the side
  /// bar, Send stands in the bar's column, as Safari's × does, the bar's margin in from the
  /// window's edge. Elsewhere it keeps to the draft's edge.
  private var sendReach: CGFloat {
    guard focused, besideSideBar, room.trailing >= Self.height + Self.sideBarMargin else {
      return 0
    }
    return Self.sideBarMargin - 12 - room.trailing
  }

  /// How far the capsule reaches below the safe area: at rest beside the side bar, down to the
  /// bar's foot, which iOS draws below it. None while the field is focused, where the capsule sits
  /// 12 points above the keyboard, or while a failure line shows under it.
  private var drop: CGFloat {
    let failing = failure != nil || model.uploadFailures[conversation.key] != nil
    guard !focused, !failing, besideSideBar, room.bottom > Self.sideBarMargin else {
      return 0
    }
    return room.bottom - Self.sideBarMargin
  }

  /// Uploads the photos picked, each as Photos gives it in the most compatible encoding.
  private func attach(_ items: [PhotosPickerItem]) {
    for (item, held) in zip(items, hold(items.count)) {
      Task {
        let data = try? await item.loadTransferable(type: Data.self)
        follow(await model.upload(data, holding: held, in: conversation) { caret() })
      }
    }
  }

  /// Uploads the images the draft's own Paste handed over.
  private func upload(_ images: [Data]) {
    guard !images.isEmpty else {
      return
    }
    for (data, held) in zip(images, hold(images.count)) {
      Task {
        follow(await model.upload(data, holding: held, in: conversation) { caret() })
      }
    }
  }

  /// Takes an image out of the draft, and keeps the caret among the same words.
  private func remove(_ image: DraftImage) {
    let draft = model.memory?.draft(conversation) ?? ""
    follow(model.removeImage(image, from: conversation, caret: caret() ?? draft.utf16.count))
  }

  /// Where the draft's caret is, in UTF-16 code units, once the field has had one.
  private func caret() -> Int? {
    let text = model.memory?.draft(conversation) ?? ""
    guard let selection, case .selection(let range) = selection.indices,
      range.lowerBound <= text.endIndex
    else {
      return nil
    }
    return text.utf16.distance(from: text.startIndex, to: range.lowerBound)
  }

  /// Moves the caret to where an image's markdown left it, among the same words: the field would
  /// otherwise keep its offset, which the markdown, longer than its line, moved into other words.
  private func follow(_ settled: DraftEdit?) {
    guard let settled, selection != nil else {
      return
    }
    selection = TextSelection(
      insertionPoint: String.Index(utf16Offset: settled.caret, in: settled.text))
  }

  /// Holds the place of `count` images where the caret last was, in place of what was selected, or
  /// at the end of a draft never typed in, and puts the caret after them; gives the lines they
  /// hold, each its own.
  private func hold(_ count: Int) -> [String] {
    let text = model.memory?.draft(conversation) ?? ""
    var range = (start: text.utf16.count, end: text.utf16.count)
    if let selection, case .selection(let selected) = selection.indices,
      selected.upperBound <= text.endIndex
    {
      range = (
        text.utf16.distance(from: text.startIndex, to: selected.lowerBound),
        text.utf16.distance(from: text.startIndex, to: selected.upperBound)
      )
    }
    let held = model.holdImages(count, in: conversation, start: range.start, end: range.end)
    let now = model.memory?.draft(conversation) ?? ""
    selection = TextSelection(insertionPoint: String.Index(utf16Offset: held.caret, in: now))
    return held.placeholders
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
    !sending && model.uploading[conversation.key] == nil
      && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

/// An image the draft holds, as a thumbnail above it: the board's copy once it is kept, read by its
/// id as a message's is, or the upload's own picture, dimmed and saying so, while it is on its way;
/// its × takes the image's markdown, or its upload's line, out of the draft.
struct DraftImageView: View {
  @Environment(AppModel.self) private var model
  let image: DraftImage
  /// The upload's own picture, a small JPEG, until the board keeps it.
  let preview: Data?
  let remove: () -> Void
  @State private var kept: UIImage?

  var body: some View {
    let tile = RoundedRectangle(cornerRadius: 8)
    ZStack(alignment: .topTrailing) {
      ZStack {
        MessageColor.surface2.opacity(0.5)
        if image.id != nil {
          if let kept {
            Image(uiImage: kept)
              .resizable()
              .scaledToFill()
              .accessibilityLabel(image.alt.isEmpty ? "Image" : image.alt)
          }
        } else {
          if let preview, let picture = UIImage(data: preview) {
            Image(uiImage: picture)
              .resizable()
              .scaledToFill()
              .opacity(0.35)
              .accessibilityHidden(true)
          }
          Text("Uploading…")
            .font(MessageType.small())
            .foregroundStyle(MessageColor.primary)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        }
      }
      .frame(width: 64, height: 64)
      .clipShape(tile)
      .overlay(tile.strokeBorder(Color.white.opacity(0.08)))
      Button(action: remove) {
        Image(systemName: "xmark")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(.white)
          .frame(width: 20, height: 20)
          .background(Color.black.opacity(0.6), in: Circle())
      }
      .buttonStyle(.plain)
      .padding(4)
      .accessibilityLabel(
        image.id == nil
          ? "Remove \(image.alt), still uploading"
          : image.alt.isEmpty ? "Remove the image" : "Remove \(image.alt)")
      .accessibilityIdentifier("remove-draft-image")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("draft-image")
    .task(id: image.id) {
      guard let id = image.id else {
        return
      }
      kept = try? await model.images.image(.upload(id), using: model)
    }
  }
}

/// An image on the pasteboard as its bytes, in whatever kind of image it is, for the draft's own
/// Paste.
struct PastedImage: Transferable, Sendable {
  let data: Data

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(importedContentType: .image) { data in PastedImage(data: data) }
  }
}

/// An icon in the draft's capsule, as the web's quiet button draws one: the tertiary text colour, in
/// a target 28 points square.
struct ComposerGlyph: View {
  let symbol: String

  /// How tall and wide a glyph's target is.
  nonisolated static let target: CGFloat = 28

  /// Off the main actor too, since Photos draws its button's label from a `@Sendable` closure.
  nonisolated init(symbol: String) {
    self.symbol = symbol
  }

  var body: some View {
    Image(systemName: symbol)
      .font(MessageType.text())
      .foregroundStyle(MessageColor.tertiary)
      .frame(minWidth: Self.target, minHeight: Self.target)
      .contentShape(Rectangle())
  }
}

/// Sends the draft: a round button of Liquid Glass as tall as the draft's capsule, as Safari's ×
/// is, with the web's primary white arrow while there is something to send, a dim one while the
/// draft is empty or an image still uploads, and a spinner while the post goes.
struct SendButton: View {
  let sending: Bool
  let enabled: Bool
  let action: () -> Void

  var body: some View {
    let circle = Circle()
    Button(action: action) {
      Group {
        if sending {
          ProgressView()
            .tint(MessageColor.primary)
        } else {
          Image(systemName: "arrow.up")
            .font(.system(size: 19, weight: .semibold))
            .foregroundStyle(enabled ? MessageColor.primary : MessageColor.tertiary)
        }
      }
      .frame(width: DraftField.height, height: DraftField.height)
      .glassEffect(.regular, in: circle)
      .contentShape(circle)
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityLabel(sending ? "Sending" : "Send")
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
