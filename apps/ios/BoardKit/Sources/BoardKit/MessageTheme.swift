// What the web draws a message with: the grays and text colours of `@theme` in
// `apps/web/src/styles.css`, which `MessageThemeTests` reads and checks every value here against,
// and the sizes its `.text-title`, `.text-meta`, and `.board-markdown` classes take from
// Tailwind's scale, in points, as the web's pixels are on a phone.

/// The web's look for a conversation and its messages.
public enum MessageTheme {
  /// The page behind every island: `--color-surface-0`, `hsl(0 0% 4%)`.
  public static let surface0 = SkyColor(lightness: 4)
  /// An island, the panel a conversation sits in: `--color-surface-1`, `hsl(0 0% 9%)`.
  public static let surface1 = SkyColor(lightness: 9)
  /// A conversation's panel over the empty sky: `bg-surface-1/80` over `surface-0`, blended as
  /// the browser blends them, 20 in each channel.
  public static let island = SkyColor(
    red: surface1.red * 0.8 + surface0.red * 0.2,
    green: surface1.green * 0.8 + surface0.green * 0.2,
    blue: surface1.blue * 0.8 + surface0.blue * 0.2)
  /// An avatar's tile and inline code: `--color-surface-2`, `hsl(0 0% 15%)`.
  public static let surface2 = SkyColor(lightness: 15)
  /// A table's borders: `--color-line`, `hsl(0 0% 12%)`.
  public static let line = SkyColor(lightness: 12)
  /// A quote's rule: `--color-line-strong`, `hsl(0 0% 20%)`.
  public static let lineStrong = SkyColor(lightness: 20)
  /// Names, headings, strong text, links, and code: `--color-fg-primary`, `hsl(0 0% 96%)`.
  public static let fgPrimary = SkyColor(lightness: 96)
  /// A message's text: `--color-fg-secondary`, `hsl(0 0% 83%)`.
  public static let fgSecondary = SkyColor(lightness: 83)
  /// Times and quotes: `--color-fg-tertiary`, `hsl(0 0% 64%)`.
  public static let fgTertiary = SkyColor(lightness: 64)
  /// A link's underline, and the board's own mark: `--color-fg-muted`, `hsl(0 0% 45%)`.
  public static let fgMuted = SkyColor(lightness: 45)

  /// A mention's text and its tint: Tailwind's `sky-300` and `sky-400`, `oklch(82.8% 0.111
  /// 230.318)` and `oklch(74.6% 0.16 232.661)`, each the nearest colour in sRGB.
  public static let mention = SkyColor(red: 116, green: 212, blue: 255)
  public static let mentionTint = SkyColor(red: 0, green: 188, blue: 255)

  /// The message a link named, as `.message-target` marks it: a tint of Tailwind's `amber-300`,
  /// `oklch(87.9% 0.169 91.605)`, the nearest colour in sRGB, at 6%, and a bar of `rgb(252 211
  /// 77)` at 50% down its leading edge, 2 points wide.
  public static let markTint = SkyColor(red: 255, green: 210, blue: 48)
  public static let markBar = SkyColor(red: 252, green: 211, blue: 77)
  /// An open thread's mark in its channel's stream: Tailwind's `emerald-400`, `oklch(76.5% 0.177
  /// 163.223)`, the nearest colour in sRGB; a closed one's is `fg-muted`.
  public static let threadOpen = SkyColor(red: 0, green: 212, blue: 146)
  /// A post the board didn't take: Tailwind's `red-400`, `oklch(70.4% 0.191 22.216)`, the nearest
  /// colour in sRGB.
  public static let failure = SkyColor(red: 255, green: 100, blue: 103)

  /// `text-sm`, a message's text and a name: 0.875rem.
  public static let textSize = 14.0
  /// `leading-relaxed`, a message's lines: 1.625 times the text.
  public static let bodyLineHeight = 1.625
  /// `tracking-tight`, a name: -0.025em.
  public static let titleTracking = -0.025
  /// `text-xs`, a time and a table's text: 0.75rem.
  public static let metaSize = 12.0
  /// Code, inline and in a block: 12px.
  public static let codeSize = 12.0
  /// `size-7`, an author's tile, and `rounded-lg`, its corners.
  public static let avatarSize = 28.0
  public static let avatarRadius = 8.0
  /// The CLI mark on the tile.
  public static let markSize = 16.0
}

extension SkyColor {
  /// A colour of channels from 0 to 1.
  public init(red: Double, green: Double, blue: Double) {
    self.init(
      red: Int((red * 255).rounded()), green: Int((green * 255).rounded()),
      blue: Int((blue * 255).rounded()))
  }

  /// A gray as the web writes one, `hsl(0 0% <lightness>%)`.
  public init(lightness percent: Double) {
    let value = Int((percent / 100 * 255).rounded())
    self.init(red: value, green: value, blue: value)
  }
}
