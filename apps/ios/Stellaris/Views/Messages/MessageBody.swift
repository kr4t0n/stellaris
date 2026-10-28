import BoardKit
import SwiftUI
import UIKit

/// A message's blocks as the web's `.board-markdown` sets them, 8 points apart.
struct MessageBody: View {
  let document: MessageDocument

  var body: some View {
    BlockStack(blocks: document.blocks, tone: MessageColor.secondary)
  }
}

private struct BlockStack: View {
  let blocks: [MessageBlock]
  let tone: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        BlockView(block: block, tone: tone)
      }
    }
  }
}

private struct BlockView: View {
  let block: MessageBlock
  let tone: Color

  var body: some View {
    switch block {
    case .paragraph(let inlines):
      Paragraph(inlines: inlines, tone: tone)
    case .heading(_, let inlines):
      // Medium, as the web keeps a message's headings under a pane's own.
      TextBlock(text: MessageText.attributed(inlines, tone: MessageColor.primary, weight: .medium))
        .accessibilityAddTraits(.isHeader)
        .padding(.top, 4)
    case .list(let start, let items):
      ListBlock(start: start, items: items, tone: tone)
    case .quote(let blocks):
      BlockStack(blocks: blocks, tone: MessageColor.tertiary)
        .padding(.leading, 14)
        .overlay(alignment: .leading) {
          Rectangle().fill(MessageColor.lineStrong).frame(width: 2)
        }
    case .code(_, let text):
      CodeBlock(text: text)
    case .table(let table):
      TableBlock(table: table, tone: tone)
    case .rule:
      Rectangle().fill(MessageColor.line).frame(height: 1)
        .accessibilityHidden(true)
    }
  }
}

/// Text as a message sets it: its lines as far apart as the web's, its links in the text's
/// colour, and selectable.
private struct TextBlock: View {
  @ScaledMetric(relativeTo: .body) private var lineSpacing = MessageType.lineSpacing
  let text: AttributedString

  var body: some View {
    Text(text)
      .lineSpacing(lineSpacing)
      .tint(MessageColor.primary)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// A paragraph: its text, and each image it holds on a line of its own.
private struct Paragraph: View {
  let inlines: [MessageInline]
  let tone: Color

  private enum Part {
    case text([MessageInline])
    case image(MessageImage)
  }

  private var parts: [Part] {
    var parts: [Part] = []
    var text: [MessageInline] = []
    func flush() {
      let words = text.contains { inline in
        if case .run(let run) = inline {
          return !run.text.trimmingCharacters(in: .whitespaces).isEmpty
        }
        return false
      }
      if words {
        parts.append(.text(text))
      }
      text = []
    }
    for inline in inlines {
      if case .image(let image) = inline, image.source != nil {
        flush()
        parts.append(.image(image))
      } else {
        text.append(inline)
      }
    }
    flush()
    return parts
  }

  var body: some View {
    let parts = self.parts
    if parts.count == 1, case .text(let inlines) = parts[0] {
      TextBlock(text: MessageText.attributed(inlines, tone: tone))
    } else {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
          switch part {
          case .text(let inlines):
            TextBlock(text: MessageText.attributed(inlines, tone: tone))
          case .image(let image):
            MessageImageView(image: image)
          }
        }
      }
    }
  }
}

/// A list, each item's marker in the 20 points before it: a bullet, its number, or a task's box.
private struct ListBlock: View {
  @ScaledMetric(relativeTo: .body) private var indent = 20.0
  let start: Int?
  let items: [MessageListItem]
  let tone: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          marker(item, at: index)
            .font(MessageType.text())
            .foregroundStyle(tone)
            .frame(width: indent, alignment: .leading)
          BlockStack(blocks: item.blocks, tone: tone)
        }
      }
    }
  }

  @ViewBuilder private func marker(_ item: MessageListItem, at index: Int) -> some View {
    if let checked = item.checked {
      Image(systemName: checked ? "checkmark.square" : "square")
        .accessibilityLabel(checked ? "Done" : "Not done")
    } else if let start {
      Text("\(start + index).")
    } else {
      Text("•")
        .accessibilityHidden(true)
    }
  }
}

