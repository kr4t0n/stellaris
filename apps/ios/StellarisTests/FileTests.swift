import BoardKit
import Foundation
import Testing

@testable import Stellaris

/// A branch's files over the fake board: a link to one opens in the app, a read of each kind and
/// the board's refusals, Chat's file sheet, and what an event reads again.
@MainActor @Suite(.serialized) struct FileTests {
  private let task = "00000000000000000000000010"
  private let root = FilePlace(source: .project("demo"), path: "")

  private func signedIn(token: String = "fixture-token") async throws -> AppModel {
    let (model, _) = fakeApp()
    await model.start()
    try await model.signIn(board: FakeBoard.address, token: token)
    try await waitUntilLoaded(model)
    return model
  }

  @Test func aLinkToAFileOnABranchOpensInTheApp() async throws {
    let model = try await signedIn()
    let notes = try #require(URL(string: "/task/\(task)/files/evidence/notes.md"))
    #expect(
      model.follow(notes) == .file(FilePlace(source: .task(task), path: "evidence/notes.md")))
    let code = try #require(URL(string: "/p/demo/files/src/app.ts?line=30"))
    let cited = FilePlace(source: .project("demo"), path: "src/app.ts", line: 30)
    #expect(model.follow(code) == .file(cited))
    #expect(model.follow(try #require(URL(string: "/p/demo/files"))) == .file(root))
    // A cron's page is still the board's, in Safari.
    let cron = try #require(URL(string: "/crons?cron=\(task)"))
    let page = try #require(URL(string: "https://board.example.com/crons?cron=\(task)"))
    #expect(model.follow(cron) == .safari(page))
  }

  @Test func readsAFolderAFileAndWhatTheBoardRefuses() async throws {
    let model = try await signedIn()
    await model.store.loadBranchFile(root, using: model)
    #expect(model.store.branchFileState(root) == .loaded)
    let entries = entriesInOrder(model.store.branchFile(root)?.entries ?? []).map(\.name)
    #expect(Array(entries.prefix(3)) == [".github", "docs", "src"])
    #expect(entries.contains("README.md") && entries.contains("dump.json"))

    // A cited line reads the file it is in, kept with no line.
    let code = FilePlace(source: .project("demo"), path: "src/app.ts", line: 30)
    await model.store.loadBranchFile(code, using: model)
    let file = try #require(model.store.branchFile(code))
    #expect(file.kind == .known(.file))
    // Decoded once as the answer landed, for the view to draw with no work of its own.
    let shown = try #require(model.store.shownFile(code))
    guard case .text? = shown.view else {
      Issue.record("the code isn't text")
      return
    }
    #expect(shown.lines.count == 80)
    #expect(shown.lines[29].hasPrefix("export function exportChannel"))
    #expect(shown.data == file.data)

    let large = FilePlace(source: .project("demo"), path: "dump.json")
    await model.store.loadBranchFile(large, using: model)
    #expect(model.store.branchFile(large)?.content == nil)
    #expect(model.store.branchFile(large)?.size == 12_686_643)
    #expect(model.store.shownFile(large)?.view == nil)

    let missing = FilePlace(source: .project("demo"), path: "notes/plan.md")
    await model.store.loadBranchFile(missing, using: model)
    #expect(model.store.branchFileState(missing) == .missing)
    #expect(model.store.branchFile(missing) == nil)

    let away = try await signedIn(token: "runner-away")
    await away.store.loadBranchFile(root, using: away)
    #expect(away.store.branchFileState(root) == .away)
    // The project names the runner it lives on, which the view says is away.
    #expect(runnerOf(away.store.projects.first) == "runner-1, the runner Demo lives on")

    let empty = try await signedIn(token: "empty-branch")
    await empty.store.loadBranchFile(root, using: empty)
    #expect(empty.store.branchFile(root)?.entries == [])
  }

  @Test func chatsFileSheetKeepsItsStackUntilSignOut() async throws {
    let model = try await signedIn()
    let notes = FilePlace(source: .task(task), path: "evidence/notes.md")
    model.browse(notes)
    model.browsing?.path.append(.files(FilePlace(source: .task(task), path: "evidence/plot.png")))
    #expect(model.browsing?.root == notes)
    #expect(model.browsing?.path.count == 1)
    // Another link opens in its place.
    model.browse(root)
    #expect(model.browsing == FileBrowse(root: root))
    model.boardPath = [.project("demo"), .files(root)]
    await model.signOut()
    #expect(model.browsing == nil)
    #expect(model.boardPath.isEmpty)
  }

  @Test func anEventReadsAgainTheFilesAViewShows() async throws {
    let model = try await signedIn()
    let shown = FilePlace(source: .project("demo"), path: "README.md")
    let hidden = FilePlace(source: .project("demo"), path: "results.csv")
    let other = FilePlace(source: .task(task), path: "evidence/notes.md")
    model.store.showing(shown, true)
    model.store.showing(other, true)
    await model.reread([["project-file", "demo"]])
    #expect(model.store.branchFile(shown) != nil)
    #expect(model.store.branchFile(hidden) == nil)
    #expect(model.store.branchFile(other) == nil, "a project's event read a task's branch")
    model.store.showing(shown, false)
    #expect(model.store.branchFilesShown[shown] == nil)
  }

  private struct ConfigureInput: Encodable {
    let project: String
    let defaultBranch: String

    enum CodingKeys: String, CodingKey {
      case project
      case defaultBranch = "default_branch"
    }
  }

  @Test func aNewDefaultBranchIsReadAfreshWhenItsEventLands() async throws {
    let model = try await signedIn(token: "configure-\(UUID().uuidString)")
    model.store.showing(root, true)
    await model.store.loadBranchFile(root, using: model)
    #expect(model.store.branchFile(root)?.entries?.contains { $0.name == "src" } == true)

    // The web's Edit makes another branch the project's default, and the board logs it.
    let configure: BoardRequest<Project> = try BoardAPI.verb(
      "configure_project", ConfigureInput(project: "demo", defaultBranch: "trunk"))
    _ = try await model.send(configure)
    let logged = #"""
      {"id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "ts": "2026-01-01T00:00:00.000Z",
       "type": "project.configured", "actor": "user", "payload": {"project": "demo"}}
      """#
    let event = try JSONDecoder().decode(BoardEvent.self, from: Data(logged.utf8))
    await model.reread(Set(staleKeys(for: event)))

    // The event makes the projects stale and no file, and the new branch's tree is read for the
    // view that shows the root, not the old branch's kept under the new name.
    #expect(model.store.projects.first { $0.slug == "demo" }?.defaultBranch == "trunk")
    #expect(model.store.branchFileState(root) == .loaded)
    #expect(model.store.branchFile(root)?.entries?.map(\.name) == ["NOTES.md"])
  }
}
