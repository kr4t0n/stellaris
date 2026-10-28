import SwiftUI

@main
struct StellarisApp: App {
  @State private var model = AppModel(environment: StellarisApp.environment)

  var body: some Scene {
    WindowGroup {
      if StellarisApp.hostsUnitTests {
        // The unit tests host their own views in windows of their own.
        Color.clear
      } else {
        RootView()
          .environment(model)
      }
    }
  }

  private static var environment: AppEnvironment {
    #if DEBUG
      if let fake = FakeBoard.launched() {
        return fake
      }
    #endif
    return .live
  }

  private static var hostsUnitTests: Bool {
    #if DEBUG
      ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    #else
      false
    #endif
  }
}
