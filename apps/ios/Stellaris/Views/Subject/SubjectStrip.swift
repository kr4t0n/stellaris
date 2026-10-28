import BoardKit
import SwiftUI

/// What a task's or a proposal's thread is about, in a strip above its messages: a task's plan as
/// segments, the stage it is at, who may hold it and who does, and whether it is a gate; or a
/// proposal's status and who decides it. A tap opens the plan or the charter, as Plan and Charter
/// in the bar do.
struct SubjectStrip: View {
  @Environment(AppModel.self) private var model
  let subject: Subject

  var body: some View {
    Button {
      model.inspecting = model.inspecting == id ? nil : id
    } label: {
      Group {
        switch subject {
        case .task(let task): TaskStrip(task: task)
        case .proposal(let proposal): ProposalStrip(proposal: proposal)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(MessageColor.island)
    .overlay(alignment: .bottom) {
      Rectangle().fill(MessageColor.line).frame(height: 1)
    }
    .accessibilityHint(hint)
    .accessibilityIdentifier(identifier)
  }

  private var id: String {
    switch subject {
    case .task(let task): task.id
    case .proposal(let proposal): proposal.id
    }
  }

  private var hint: String {
    switch subject {
    case .task: model.inspecting == id ? "Closes the plan" : "Shows the plan"
    case .proposal: model.inspecting == id ? "Closes the charter" : "Shows the charter"
    }
  }

  private var identifier: String {
    switch subject {
    case .task: "task-strip"
    case .proposal: "proposal-strip"
    }
  }
}

/// A task's plan as segments, the stage it is at with its gate, and its phase; then who may hold
/// the stage and who does, or how the task ended. At the accessibility sizes the phase goes under
/// the stage, which wraps in full.
private struct TaskStrip: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dynamicTypeSize) private var typeSize
  let task: BoardTask

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      PlanSegments(task: task)
      let line =
        typeSize.isAccessibilitySize
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
        : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
      line {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(stageLine)
            .font(MessageType.text(.medium))
            .foregroundStyle(MessageColor.primary)
            .fixedSize(horizontal: false, vertical: true)
          if task.currentStage?.gate == true {
            GateBadge()
          }
        }
        if !typeSize.isAccessibilitySize {
          Spacer(minLength: 0)
        }
        PhaseChip(phase: task.phase, status: task.status.rawValue)
      }
      TimelineView(.everyMinute) { context in
        if let meta = meta(now: context.date) {
          Text(meta)
            .font(MessageType.small())
            .foregroundStyle(MessageColor.tertiary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }

  /// "Stage 2 of 3 · Approve the design", or how far the task came.
  private var stageLine: String {
    guard let stage = task.currentStage else {
      return task.progress
    }
    return "\(task.progress) · \(stage.name)"
  }

  /// Who may hold the stage and who does, or since when it waits; a send-back; or how a landing
  /// ends.
  private func meta(now: Date) -> String? {
    guard let stage = task.currentStage else {
      return task.phase == .landing ? TaskWords.landing(task) : nil
    }
    var parts = ["for \(TaskWords.assignee(stage, model))"]
    if let holder = task.holder {
      parts.append("held by \(model.displayName(holder))")
    } else if task.status == .known(.open) {
      parts.append("waiting since \(BoardTime.ago(task.stageSince, now: now))")
    }
    if let back = task.returned {
      parts.append(
        "sent back from \(task.stageName(back.from)) by \(model.displayName(back.by)) \(BoardTime.ago(back.at, now: now))"
      )
    }
    return parts.joined(separator: " · ")
  }
}

/// A proposal's kind, who proposed it and when, and its status; then who decides it, or the
/// decision with its reason.
private struct ProposalStrip: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dynamicTypeSize) private var typeSize
  let proposal: Proposal

