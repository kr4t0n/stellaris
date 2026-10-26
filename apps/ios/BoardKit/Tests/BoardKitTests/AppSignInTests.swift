import Foundation
import Testing

@testable import BoardKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// The app's sign-in with GitHub, against what the board sent in the fixtures and RFC 7636's own
/// example.
@Suite struct AppSignInTests {
  /// The 32 octets of RFC 7636's example in its appendix B.
  private static let exampleOctets: [UInt8] = [
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
    105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
  ]

  @Test func writesBytesAsPKCEsBase64url() throws {
    // The verifier the board took when the fixtures were captured is the example's octets.
    let verifier = try Fixture("app-token").field("code_verifier")
    #expect(AppSignIn.base64url(AppSignInTests.exampleOctets) == verifier)
    #expect(AppSignIn.base64url([0xfb, 0xff]) == "-_8")
  }

  @Test func makesAFreshVerifierOfFortyThreeCharacters() {
    let verifiers = (0..<8).map { _ in AppSignIn.makeVerifier() }
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    for verifier in verifiers {
      #expect(verifier.count == 43)
      #expect(verifier.allSatisfy(allowed.contains))
    }
    #expect(Set(verifiers).count == verifiers.count)
  }

  @Test func readsOnlyTheLandingsAddress() {
    let landing = { (address: String) in AppSignIn.landing(URL(string: address)!) }
    #expect(landing("https://board.example/auth/app/signin#code=a%2Bb") == .code("a+b"))
    #expect(
      landing("https://board.example/auth/app/signin#signin-error=declined")
        == .refused("declined"))
    #expect(landing("https://board.example/auth/app/signin") == nil)
    #expect(landing("https://board.example/auth/app/signin#code=") == nil)
    #expect(landing("https://board.example/#code=abc") == nil)
    #expect(landing("https://board.example/auth/app/signin/more#code=abc") == nil)
  }

  @Test func startsInTheBrowserWithTheChallengeAndNoToken() throws {
    let board = try #require(URL(string: "https://example.org/stellaris/"))
    let request = BoardAPI.appSignIn(challenge: "abc-_").urlRequest(board: board, token: "secret")
    #expect(
      request.url?.absoluteString
        == "https://example.org/stellaris/auth/github?landing=app&code_challenge=abc-_&code_challenge_method=S256"
    )
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
  }

  @Test func tradesTheCodeWithoutAToken() throws {
    let board = try #require(URL(string: "https://board.example"))
    let request = BoardAPI.appToken(code: "c", verifier: "v").endpoint
      .urlRequest(board: board, token: "secret")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    let body = try #require(request.httpBody)
    #expect(String(decoding: body, as: UTF8.self) == #"{"code":"c","code_verifier":"v"}"#)
  }

  @Test func readsABoardThatDoesNotSayWhetherItTakesTheApp() throws {
    let config = try JSONDecoder().decode(AuthConfig.self, from: Data(#"{"github":true}"#.utf8))
    #expect(config.github && !config.appLanding)
  }

  #if canImport(CryptoKit)
    /// The challenge the board checked the verifier against when the fixtures were captured.
    @Test func challengesAsTheBoardChecks() throws {
      let verifier = try Fixture("app-token").field("code_verifier")
      let path = try Fixture("app-sign-in").path
      let query = try #require(URLComponents(string: path)?.queryItems)
      let challenge = try #require(query.first { $0.name == "code_challenge" }?.value)
      #expect(AppSignIn.challenge(for: verifier) == challenge)
      #expect(
        AppSignIn.challenge(for: AppSignIn.base64url(AppSignInTests.exampleOctets))
          == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
  #endif
}
