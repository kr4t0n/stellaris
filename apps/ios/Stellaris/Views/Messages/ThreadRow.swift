import BoardKit
import SwiftUI

/// A thread in its channel's stream where it was opened, as the web's `ThreadItem` draws it: a
/// quiet line that opens it, of who opened what, its mark green while it is open, when it opened
/// or closed, and a closed one's summary under it, cut at two lines. At the accessibility sizes the
/// time sits beside the mark, as a message's does beside its author's, and the line takes the
/// row's whole width and wraps in full, as a message does, so the thread's title shows: at 320
/// points "eng-1 opened topic thread" alone takes four lines there.
struct ThreadRow: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dynamicTypeSize) private var typeSize
  let summary: ThreadSummary

  var body: some View {
    let thread = summary.thread
    let open = thread.state != .known(.closed)
    let at = open ? thread.openedAt : (thread.closedAt ?? thread.openedAt)
    let paragraph = open ? "" : firstParagraph(thread.body, limit: 180)
    Button {
      model.open(.thread(thread.id))
    } label: {
      Group {
        if typeSize.isAccessibilitySize {
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 12) {
              mark(open: open)
              time(at)
            }
            Text(line)
              .font(MessageType.text())
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
            summaryText(paragraph)
          }
        } else {
          HStack(alignment: .top, spacing: 12) {
            mark(open: open)
            VStack(alignment: .leading, spacing: 2) {
              HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(line)
                  .font(MessageType.text())
                  .lineLimit(2)
                  .frame(maxWidth: .infinity, alignment: .leading)
                time(at)
              }
              summaryText(paragraph)
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLine(open: open))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("thread-\(thread.id)")
  }

  /// The turning mark, green while the thread is open.
  private func mark(open: Bool) -> some View {
    Image(systemName: "arrow.turn.down.right")
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(open ? MessageColor.threadOpen : MessageColor.muted)
      .frame(width: MessageTheme.avatarSize, height: 20)
  }

  /// When the thread opened, or closed, as the web says it.
  private func time(_ at: String) -> some View {
    TimelineView(.everyMinute) { context in
      Text(BoardTime.ago(at, now: context.date))
        .font(MessageType.small())
        .foregroundStyle(MessageColor.tertiary)
    }
  }

  /// A closed thread's summary, cut at two lines.
  @ViewBuilder private func summaryText(_ paragraph: String) -> some View {
    if !paragraph.isEmpty {
      Text(model.store.titled(paragraph))
        .font(MessageType.text())
        .foregroundStyle(MessageColor.secondary)
        .lineLimit(2)
    }
  }

  /// "eng-1 opened topic thread", in the quiet tone, then the thread's title.
  private var line: AttributedString {
    let thread = summary.thread
    var opened = AttributedString(
      "\(model.displayName(thread.openedBy)) opened \(subject) thread ")
    opened.foregroundColor = MessageColor.tertiary
    var title = AttributedString(model.store.titled(thread.title))
    title.foregroundColor = MessageColor.secondary
    return opened + title
  }

  /// What the thread is about: a task, a proposal, or a topic of its own.
  private var subject: String {
    summary.thread.subject?.kind.spelled ?? "topic"
  }

  /// The line as VoiceOver reads it, which says the state the mark's colour shows.
  private func accessibilityLine(open: Bool) -> String {
    let thread = summary.thread
    let opened = "\(model.displayName(thread.openedBy)) opened \(subject) thread"
    return "\(opened) \(model.store.titled(thread.title)), \(open ? "open" : "closed")"
  }
}

/// A closed thread's end, as the web's thread shows it: who closed it and when, over its summary.
struct ClosedThread: View {
  @Environment(AppModel.self) private var model
  let thread: BoardThread

  var body: some View {
    let box = RoundedRectangle(cornerRadius: 12)
    VStack(alignment: .leading, spacing: 4) {
      TimelineView(.everyMinute) { context in
        Text(closedBy(now: context.date))
          .font(.custom(MessageType.face(.semibold, italic: false), size: 11, relativeTo: .caption))
          .foregroundStyle(MessageColor.secondary)
      }
      if thread.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text("It ended with its \(thread.subject?.kind.spelled ?? "topic").")
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
      } else {
        MessageBody(
          document: MessageDocument(markdown: thread.body, entities: model.store.entities))
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(MessageColor.surface2.opacity(0.4), in: box)
    .overlay(box.strokeBorder(Color.white.opacity(0.06)))
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 8)
    .accessibilityIdentifier("thread-closed")
  }

  private func closedBy(now: Date) -> String {
    let who = model.displayName(thread.closedBy ?? "board")
    return thread.closedAt.map { "Closed by \(who) \(BoardTime.ago($0, now: now))" }
      ?? "Closed by \(who)"
  }
}

extension OrUnknown<ThreadSubject.Kind> {
  /// The kind as the board spells it.
  var spelled: String {
    switch self {
    case .known(let kind): kind.rawValue
    case .unknown(let kind): kind
    }
  }
}
