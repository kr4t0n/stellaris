import CoreGraphics
import Foundation
import Testing

@testable import Stellaris

@Suite struct ChatHistoryTests {
  @Test func opensOnTheSocietysGeneralChannel() {
    let history = ChatHistory()
    #expect(history.current == .channel("general"))
    #expect(history.back(threadChannel: nil) == nil)
  }

  @Test func goesBackToWhereChatCameFrom() {
    var history = ChatHistory()
    history.open(.thread("t1"))
    history.open(.channel("demo/general"))
    history.open(.thread("t2"))
    #expect(history.back(threadChannel: "demo/general") == .channel("demo/general"))
    history.goBack(threadChannel: "demo/general")
    #expect(history.current == .channel("demo/general"))
    history.goBack(threadChannel: nil)
    #expect(history.current == .thread("t1"))
    history.goBack(threadChannel: "demo/general")
    #expect(history.current == .channel("general"))
    #expect(history.back(threadChannel: nil) == nil)
  }

  @Test func opensTheConversationShownAsNoStep() {
    var history = ChatHistory()
    history.open(.channel("general"))
    #expect(history.earlier.isEmpty)
    history.open(.thread("t1"))
    history.open(.thread("t1"))
    #expect(history.earlier == [.channel("general")])
  }

  @Test func sendsAThreadWithNothingBeforeItToItsChannel() {
    var history = ChatHistory(current: .thread("t1"))
    #expect(history.back(threadChannel: nil) == nil)
    #expect(history.back(threadChannel: "demo/general") == .channel("demo/general"))
    history.goBack(threadChannel: "demo/general")
    #expect(history.current == .channel("demo/general"))
    #expect(history.back(threadChannel: nil) == nil)
  }

  @Test func keepsFiftyStepsBack() {
    var history = ChatHistory()
    for number in 1...60 {
      history.open(.thread("t\(number)"))
    }
    #expect(history.earlier.count == ChatHistory.limit)
    #expect(history.earlier.first == .thread("t10"))
    #expect(history.earlier.last == .thread("t59"))
  }
}

@Suite struct BoardAddressTests {
  @Test func takesAHostAloneAsHTTPS() throws {
    #expect(try BoardAddress.parse(" Board.Example.com ").get().absoluteString == "https://board.example.com")
    #expect(
      try BoardAddress.parse("https://example.org:8443/stellaris/").get().absoluteString
        == "https://example.org:8443/stellaris")
  }

  @Test func refusesWhatIsNotABoardsHTTPSAddress() {
    #expect(BoardAddress.parse("  ") == .failure(.empty))
    #expect(BoardAddress.parse("http://board.example.com") == .failure(.notHTTPS))
    #expect(BoardAddress.parse("https://") == .failure(.invalid))
    #expect(BoardAddress.parse("https://board.example.com/?token=1") == .failure(.invalid))
    #expect(BoardAddress.parse("https://user:secret@board.example.com") == .failure(.invalid))
  }
}

@Suite struct SignInLayoutTests {
  private let inner = CGSize(width: 951, height: 669)

  @Test func centresTheFormWithNoFold() {
    #expect(SignInLayout.area(in: inner, divisions: []) == CGRect(origin: .zero, size: inner))
    #expect(SignInLayout.formWidth(in: 951) == 380)
    #expect(SignInLayout.formWidth(in: 320) == 288)
  }

  @Test func movesBesideAFoldThatRunsTopToBottom() {
    let fold = CGRect(x: 465, y: 0, width: 21, height: 669)
    #expect(
      SignInLayout.area(in: inner, divisions: [fold])
        == CGRect(x: 486, y: 0, width: 465, height: 669))
    let offCentre = CGRect(x: 520, y: 0, width: 20, height: 669)
    #expect(
      SignInLayout.area(in: inner, divisions: [offCentre])
        == CGRect(x: 0, y: 0, width: 520, height: 669))
  }

  @Test func movesAboveAFoldThatRunsAcross() {
    let portrait = CGSize(width: 669, height: 951)
    let fold = CGRect(x: 0, y: 465, width: 669, height: 21)
    #expect(
      SignInLayout.area(in: portrait, divisions: [fold])
        == CGRect(x: 0, y: 0, width: 669, height: 465))
  }

  @Test func ignoresAFoldOutsideTheView() {
    let elsewhere = CGRect(x: 1200, y: 0, width: 20, height: 669)
    #expect(SignInLayout.area(in: inner, divisions: [elsewhere]).width == 951)
  }
}

@MainActor @Suite struct ConversationMemoryTests {
  private let board = URL(string: "https://board.example.com")!

  @Test func keepsDraftsAndAnchorsByConversationAcrossALaunch() throws {
    let defaults = try #require(UserDefaults(suiteName: "memory-\(UUID().uuidString)"))
    let memory = ConversationMemory(board: board, defaults: defaults)
    memory.setDraft("Half a thought", for: .general)
    memory.setAnchor("m-12", for: .thread("t1"))
    #expect(memory.draft(.thread("t1")) == "")

    let relaunched = ConversationMemory(board: board, defaults: defaults)
    #expect(relaunched.draft(.general) == "Half a thought")
    #expect(relaunched.anchor(.thread("t1")) == "m-12")
    #expect(relaunched.anchor(.general) == nil)

    let other = ConversationMemory(board: URL(string: "https://other.example")!, defaults: defaults)
    #expect(other.draft(.general) == "")
  }

  @Test func forgetsEverythingOnSignOut() throws {
    let defaults = try #require(UserDefaults(suiteName: "memory-\(UUID().uuidString)"))
    let memory = ConversationMemory(board: board, defaults: defaults)
    memory.setDraft("Half a thought", for: .general)
    memory.setDraft("", for: .thread("t1"))
    memory.forget()
    #expect(ConversationMemory(board: board, defaults: defaults).draft(.general) == "")
  }
}

@Suite struct AttentionItemTests {
  @Test func showsAQuestionsFirstParagraphAsTheWebDoes() {
    #expect(
      AttentionItem.firstParagraph("# Title\n\nThe build is `green`. *Ship* it?\n\nMore.")
        == "The build is green. Ship it?")
    let long = String(repeating: "word ", count: 60)
    #expect(AttentionItem.firstParagraph(long).count == 160)
    #expect(AttentionItem.firstParagraph(long).hasSuffix("…"))
  }
}
