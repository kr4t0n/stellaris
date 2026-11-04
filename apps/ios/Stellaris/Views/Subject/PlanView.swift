import BoardKit
import SwiftUI

/// A task's plan as the web's task view lays it out: a send-back, each stage on a timeline with who
/// may hold it, who holds or held it, and when it was done, what happens once the last stage is
/// done and what the task waits on, then its brief and its pull request. It opens beside the
/// task's thread, or in a sheet where there is no room beside it.
struct PlanView: View {
  @Environment(AppModel.self) private var model
  let task: BoardTask

  var body: some View {
    TimelineView(.everyMinute) { context in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          SectionTitle("Plan")
          if let back = task.returned {
            Text(
              "Sent back from \(task.stageName(back.from)) by \(model.displayName(back.by)) \(BoardTime.ago(back.at, now: context.date))."
            )
            .font(MessageType.small())
            .foregroundStyle(TaskColor.returned)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TaskColor.returnedGround.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            .padding(.top, 8)
          }
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(task.stages.enumerated()), id: \.element.id) { index, stage in
              StageItem(
                task: task, stage: stage, index: index, last: index == task.stages.count - 1,
                now: context.date)
            }
          }
          .padding(.top, 12)
          Text(ending)
            .font(MessageType.small())
            .foregroundStyle(MessageColor.tertiary)
            .fixedSize(horizontal: false, vertical: true)
          if !task.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Divider().overlay(MessageColor.line).padding(.vertical, 16)
            SectionTitle("Brief")
            MessageBody(document: model.document(id: "brief:\(task.id)", markdown: task.body))
              .padding(.top, 8)
          }
          if let link = task.pullRequest {
            Divider().overlay(MessageColor.line).padding(.vertical, 16)
            PullRequestSection(task: task, link: link, now: context.date)
          }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(MessageColor.island)
    .accessibilityIdentifier("plan-\(task.id)")
  }

  /// What happens once the last stage is done, and what the task waits on.
  private var ending: String {
    var line = "When the last stage is done: "
    switch task.onDone {
    case .known(.merge): line += "task/\(task.id) merges onto the default branch"
    case .known(.ghpr):
      line += task.pullRequest.map { "pull request #\($0.number) merges on GitHub" }
        ?? "its pull request merges on GitHub, once one is linked"
    case .known(.none): line += "nothing more"
    case .unknown(let effect): line += effect
    }
    if !task.blockedBy.isEmpty {
      line += " · blocked by \(model.store.titled(task.blockedBy.joined(separator: ", ")))"
    }
    return line
  }
}

/// A heading of the plan or the charter, as the web's `text-section`.
struct SectionTitle: View {
  let words: String

  init(_ words: String) {
    self.words = words
  }

  var body: some View {
    Text(words)
      .font(MessageType.text(.semibold))
      .foregroundStyle(MessageColor.primary)
      .accessibilityAddTraits(.isHeader)
  }
}

/// A stage on the plan's timeline: a tick once done, its number otherwise, lit while current; its
/// name with its gate; and who may hold it, who holds it, when it was done or since when it waits,
/// who held it before, and a send-back from it.
private struct StageItem: View {
  @Environment(AppModel.self) private var model
  @ScaledMetric(relativeTo: .caption) private var dot: CGFloat = 20
  let task: BoardTask
  let stage: Stage
  let index: Int
  let last: Bool
  let now: Date

  var body: some View {
    let done = stage.completedBy != nil
    let current = task.isCurrent(stage)
    HStack(alignment: .top, spacing: 12) {
      Text(done ? "✓" : "\(index + 1)")
        .font(.system(size: 10 * dot / 20, weight: .medium))
        .foregroundStyle(
          done ? TaskColor.working : current ? MessageColor.surface0 : MessageColor.muted
        )
        .frame(width: dot, height: dot)
        .background(
          done
            ? TaskColor.done.opacity(0.2) : current ? MessageColor.primary : MessageColor.surface2,
          in: Circle()
        )
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(stage.name)
            .font(MessageType.text(current ? .medium : .regular))
            .foregroundStyle(current ? MessageColor.primary : MessageColor.secondary)
            .fixedSize(horizontal: false, vertical: true)
          if stage.gate {
            GateBadge()
          }
        }
        Text(meta(current: current))
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.bottom, 16)
    }
    // The timeline's rule, from under the stage's dot down to the next stage's.
    .background(alignment: .topLeading) {
      if !last {
        Rectangle().fill(MessageColor.line)
          .frame(width: 1)
          .padding(.top, dot + 4)
          .padding(.leading, dot / 2 - 0.5)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(done ? "Done" : current ? "Current" : "Stage \(index + 1)"): \(stage.name)\(stage.gate ? ", gate" : ""). \(meta(current: current))"
    )
    .accessibilityIdentifier("stage-\(stage.id)")
  }

  private func meta(current: Bool) -> String {
    // `holders` is everyone who ever held the stage; only the current stage has a holder now.
    let holder = current ? task.holder : nil
    var line = "for \(TaskWords.assignee(stage, model))"
    if let holder {
      line += " · held by \(model.displayName(holder))"
    }
    if let by = stage.completedBy, let at = stage.completedAt {
      line += " · done by \(model.displayName(by)) \(BoardTime.ago(at, now: now))"
    } else if current, task.status == .known(.open) {
      line += " · waiting since \(BoardTime.ago(task.stageSince, now: now))"
    }
    let earlier = stage.holders.filter { $0 != holder && $0 != stage.completedBy }
    if !earlier.isEmpty {
      line += " · held before by \(earlier.map { model.displayName($0) }.joined(separator: ", "))"
    }
    if let back = task.returned, back.from == stage.id {
      line += " · sent back by \(model.displayName(back.by)) \(BoardTime.ago(back.at, now: now))"
    }
    return line
  }
}

/// A task's pull request, and the merge commit the board will make of it.
private struct PullRequestSection: View {
  @Environment(AppModel.self) private var model
  let task: BoardTask
  let link: PullRequestLink
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionTitle("Pull request")
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        if let address = URL(string: link.url) {
          Link("#\(link.number) on GitHub", destination: address)
            .font(MessageType.text())
            .foregroundStyle(MessageColor.primary)
            .underline()
        }
        Text("linked by \(model.displayName(link.linkedBy)) \(BoardTime.ago(link.linkedAt, now: now))")
          .font(MessageType.small())
          .foregroundStyle(MessageColor.tertiary)
      }
      if task.status != .known(.abandoned) {
        Text("Merges as")
          .font(MessageType.small(.medium))
          .foregroundStyle(MessageColor.muted)
          .textCase(.uppercase)
        Text(
          [link.subject ?? "The pull request's title", link.body ?? ""]
            .filter { !$0.isEmpty }.joined(separator: "\n\n")
        )
        .font(MessageType.code)
        .foregroundStyle(MessageColor.secondary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MessageColor.surface2.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .textSelection(.enabled)
      }
    }
  }
}
