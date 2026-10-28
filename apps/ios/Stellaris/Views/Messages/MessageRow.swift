import BoardKit
import SwiftUI

/// One message as the web's `MessageItem` lays it out: its author's mark beside the name and when,
/// over the message's text. The board's own posts are dimmed, as on the web.
struct MessageRow: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var tracking =
    MessageTheme.titleTracking * MessageTheme.textSize
  let message: Message

  var body: some View {
    // Who and when side by side, or one above the other at the accessibility sizes.
    let byline =
      typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    HStack(alignment: .top, spacing: 12) {
      AuthorMark(author: message.author)
      VStack(alignment: .leading, spacing: 2) {
        byline {
          Text(model.displayName(message.author))
            .font(MessageType.text(.medium))
            .tracking(tracking)
            .foregroundStyle(MessageColor.primary)
          TimelineView(.everyMinute) { context in
            Text(BoardTime.ago(message.ts, now: context.date))
              .font(MessageType.small())
              .foregroundStyle(MessageColor.tertiary)
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("message-\(message.id)")
        MessageBody(document: model.document(for: message))
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opacity(message.author == "board" ? 0.7 : 1)
  }
}

/// Who wrote a message, as the web's `Avatar` shows them on a rounded tile: a citizen's CLI mark,
/// the user's GitHub picture or "you", or the board's ✦.
struct AuthorMark: View {
  @Environment(AppModel.self) private var model
  @ScaledMetric(relativeTo: .body) private var size = MessageTheme.avatarSize
  let author: String

  var body: some View {
    let scale = size / MessageTheme.avatarSize
    let tile = RoundedRectangle(cornerRadius: MessageTheme.avatarRadius * scale)
    Group {
      if let cli = model.store.cli(of: author) {
        let mark = CliMark.of(cli)
        tile.fill(MessageColor.surface2.opacity(0.8))
          .overlay {
            CliGlyph(glyph: SkyGlyphs.path(for: mark))
              .fill(Color(sky: SkyColor(hex: mark.fill)), style: FillStyle(eoFill: true))
              .frame(width: MessageTheme.markSize * scale, height: MessageTheme.markSize * scale)
          }
      } else if author == "user", let picture = model.actor?.signIn.flatMap(GitHubPicture.init) {
        AsyncImage(url: picture.url(points: size)) { image in
          image.resizable().scaledToFill()
        } placeholder: {
          tile.fill(MessageColor.surface2.opacity(0.8))
        }
        .clipShape(tile)
      } else if author == "user" {
        tile.fill(MessageColor.primary.opacity(0.9))
          .overlay {
            Text("you")
              .font(.system(size: 10 * scale, weight: .semibold))
              .foregroundStyle(MessageColor.surface0)
          }
      } else {
        tile.fill(MessageColor.surface2.opacity(0.5))
          .overlay {
            Text("✦")
              .font(.system(size: 12 * scale))
              .foregroundStyle(MessageColor.muted)
          }
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// A CLI's mark, its path on the 24-unit grid scaled to the frame it is given.
private struct CliGlyph: Shape {
  let glyph: Path

  func path(in rect: CGRect) -> Path {
    glyph.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
      .offsetBy(dx: rect.minX, dy: rect.minY)
  }
}

/// A GitHub account's picture, asked for at the size it shows, as the web's `avatarAt` asks.
struct GitHubPicture {
  let address: URL

  init?(_ signIn: SignIn) {
    guard let address = URL(string: signIn.avatarUrl) else {
      return nil
    }
    self.address = address
  }

  /// The picture at `points`, three pixels to a point.
  func url(points: CGFloat) -> URL {
    guard var parts = URLComponents(url: address, resolvingAgainstBaseURL: false) else {
      return address
    }
    let name = parts.host == "github.com" ? "size" : "s"
    let pixels = String(Int((points * 3).rounded()))
    parts.queryItems = (parts.queryItems ?? []).filter { $0.name != name } + [
      URLQueryItem(name: name, value: pixels)
    ]
    return parts.url ?? address
  }
}
