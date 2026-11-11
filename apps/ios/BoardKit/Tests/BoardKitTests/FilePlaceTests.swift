import Foundation
import Testing

@testable import BoardKit

/// A file's place on the board as the web's address names it, and a file's markdown read with its
/// relative links beside it.
@Suite struct FilePlaceTests {
  static let task = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

  @Test func writesTheWebsAddressForEachPlace() {
    let task = FilePlaceTests.task
    #expect(FilePlace(source: .task(task), path: "").href == "/task/\(task)/files")
    #expect(
      FilePlace(source: .task(task), path: "evidence/plot.png").href
        == "/task/\(task)/files/evidence/plot.png")
    #expect(FilePlace(source: .project("demo"), path: "", line: nil).href == "/p/demo/files")
    #expect(
      FilePlace(source: .project("demo"), path: "src/app.ts", line: 12).href
        == "/p/demo/files/src/app.ts?line=12")
    // A segment keeps its own `?`, `#`, `%`, and spaces, encoded, so the address names it whole.
    #expect(
      FilePlace(source: .project("demo"), path: "a b/c?d#e%f.md").href
        == "/p/demo/files/a%20b/c%3Fd%23e%25f.md")
  }

  @Test(arguments: [
    FilePlace(source: .task(FilePlaceTests.task), path: ""),
    FilePlace(source: .task(FilePlaceTests.task), path: "evidence/plot.png", line: 3),
    FilePlace(source: .project("demo"), path: ""),
    FilePlace(source: .project("lab-2"), path: "docs/plan.md", line: 120),
    FilePlace(source: .project("demo"), path: "a b/c?d#e%f.md"),
    FilePlace(source: .project("demo"), path: "Ärende/e\u{301}.md/😀"),
    FilePlace(source: .project("demo"), path: ".github/workflows/ci.yml"),
  ])
  func readsBackWhatItWrites(_ place: FilePlace) throws {
    let read = try #require(FilePlace(href: place.href))
    #expect(read == place)
    // Byte for byte, since Swift's `==` takes a decomposed accent for the composed one.
    #expect(Array(read.path.utf16) == Array(place.path.utf16))
  }

  @Test(arguments: [
    "/task/demo/files",
    "/task/01ARZ3NDEKTSV4RRFFQ69G5FAV/file",
    "/task/01ARZ3NDEKTSV4RRFFQ69G5FAV/filesx",
    "/task/01ARZ3NDEKTSV4RRFFQ69G5FAV/files/",
    "/p/Demo/files",
    "/p/demo/files/../x",
    "/p/demo/files/a/%2E%2E/b",
    "/p/demo/files/a%2Fb",
    "/p/demo/files/%E0%A4%A",
    "/p/demo/files//a",
    "/c/demo/general",
    "/thread/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "p/demo/files",
  ])
  func readsNoOtherAddress(_ href: String) {
    #expect(FilePlace(href: href) == nil)
  }

  @Test func readsTheCitedLineAlone() {
    let base = "/p/demo/files/app.ts"
    #expect(FilePlace(href: base + "?line=12")?.line == 12)
    #expect(FilePlace(href: base + "?x=1&line=7")?.line == 7)
    #expect(FilePlace(href: base + "?line=0")?.line == nil)
    #expect(FilePlace(href: base + "?line=a")?.line == nil)
    #expect(FilePlace(href: base)?.line == nil)
  }

  @Test func namesItsLastSegmentOrFiles() {
    #expect(FilePlace(source: .project("demo"), path: "").name == "Files")
    #expect(FilePlace(source: .project("demo"), path: "docs").name == "docs")
    #expect(FilePlace(source: .project("demo"), path: "docs/plan.md").name == "plan.md")
  }

  @Test func readsAFilesRelativeLinksAndImagesBesideIt() {
    let base = FileBase(source: .project("demo"), dir: "docs")
    let document = MessageDocument(
      markdown: "[plan](plan.md:4) [up](../README.md) [out](../../x) ![plot](img/plot.png)",
      base: base)
    guard case .paragraph(let inlines) = document.blocks.first else {
      Issue.record("no paragraph")
      return
    }
    let links = inlines.compactMap { inline -> MessageLink? in
      if case .run(let run) = inline { run.link } else { nil }
    }
    #expect(
      links == [
        .file(source: .project("demo"), path: "docs/plan.md", line: 4),
        .file(source: .project("demo"), path: "README.md", line: nil),
      ])
    let images = inlines.compactMap { inline -> MessageImage? in
      if case .image(let image) = inline { image } else { nil }
    }
    #expect(images.map(\.source) == [.file(source: .project("demo"), path: "docs/img/plot.png")])
    // In a message, with no file around it, the same link is a path on a machine.
    let message = MessageDocument(markdown: "[plan](plan.md)")
    guard case .paragraph(let plain) = message.blocks.first, case .run(let run) = plain.first else {
      Issue.record("no run")
      return
    }
    #expect(run.link == nil)
  }
}
