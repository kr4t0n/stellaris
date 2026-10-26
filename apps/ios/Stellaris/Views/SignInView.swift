import AuthenticationServices
import BoardKit
import SwiftUI

/// Signing in: the board's address, then GitHub, on a board that takes the app's sign-in and whose
/// host this build names, or a token pasted from the board.
struct SignInView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var address = ""
  @State private var token = ""
  /// The board whose address was taken, and how it lets people in.
  @State private var board: (url: URL, config: AuthConfig)?
  @State private var busy = false
  @State private var problem: String?

  /// Sign-in, or with `checked` its second step, for a board whose address was already taken.
  init(checked: (url: URL, config: AuthConfig)? = nil) {
    _board = State(initialValue: checked)
  }

  var body: some View {
    GeometryReader { proxy in
      let area = SignInLayout.area(in: proxy.size, divisions: folds(proxy))
      ScrollView {
        form
          .frame(width: SignInLayout.formWidth(in: area.width))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 32)
      }
      .scrollBounceBehavior(.basedOnSize)
      .frame(width: area.width, height: area.height)
      .position(x: area.midX, y: area.midY)
    }
    .onAppear {
      if address.isEmpty, let last = model.board {
        address = last.absoluteString
      }
    }
  }

  /// The folds across the view, which only iOS 27.1 reports.
  private func folds(_ proxy: GeometryProxy) -> [CGRect] {
    if #available(iOS 27.1, *) {
      return proxy.reservedRegions(kind: .division).map(\.frame)
    }
    return []
  }

  private var form: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Stellaris")
        .font(.largeTitle.bold())
        .accessibilityAddTraits(.isHeader)
      if let board {
        options(board.url, board.config)
      } else {
        addressStep
      }
      if let problem {
        Text(problem)
          .font(.callout)
          .foregroundStyle(.red)
          .accessibilityIdentifier("sign-in-problem")
      } else if let notice = model.notice {
        Text(notice)
          .font(.callout)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("sign-in-notice")
      }
    }
    .disabled(busy)
  }

  private var addressStep: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("Board address", text: $address)
        .textFieldStyle(.roundedBorder)
        .keyboardType(.URL)
        .textContentType(.URL)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.continue)
        .onSubmit(takeAddress)
        .accessibilityIdentifier("address")
      Button(action: takeAddress) {
        Text("Continue").frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("take-address")
    }
  }

  private func options(_ url: URL, _ config: AuthConfig) -> some View {
    // The board and Change side by side, or one above the other at the accessibility sizes.
    let accessible = typeSize.isAccessibilitySize
    let row =
      accessible
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
    return VStack(alignment: .leading, spacing: 12) {
      row {
        Text(url.host() ?? url.absoluteString)
          .font(.headline)
          .lineLimit(accessible ? 3 : 2)
          .truncationMode(.middle)
          .accessibilityIdentifier("board-host")
        if !accessible {
          Spacer()
        }
        Button("Change") {
          board = nil
          problem = nil
        }
        .fixedSize()
      }
      if offersGitHub(url, config) {
        Button {
          Task { await signInWithGitHub(url) }
        } label: {
          Label("Sign in with GitHub", systemImage: "person.badge.key")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("sign-in-github")
      }
      SecureField("Token", text: $token)
        .textFieldStyle(.roundedBorder)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.go)
        .onSubmit { Task { await signInWithToken(url) } }
        .accessibilityIdentifier("token")
      Button {
        Task { await signInWithToken(url) }
      } label: {
        Text("Sign in with the token").frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .disabled(token.isEmpty)
      .accessibilityIdentifier("sign-in-token")
    }
  }

  /// GitHub is offered where the board takes the app's sign-in and the build names its host, since
  /// iOS hands the landing only to an app associated with the host it is on.
  private func offersGitHub(_ url: URL, _ config: AuthConfig) -> Bool {
    config.github && config.appLanding && url.host() != nil
      && url.host() == model.environment.gitHubHost
  }

  private func takeAddress() {
    switch BoardAddress.parse(address) {
    case .failure(.empty):
      problem = "Enter the board's address."
    case .failure(.notHTTPS):
      problem = "The board's address must start with https://."
    case .failure(.invalid):
      problem = "That isn't a board's address."
    case .success(let url):
      problem = nil
      busy = true
      Task {
        defer { busy = false }
        do {
          let config = try await BoardClient.authConfig(
            board: url, session: model.environment.session)
          board = (url, config)
        } catch {
          // The address stays, to be corrected or tried again.
          problem = Loading.unreachable + "."
        }
      }
    }
  }

  private func signInWithToken(_ url: URL) async {
    let pasted = token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !pasted.isEmpty else {
      return
    }
    busy = true
    defer { busy = false }
    do {
      try await model.signIn(board: url, token: pasted)
    } catch {
      problem = describe(error)
    }
  }

  private func signInWithGitHub(_ url: URL) async {
    guard let host = url.host() else {
      return
    }
    busy = true
    defer { busy = false }
    let verifier = AppSignIn.makeVerifier()
    let start = BoardAPI.appSignIn(challenge: AppSignIn.challenge(for: verifier))
      .urlRequest(board: url, token: nil)
    guard let address = start.url else {
      return
    }
    do {
      let landed = try await webAuthenticationSession.authenticate(
        using: address, callback: .https(host: host, path: AppSignIn.landingPath),
        preferredBrowserSession: .shared, additionalHeaderFields: [:])
      switch AppSignIn.landing(landed) {
      case .code(let code):
        let session = try await BoardClient.appSession(
          board: url, code: code, verifier: verifier, session: model.environment.session)
        try await model.signIn(board: url, token: session)
      case .refused(let reason):
        problem = SignInView.refusal(reason)
      case nil:
        problem = "GitHub's sign-in ended somewhere the app doesn't know."
      }
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      return
    } catch {
      problem = describe(error)
    }
  }

  /// The board's reason for turning a GitHub sign-in away, in words.
  static func refusal(_ reason: String) -> String {
    switch reason {
    case "declined": "The sign-in was declined on GitHub."
    case "not-allowed": "This GitHub account isn't one the board lets in."
    case "github": "GitHub didn't answer the board. Try again."
    default: "The board turned the sign-in away (\(reason))."
    }
  }

  private func describe(_ error: any Error) -> String {
    if let failure = error as? SignInFailure {
      switch failure {
      case .refused: return "The board doesn't take this token."
      case .keychain: return "The token couldn't be kept on this device."
      case .unreachable: break
      }
    }
    if let refusal = error as? BoardError, refusal.code == "invalid_grant" {
      return "The sign-in took too long to finish. Try again."
    }
    return Loading.unreachable + "."
  }
}