/// Code as written, on the web's darker panel: its lines never wrap, the block scrolls sideways
/// instead, and a long press copies it.
private struct CodeBlock: View {
  @ScaledMetric(relativeTo: .caption) private var lineSpacing = 5.0
  let text: String

  var body: some View {
    ScrollView(.horizontal) {
      Text(text)
        .font(MessageType.code)
        .foregroundStyle(MessageColor.secondary)
        .lineSpacing(lineSpacing)
        .fixedSize()
        .padding(12)
    }
    .fixedSize(horizontal: false, vertical: true)
    .background(MessageColor.surface0.opacity(0.8), in: .rect(cornerRadius: 8))
    .overlay {
      RoundedRectangle(cornerRadius: 8).strokeBorder(Color.white.opacity(0.05))
    }
    .contextMenu {
      Button("Copy", systemImage: "doc.on.doc") {
        UIPasteboard.general.string = text
      }
    }
    .accessibilityIdentifier("code-block")
  }
}

/// A table as the web's scrolls: sideways when it is wider than the column, each cell wrapping at
/// 240 points so one long cell can't stretch it forever, with the web's hairlines around its cells.
/// The lines are rules of the grid's own, which span it or fill a row, so no cell has to stretch.
private struct TableBlock: View {
  @ScaledMetric(relativeTo: .caption) private var cap = 240.0
  let table: MessageTable
  let tone: Color

  private var columns: Int {
    max(table.head.count, table.rows.map(\.count).max() ?? 0)
  }

  var body: some View {
    ScrollView(.horizontal) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        across
        GridRow {
          down
          ForEach(0..<columns, id: \.self) { column in
            cell(table.head[safe: column] ?? [], column: column, header: true)
            down
          }
        }
        across
        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            down
            ForEach(0..<columns, id: \.self) { column in
              cell(row[safe: column] ?? [], column: column, header: false)
              down
            }
          }
          across
        }
      }
    }
    .fixedSize(horizontal: false, vertical: true)
  }

  /// A hairline across the table, between its rows.
  private var across: some View {
    Rectangle().fill(MessageColor.line).frame(height: 1)
      .gridCellUnsizedAxes(.horizontal)
  }

  /// A hairline down a row, between its cells.
  private var down: some View {
    Rectangle().fill(MessageColor.line).frame(width: 1)
      .gridCellUnsizedAxes(.vertical)
  }

  private func cell(_ inlines: [MessageInline], column: Int, header: Bool) -> some View {
    let alignment = (table.alignments[safe: column] ?? nil) ?? .leading
    let text = MessageText.attributed(
      inlines, tone: header ? MessageColor.primary : tone, weight: header ? .semibold : .regular,
      small: true)
    return CappedWidth(cap: cap) {
      Text(text)
        .tint(MessageColor.primary)
        .multilineTextAlignment(alignment.text)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .frame(maxWidth: .infinity, alignment: alignment.frame)
  }
}

extension MessageAlignment {
  fileprivate var text: TextAlignment {
    switch self {
    case .leading: .leading
    case .center: .center
    case .trailing: .trailing
    }
  }

  fileprivate var frame: Alignment {
    switch self {
    case .leading: .leading
    case .center: .center
    case .trailing: .trailing
    }
  }
}

extension Array {
  fileprivate subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}

/// Lays its view out no wider than `cap`, and only as wide as it needs below that, where a
/// sideways scroll would let it run as wide as it likes.
private struct CappedWidth: Layout {
  let cap: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = min(proposal.width ?? cap, cap)
    return subviews.first?.sizeThatFits(ProposedViewSize(width: width, height: nil)) ?? .zero
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    subviews.first?.place(
      at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
  }
}