  var body: some View {
    TimelineView(.everyMinute) { context in
      VStack(alignment: .leading, spacing: 6) {
        let line =
          typeSize.isAccessibilitySize
          ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
          : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        line {
          Text(
            "\(proposal.kind.rawValue) proposal by \(model.displayName(proposal.proposedBy)) \(BoardTime.ago(proposal.createdAt, now: context.date))"
          )
          .font(MessageType.text(.medium))
          .foregroundStyle(MessageColor.primary)
          .fixedSize(horizontal: false, vertical: true)
          if !typeSize.isAccessibilitySize {
            Spacer(minLength: 0)
          }
          StatusChip(status: proposal.status)
        }
        Text(decision(now: context.date))
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private func decision(now: Date) -> String {
    guard proposal.status != .known(.proposed) else {
      let role = model.store.members.first { $0.name == proposal.proposedBy }?.role
      return "for \(decidersOf(proposal, proposerRole: role)) to decide"
    }
    let verdict = proposal.status == .known(.rejected) ? "Rejected" : "Approved"
    let when = proposal.decidedAt.map { " \(BoardTime.ago($0, now: now))" } ?? ""
    let why = proposal.reason.map { ": \($0)" } ?? "."
    return "\(verdict) by \(model.displayName(proposal.decidedBy ?? "someone"))\(when)\(why)"
  }
}

/// The words the task views use, shared by the strip and the plan.
enum TaskWords {
  /// Who may hold a stage, with the user named as the app names the user.
  @MainActor static func assignee(_ stage: Stage, _ model: AppModel) -> String {
    stage.agent.map { model.displayName($0) } ?? BoardKit.assignee(of: stage)
  }

  /// What a landing ends in: a merge onto the default branch, or the pull request's on GitHub.
  static func landing(_ task: BoardTask) -> String {
    switch task.onDone {
    case .known(.merge):
      return "task/\(task.id) merges onto the default branch"
    case .known(.ghpr):
      return task.pullRequest.map { "pull request #\($0.number) merges on GitHub" }
        ?? "its pull request merges on GitHub, once one is linked"
    default:
      return "nothing more"
    }
  }
}

/// A task's plan as a row of segments, as the web's `PlanStrip` draws it: done stages filled, the
/// current one lit, amber while it waits for a holder and white while held, the rest dim, and a
/// gate ringed in sky.
struct PlanSegments: View {
  let task: BoardTask

  var body: some View {
    HStack(spacing: 4) {
      ForEach(task.stages) { stage in
        Capsule()
          .fill(fill(stage))
          .frame(minWidth: 12, maxWidth: .infinity)
          .frame(height: 6)
          .overlay {
            if stage.gate {
              Capsule()
                .strokeBorder(TaskColor.gate.opacity(0.7), lineWidth: 1)
                .padding(-2)
            }
          }
      }
    }
    .padding(.horizontal, 2)
    .padding(.vertical, 2)
    .accessibilityHidden(true)
  }

  private func fill(_ stage: Stage) -> Color {
    if stage.completedBy != nil {
      return TaskColor.done.opacity(0.6)
    }
    if task.isCurrent(stage) {
      return task.status == .known(.claimed)
        ? MessageColor.primary.opacity(0.9) : TaskColor.waiting.opacity(0.8)
    }
    return task.phase == .abandoned ? MessageColor.surface2.opacity(0.5) : MessageColor.surface2
  }
}

/// A gate's badge, as the web's task view marks one.
struct GateBadge: View {
  var body: some View {
    Text("gate")
      .font(MessageType.chip())
      .foregroundStyle(TaskColor.gate)
      .padding(.horizontal, 6)
      .padding(.vertical, 1)
      .background(TaskColor.gateGround.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
  }
}

/// A task's phase as a chip, as the web's `PHASE_STYLE` colours it; a status the app doesn't know
/// shows as the board sent it.
struct PhaseChip: View {
  let phase: TaskPhase
  let status: String

  var body: some View {
    let tone = Self.tone(phase)
    Chip(
      words: phase == .unknown ? status : phase.label.lowercased(), tone: tone.text,
      ground: tone.ground)
  }

  static func tone(_ phase: TaskPhase) -> (text: Color, ground: Color) {
    switch phase {
    case .returned: (TaskColor.returned, TaskColor.returnedGround.opacity(0.15))
    case .waiting: (TaskColor.waiting, TaskColor.waitingGround.opacity(0.15))
    case .working: (TaskColor.working, TaskColor.workingGround.opacity(0.15))
    case .landing: (TaskColor.landing, TaskColor.landingGround.opacity(0.15))
    case .done: (MessageColor.secondary, MessageColor.surface2)
    case .abandoned, .unknown: (MessageColor.muted, MessageColor.surface2)
    }
  }
}

/// A proposal's status as a chip, as the web's `StatusChip` colours it: provisioned reads as
/// approved, since approval carried it out.
struct StatusChip: View {
  let status: OrUnknown<Proposal.Status>

  var body: some View {
    let tone: (text: Color, ground: Color) =
      switch status {
      case .known(.proposed): (TaskColor.waiting, TaskColor.waitingGround.opacity(0.15))
      case .known(.approved), .known(.provisioned):
        (TaskColor.working, TaskColor.workingGround.opacity(0.15))
      case .known(.rejected): (TaskColor.failed, TaskColor.failedGround.opacity(0.15))
      case .known(.retired), .unknown: (MessageColor.muted, MessageColor.surface2)
      }
    Chip(
      words: status == .known(.provisioned) ? "approved" : status.rawValue, tone: tone.text,
      ground: tone.ground)
  }
}

/// A rounded chip of small text on a tint.
private struct Chip: View {
  let words: String
  let tone: Color
  let ground: Color

  var body: some View {
    Text(words)
      .font(MessageType.chip(.medium))
      .foregroundStyle(tone)
      .lineLimit(1)
      .fixedSize()
      .padding(.horizontal, 8)
      .padding(.vertical, 2)
      .background(ground, in: Capsule())
  }
}

/// The web's colours for a task's phase, a plan's segments, a gate, and a proposal's status, from
/// `MessageTheme`: each chip's text, and the ground its tint is of.
enum TaskColor {
  static let waiting = Color(sky: MessageTheme.amber300)
  static let waitingGround = Color(sky: MessageTheme.amber500)
  static let working = Color(sky: MessageTheme.emerald300)
  static let workingGround = Color(sky: MessageTheme.emerald500)
  static let done = Color(sky: MessageTheme.emerald400)
  static let landing = Color(sky: MessageTheme.sky300)
  static let landingGround = Color(sky: MessageTheme.sky500)
  static let gate = Color(sky: MessageTheme.sky300)
  static let gateGround = Color(sky: MessageTheme.sky400)
  static let returned = Color(sky: MessageTheme.orange300)
  static let returnedGround = Color(sky: MessageTheme.orange500)
  static let failed = Color(sky: MessageTheme.red300)
  static let failedGround = Color(sky: MessageTheme.red500)
}
