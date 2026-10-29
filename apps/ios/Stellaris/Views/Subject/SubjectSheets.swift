import BoardKit
import SwiftUI

/// Finishing a stage that waits on the user, as the web's form at that stage does: the stage, and
/// an optional note for the task's thread. What the note says, whether the advance is on its way,
/// and why it didn't go live in the model by task, so a sheet dismissed or built again keeps them.
struct AdvanceSheet: View {
  @Environment(AppModel.self) private var model
  @FocusState private var focused: Bool
  let taskId: String

  var body: some View {
    let note = Binding(
      get: { model.advanceNotes[taskId] ?? "" },
      set: { model.advanceNotes[taskId] = $0 })
    let task = model.store.task(taskId)
    let stage = task.flatMap(stageForYou)
    let sending = model.underWay.contains(taskId)
    NavigationStack {
      Form {
        Section {
          if let task, let stage {
            Text(waits(task, stage))
              .accessibilityIdentifier("advance-stage")
          }
          TextField("A note for the thread, if any", text: note, axis: .vertical)
            .lineLimit(2...6)
            .focused($focused)
            .accessibilityIdentifier("advance-note")
        }
        if let failure = model.refusals[taskId] {
          Section {
            Text(failure)
              .foregroundStyle(MessageColor.failure)
              .accessibilityIdentifier("advance-failed")
          }
        }
      }
      .navigationTitle(stage.map { "Finish \($0.name)" } ?? "Finish the stage")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button {
            model.advanceNotes[taskId] = nil
            model.advancing = nil
          } label: {
            Label("Cancel", systemImage: "xmark")
          }
          .accessibilityIdentifier("advance-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            send()
          } label: {
            Label(sending ? "Advancing…" : "Advance", systemImage: "checkmark")
          }
          .disabled(sending || stage == nil)
          .accessibilityIdentifier("advance-confirm")
        }
      }
    }
    .onAppear { focused = true }
  }

  /// "Approve the design waits on you.", and that the board refuses a last stage of a task landing
  /// through a pull request while none is linked.
  private func waits(_ task: BoardTask, _ stage: Stage) -> String {
    let last = task.stages.last?.id == stage.id
    let unlinked = last && task.onDone == .known(.ghpr) && task.pullRequest == nil
    return "\(stage.name) waits on you.\(unlinked ? " No pull request linked yet." : "")"
  }

  /// Sends the advance; the model keeps whether it is on its way and why it didn't go.
  private func send() {
    Task { try? await model.advance(taskId) }
  }
}

/// Approving or rejecting a proposal that waits on the user, as the web's decision bar does: a
/// reason, which a rejection needs, then the decision. What the reason says lives in the model by
/// proposal and choice until the proposal is decided or the reason cancelled, and whether the
/// decision is on its way and why it didn't go by proposal.
struct DecisionSheet: View {
  @Environment(AppModel.self) private var model
  @FocusState private var focused: Bool
  let verdict: Verdict

  var body: some View {
    let reason = Binding(
      get: { model.reasons[verdict] ?? "" },
      set: { model.reasons[verdict] = $0 })
    let approving = verdict.choice == .approve
    let missing =
      !approving && reason.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let sending = model.underWay.contains(verdict.proposal)
    NavigationStack {
      Form {
        Section {
          if let proposal = model.store.proposal(verdict.proposal) {
            Text(model.store.titled(proposal.title))
              .accessibilityIdentifier("decision-proposal")
          }
          TextField(
            approving ? "Why approve? Optional." : "Why not?", text: reason, axis: .vertical
          )
          .lineLimit(2...6)
          .focused($focused)
          .accessibilityIdentifier("decision-reason")
        }
        if let failure = model.refusals[verdict.proposal] {
          Section {
            Text(failure)
              .foregroundStyle(MessageColor.failure)
              .accessibilityIdentifier("decision-failed")
          }
        }
      }
      .navigationTitle(approving ? "Approve" : "Reject")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button {
            model.reasons[verdict] = nil
            model.deciding = nil
          } label: {
            Label("Cancel", systemImage: "xmark")
          }
          .accessibilityIdentifier("decision-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            send()
          } label: {
            Label(
              sending ? "Deciding…" : approving ? "Approve" : "Reject",
              systemImage: approving ? "checkmark.seal" : "xmark.seal")
          }
          .disabled(sending || missing)
          .accessibilityIdentifier("decision-confirm")
        }
      }
    }
    .onAppear { focused = true }
  }

  /// Sends the decision; the model keeps whether it is on its way and why it didn't go.
  private func send() {
    Task { try? await model.decide(verdict) }
  }
}
