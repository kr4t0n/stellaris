import BoardKit
import SwiftUI

/// The card of what a tap took, in a panel at the foot of the sky rather than over it: the web's
/// hover cards for a citizen and a task, and one for a sphere. Open goes to the task's thread or
/// the project's general channel; a citizen's card has none until the app has a citizen's view.
/// At the accessibility type sizes its parts stack rather than share a line, and a card taller than
/// the room it is offered scrolls inside it, so it never runs past the sky's part.
struct SkyCard: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dynamicTypeSize) private var typeSize
  let target: SkyTarget
  let model: SkyModel

  private var stacked: Bool { typeSize.isAccessibilitySize }

  var body: some View {
    ViewThatFits(in: .vertical) {
      content
      ScrollView {
        content
      }
      .scrollBounceBehavior(.basedOnSize)
    }
    .frame(maxWidth: stacked ? .infinity : 420, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("sky-card")
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 10) {
      switch target {
      case .star(let id):
        if let star = model.stars.first(where: { $0.id == id }) {
          citizenCard(star)
        } else {
          gone
        }
      case .task(let id):
        if let mark = model.tasks.first(where: { $0.id == id }) {
          taskCard(mark)
        } else {
          gone
        }
      case .sphere(let id):
        if let anchor = model.anchors.first(where: { $0.id == id }) {
          sphereCard(anchor)
        } else {
          gone
        }
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var gone: some View {
    header(title: "Gone from the sky", icon: AnyView(EmptyView()), chip: nil)
  }

  // MARK: A citizen

  private func citizenCard(_ star: SkyStar) -> some View {
    let member = app.sky.members.first { $0.name == star.name }
    let mark = CliMark.of(star.cli)
    let modelName = member?.lastModel ?? member?.model
    let chip: (String, SkyColor) =
      switch star.state {
      case .working: ("working", SkyColor(hex: "#6ee7b7"))
      case .queued: ("queued", SkyColor(hex: "#fcd34d"))
      case .idle: ("resting", SkyPalette.fgTertiary)
      }
    return VStack(alignment: .leading, spacing: 8) {
      header(
        title: star.name,
        subtitle: [member?.role, modelName].compactMap { $0 }.joined(separator: " · "),
        icon: AnyView(Glyph(mark: mark)), chip: chip)
      Text(activity(star, member: member))
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
  }

  private func activity(_ star: SkyStar, member: Member?) -> String {
    let place = { (id: String?) in
      model.anchors.first { $0.id == id }.map { $0.kind == .society ? "the society" : $0.label }
        ?? "the society"
    }
    switch star.state {
    case .working: return "In a turn at \(place(star.anchor))"
    case .queued: return "Queued for \(place(star.queuedFor))"
    case .idle:
      return member?.lastTurnAt.map { "Last turn \(BoardTime.ago($0))" } ?? "No turns yet"
    }
  }

  // MARK: A task

  private func taskCard(_ mark: SkyTaskMark) -> some View {
    let color = SkyPalette.phase(mark.phase)
    let holderCli = app.sky.members.first { $0.name == mark.holder }?.cli
    return VStack(alignment: .leading, spacing: 8) {
      header(
        title: mark.title, icon: AnyView(Diamond(color: color)),
        chip: (mark.phase.label.lowercased(), color))
      details(rows(of: mark), glyph: holderCli.map { CliMark.of($0) })
        .font(.subheadline)
      open { app.open(.thread(mark.id)) }
    }
  }

  /// What the task card lists: its project, its stage, and who holds it or may take it.
  private func rows(of mark: SkyTaskMark) -> [(String, String)] {
    var rows = [("Project", app.store.projectName(mark.project)), ("Stage", mark.stage)]
    if let holder = mark.holder {
      rows.append(("Held by", "\(holder) · \(mark.linked == nil ? "resting" : "in a turn on it")"))
    } else if let waiting = mark.waitingFor {
      rows.append(("Waiting for", waiting))
    }
    return rows
  }

  // MARK: A sphere

  private func sphereCard(_ anchor: SkyAnchor) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      header(
        title: anchor.kind == .society ? "The society" : anchor.label,
        icon: AnyView(Image(systemName: anchor.kind == .society ? "sun.max" : "circle.dotted")),
        chip: nil)
      Text(SkyElements.describe(anchor, in: model))
        .font(.subheadline)
        .foregroundStyle(.secondary)
      open {
        app.open(.channel(anchor.kind == .society ? "general" : "\(anchor.id)/general"))
      }
    }
  }

  // MARK: Parts

  private func header(
    title: String, subtitle: String = "", icon: AnyView, chip: (String, SkyColor)?
  ) -> some View {
    let layout =
      stacked
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
      : AnyLayout(HStackLayout(alignment: .top, spacing: 10))
    return HStack(alignment: .top, spacing: 10) {
      if !stacked {
        icon
          .frame(width: 32, height: 32)
          .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
          .accessibilityHidden(true)
      }
      layout {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("sky-card-title")
          if !subtitle.isEmpty {
            Text(subtitle)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        if !stacked {
          Spacer(minLength: 0)
        }
        if let chip {
          Text(chip.0)
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(Color(sky: chip.1))
            .background(Color(sky: chip.1, opacity: 0.15), in: Capsule())
        }
      }
      // Stacked, the parts take the card's width, so Close keeps to its trailing corner.
      .frame(maxWidth: .infinity, alignment: .leading)
      Button {
        app.sky.card = nil
      } label: {
        Label("Close", systemImage: "xmark")
          .labelStyle(.iconOnly)
          .font(.system(size: 15, weight: .semibold))
          .frame(width: 28, height: 28)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .accessibilityShowsLargeContentViewer()
      .accessibilityIdentifier("sky-card-close")
    }
  }

  /// Labelled values in two columns, or each label over its value at the accessibility sizes. The
  /// last row's value, who holds the task, leads with `glyph`, its CLI's mark.
  @ViewBuilder private func details(_ rows: [(String, String)], glyph: CliMark?) -> some View {
    let last = rows.count - 1
    if stacked {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(rows.indices, id: \.self) { index in
          VStack(alignment: .leading, spacing: 2) {
            Text(rows[index].0).foregroundStyle(.tertiary)
            value(rows[index].1, glyph: index == last && rows[index].0 == "Held by" ? glyph : nil)
          }
        }
      }
    } else {
      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
        ForEach(rows.indices, id: \.self) { index in
          GridRow {
            Text(rows[index].0).foregroundStyle(.tertiary)
            value(rows[index].1, glyph: index == last && rows[index].0 == "Held by" ? glyph : nil)
          }
        }
      }
    }
  }

  private func value(_ text: String, glyph: CliMark?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      if let glyph {
        Glyph(mark: glyph, size: 14)
      }
      Text(text).fixedSize(horizontal: false, vertical: true)
    }
  }

  private func open(_ action: @escaping () -> Void) -> some View {
    Button("Open") {
      action()
      app.sky.card = nil
    }
    .buttonStyle(.bordered)
    .accessibilityIdentifier("sky-card-open")
  }
}

/// A CLI's mark, as the stars show it.
private struct Glyph: View {
  let mark: CliMark
  var size = 18.0

  var body: some View {
    SkyGlyphs.path(for: mark)
      .applying(CGAffineTransform(scaleX: size / 24, y: size / 24))
      .fill(Color(sky: SkyColor(hex: mark.fill)), style: FillStyle(eoFill: true))
      .frame(width: size, height: size)
  }
}

/// A task's mark, the diamond its phase colours.
private struct Diamond: View {
  let color: SkyColor

  var body: some View {
    Rectangle()
      .fill(Color(sky: color))
      .frame(width: 9, height: 9)
      .rotationEffect(.degrees(45))
  }
}
