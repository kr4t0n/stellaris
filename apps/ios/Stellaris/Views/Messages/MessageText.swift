import BoardKit
import SwiftUI

/// The web's type for a message: Instrument Sans, bundled with the app in `Fonts/` under the SIL
/// Open Font License, at the sizes `MessageTheme` gives, and scaling with Dynamic Type from them.
/// Code is the system's monospaced face at the caption's size, 12 points by default, as the web's
/// is.
enum MessageType {
  enum Weight {
    case regular, medium, semibold
  }

  /// A face of Instrument Sans by its PostScript name.
  static func face(_ weight: Weight, italic: Bool) -> String {
    let face =
      switch (weight, italic) {
      case (.regular, false): "Regular"
      case (.regular, true): "Italic"
      case (.medium, false): "Medium"
      case (.medium, true): "MediumItalic"
      case (.semibold, false): "SemiBold"
      case (.semibold, true): "SemiBoldItalic"
      }
    return "InstrumentSans-\(face)"
  }

  /// A message's text at `text-sm`, scaling as the body style does.
  static func text(_ weight: Weight = .regular, italic: Bool = false) -> Font {
    .custom(face(weight, italic: italic), size: MessageTheme.textSize, relativeTo: .body)
  }

  /// A time, and a table's text, at `text-xs`, scaling as a caption does.
  static func small(_ weight: Weight = .regular, italic: Bool = false) -> Font {
    .custom(face(weight, italic: italic), size: MessageTheme.metaSize, relativeTo: .caption)
  }

  static let code = Font.system(.caption, design: .monospaced)

  /// The space between a message's lines for the web's `leading-relaxed`, at the default size:
  /// Instrument Sans sets its lines 1.22 times its size apart.
  static let lineSpacing = (MessageTheme.bodyLineHeight - 1.22) * MessageTheme.textSize
}

/// The web's colours for a message, from `MessageTheme`.
enum MessageColor {
  static let island = Color(sky: MessageTheme.island)
  static let surface0 = Color(sky: MessageTheme.surface0)
  static let surface2 = Color(sky: MessageTheme.surface2)
  static let line = Color(sky: MessageTheme.line)
  static let lineStrong = Color(sky: MessageTheme.lineStrong)
  static let primary = Color(sky: MessageTheme.fgPrimary)
  static let secondary = Color(sky: MessageTheme.fgSecondary)
  static let tertiary = Color(sky: MessageTheme.fgTertiary)
  static let muted = Color(sky: MessageTheme.fgMuted)
  static let mention = Color(sky: MessageTheme.mention)
  static let mentionTint = Color(sky: MessageTheme.mentionTint, opacity: 0.1)
  static let surface1 = Color(sky: MessageTheme.surface1)
  static let markTint = Color(sky: MessageTheme.markTint, opacity: 0.06)
  static let markBar = Color(sky: MessageTheme.markBar, opacity: 0.5)
  static let threadOpen = Color(sky: MessageTheme.threadOpen)
  static let failure = Color(sky: MessageTheme.failure)
}

/// A block's text as one `AttributedString`, set as the web sets it: each run's face and colour,
/// code and mentions on their tints, and links underlined, each with the address the conversation
/// follows (`AppModel.follow`).
enum MessageText {
  /// Text in `tone`, at the body's size or, `small`, a table's.
  static func attributed(
    _ inlines: [MessageInline], tone: Color, weight: MessageType.Weight = .regular,
    small: Bool = false
  ) -> AttributedString {
    var text = AttributedString()
    for inline in inlines {
      switch inline {
      case .run(let run):
        text.append(piece(run, tone: tone, weight: weight, small: small))
      case .lineBreak:
        text.append(AttributedString("\n"))
      case .image(let image):
        // Where an image can't be drawn, as in a table's cell or a heading, its description reads.
        var words = AttributedString(image.text)
        words.font = small ? MessageType.small(weight) : MessageType.text(weight)
        words.foregroundColor = tone
        text.append(words)
      }
    }
    return text
  }

  private static func piece(
    _ run: MessageRun, tone: Color, weight: MessageType.Weight, small: Bool
  ) -> AttributedString {
    var piece = AttributedString(run.text)
    let italic = run.style.contains(.emphasis)
    func font(_ weight: MessageType.Weight) -> Font {
      small ? MessageType.small(weight, italic: italic) : MessageType.text(weight, italic: italic)
    }
    switch run.kind {
    case .code:
      piece.font = MessageType.code
      piece.foregroundColor = MessageColor.primary
      piece.backgroundColor = MessageColor.surface2.opacity(0.8)
    case .mention:
      piece.font = font(.medium)
      piece.foregroundColor = MessageColor.mention
      piece.backgroundColor = MessageColor.mentionTint
    case .text:
      let strong = run.style.contains(.strong)
      piece.font = font(strong ? .semibold : weight)
      piece.foregroundColor = strong ? MessageColor.primary : tone
    }
    if run.style.contains(.strikethrough) {
      piece.strikethroughStyle = Text.LineStyle.single
    }
    if let link = run.link, let url = url(for: link) {
      piece.link = url
      piece.foregroundColor = MessageColor.primary
      piece.underlineStyle = Text.LineStyle(pattern: .solid, color: MessageColor.muted)
    }
    return piece
  }

  /// The address a link carries in the text: the board's own path for what is on the board, which
  /// the conversation opens in Chat or in the board's page, and an address on the web as written.
  static func url(for link: MessageLink) -> URL? {
    switch link {
    case .entity(let entity):
      return URL(string: entityHref(entity))
    case .file(let source, let path, let line):
      // The web's file view: `/task/<id>/files/<path>`, or `/p/<slug>/files/<path>` for a project.
      let place =
        switch source {
        case .task(let id): "/task/\(id)/files"
        case .project(let slug): "/p/\(slug)/files"
        }
      let parts = path.split(separator: "/").map {
        "/" + ($0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0))
      }
      return URL(string: place + parts.joined() + (line.map { "?line=\($0)" } ?? ""))
    case .web(let href):
      if href.hasPrefix("#") {
        return nil
      }
      return URL(string: href.hasPrefix("//") ? "https:" + href : href)
    }
  }
}
