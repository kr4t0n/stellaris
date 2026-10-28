import BoardKit
import SwiftUI

/// A new thread on a channel, as the web's New thread form opens one: its title and an optional
/// first message, then the thread in Chat. What it says is kept in the model by channel until it
/// opens or is cancelled, so a sheet dismissed or built again comes back with its text.
struct NewThreadSheet: View {
  @Environment(AppModel.self) private var model
  @FocusState private var titleFocused: Bool
  @State private var opening = false
  /// The board's reason for not opening it, in its own words.
  @State private var failure: String?
  let channel: String

  var body: some View {
    let draft = Binding(
      get: { model.newThreads[channel] ?? NewThreadDraft() },
      set: { model.newThreads[channel] = $0 })
    let title = draft.wrappedValue.title.trimmingCharacters(in: .whitespacesAndNewlines)
    NavigationStack {
      Form {
        Section {
          TextField("What is the thread about?", text: draft.title, axis: .vertical)
            .focused($titleFocused)
            .accessibilityIdentifier("thread-title")
          TextField("First message, optional", text: draft.body, axis: .vertical)
            .lineLimit(3...8)
            .accessibilityIdentifier("thread-first-message")
        }
        if let failure {
          Section {
            Text(failure)
              .foregroundStyle(MessageColor.failure)
              .accessibilityIdentifier("thread-failed")
          }
        }
      }
      .navigationTitle("New thread in \(model.name(of: .channel(channel)))")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button {
            model.newThreads[channel] = nil
            model.startingThread = nil
          } label: {
            Label("Cancel", systemImage: "xmark")
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            open()
          } label: {
            Label(opening ? "Opening…" : "Open thread", systemImage: "checkmark")
          }
          .disabled(title.isEmpty || opening)
          .accessibilityIdentifier("open-thread")
        }
      }
    }
    .onAppear { titleFocused = true }
  }

  private func open() {
    opening = true
    failure = nil
    Task {
      do {
        try await model.openThread(in: channel)
      } catch let refusal as BoardError where refusal.status != 0 {
        failure = refusal.message
      } catch {
        failure = "The board did not take it."
      }
      opening = false
    }
  }
}
