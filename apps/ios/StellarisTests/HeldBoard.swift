import Foundation
import Synchronization

@testable import Stellaris

/// The fake board, with the requests a gate's token makes to the paths it names held until the test
/// settles them, so a test can sign out, or in again, while an answer is on its way. Each test makes
/// a gate of its own, with a token of its own, since tests run in parallel.
final class HeldBoard: URLProtocol {
  /// One test's held requests.
  final class Gate: Sendable {
    let token = "held-\(UUID().uuidString)"
    let paths: Set<String>
    /// The fake board, with this gate in front of it.
    let session: URLSession
    private let state = Mutex(State())

    private struct State {
      var arrived = 0
      var held: [Held] = []
      var waiting: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
    }

    init(paths: Set<String>) {
      self.paths = paths
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [HeldBoard.self, FakeBoard.self]
      session = URLSession(configuration: configuration)
      HeldBoard.gates.withLock { $0[token] = self }
    }

    /// How many requests in all have come to the gate.
    var arrived: Int { state.withLock { $0.arrived } }

    /// Returns once `count` requests in all have come to the gate.
    func arrivals(_ count: Int) async {
      await withCheckedContinuation { continuation in
        let arrived = state.withLock { state in
          if state.arrived < count {
            state.waiting.append((count, continuation))
            return false
          }
          return true
        }
        if arrived {
          continuation.resume()
        }
      }
    }

    /// Answers the requests held so far as the fake board would.
    func answer() {
      settle { $0.answer(refusing: false) }
    }

    /// Answers the requests held so far with what the fake board would have said as each arrived,
    /// as a board does that answered before a later write.
    func answerAsArrived() {
      settleHeld { held in held.request.answer(held.arrived) }
    }

    /// Answers the requests held so far as the fake board answers a token it doesn't take.
    func refuse() {
      settle { $0.answer(refusing: true) }
    }

    /// Fails the requests held so far, as when nothing answers.
    func fail() {
      settle { $0.fail() }
    }

    fileprivate func hold(_ request: Held) {
      let arrived = state.withLock { state in
        state.arrived += 1
        state.held.append(request)
        let count = state.arrived
        let arrived = state.waiting.filter { $0.count <= count }.map(\.continuation)
        state.waiting.removeAll { $0.count <= count }
        return arrived
      }
      for continuation in arrived {
        continuation.resume()
      }
    }

    private func settle(_ outcome: @escaping @Sendable (HeldBoard) -> Void) {
      settleHeld { outcome($0.request) }
    }

    private func settleHeld(_ outcome: @escaping @Sendable (Held) -> Void) {
      let held = state.withLock { state in
        defer { state.held = [] }
        return state.held
      }
      for request in held {
        request.settle(outcome)
      }
    }
  }

  /// A held request, with the run loop of the thread the session started it on, where its client
  /// takes the outcome, and the fake board's answer as it arrived.
  fileprivate struct Held: @unchecked Sendable {
    let request: HeldBoard
    let loop: CFRunLoop
    let arrived: (status: Int, body: Data)

    func settle(_ outcome: @escaping @Sendable (Held) -> Void) {
      let held = self
      CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue) {
        outcome(held)
      }
      CFRunLoopWakeUp(loop)
    }
  }

  private static let gates = Mutex<[String: Gate]>([:])
  /// Whether the session stopped the request, after which its client takes nothing more.
  private let stopped = Mutex(false)

  private static func gate(for request: URLRequest) -> Gate? {
    guard
      let token = request.value(forHTTPHeaderField: "Authorization")?
        .replacingOccurrences(of: "Bearer ", with: ""),
      let path = request.url?.path(percentEncoded: true),
      let gate = gates.withLock({ $0[token] }),
      gate.paths.contains(path)
    else {
      return nil
    }
    return gate
  }

  override class func canInit(with request: URLRequest) -> Bool {
    gate(for: request) != nil
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    HeldBoard.gate(for: request)?.hold(
      Held(request: self, loop: CFRunLoopGetCurrent(), arrived: FakeBoard.answer(request)))
  }

  override func stopLoading() {
    stopped.withLock { $0 = true }
  }

  private func answer(refusing: Bool) {
    var asked = request
    if refusing {
      asked.setValue("Bearer refused", forHTTPHeaderField: "Authorization")
    }
    answer(FakeBoard.answer(asked))
  }

  fileprivate func answer(_ answer: (status: Int, body: Data)) {
    guard !stopped.withLock({ $0 }), let url = request.url else {
      return
    }
    let (status, body) = answer
    let response = HTTPURLResponse(
      url: url, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }

  private func fail() {
    guard !stopped.withLock({ $0 }) else {
      return
    }
    client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
  }
}
