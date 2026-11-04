import BoardKit
import SwiftUI

/// The board's address, who the app is signed in as, and signing out.
struct SettingsView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      Form {
        Section("Board") {
          Text(model.board?.absoluteString ?? "")
            .textSelection(.enabled)
            .accessibilityIdentifier("settings-board")
        }
        Section("Signed in as") {
          if let actor = model.actor {
            LabeledContent(actor.signIn?.login ?? actor.name) {
              Text(actor.signIn == nil ? "Token" : "GitHub")
            }
            .accessibilityIdentifier("settings-actor")
          } else {
            Text(Loading.unreachable)
              .foregroundStyle(.secondary)
          }
        }
        Section {
          Button("Sign out", role: .destructive) {
            Task { await model.signOut() }
          }
          .accessibilityIdentifier("sign-out")
        }
      }
      .navigationTitle("Settings")
    }
    // No button: nothing here is saved, so a drag down closes it, which the grabber shows.
    .presentationDragIndicator(.visible)
  }
}
