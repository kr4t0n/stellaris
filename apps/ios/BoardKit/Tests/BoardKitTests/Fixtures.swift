import Foundation

/// A request and its answer as `apps/server/src/ios-fixtures.test.ts` captured them from a real
/// server, from `apps/ios/fixtures/api`.
struct Fixture {
  let name: String
  let method: String
  let path: String
  /// The request's JSON body, for a verb.
  let input: [String: Any]?
  let status: Int
  /// The answer's JSON.
  let body: Data
  /// The answer's text, for the event stream.
  let text: String?
  /// Where a step of a sign-in sends the browser.
  let location: String?

  /// The folder the fixtures are in, beside this package.
  static let folder = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // BoardKitTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // BoardKit
    .deletingLastPathComponent()  // ios
    .appendingPathComponent("fixtures")

  static var names: [String] {
    let files =
      (try? FileManager.default.contentsOfDirectory(
        atPath: folder.appendingPathComponent("api").path)) ?? []
    return files.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
  }

  init(_ name: String) throws {
    let data = try Data(
      contentsOf: Fixture.folder.appendingPathComponent("api/\(name).json"))
    let file = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    let request = file["request"] as? [String: Any] ?? [:]
    self.name = name
    method = request["method"] as? String ?? ""
    path = request["path"] as? String ?? ""
    input = request["body"] as? [String: Any]
    status = file["status"] as? Int ?? 0
    body = try file["body"].map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
    text = file["text"] as? String
    location = file["location"] as? String
  }

  /// The request's body as it was sent.
  var inputData: Data? { input.flatMap { try? JSONSerialization.data(withJSONObject: $0) } }

  /// A string field of the request's body, which the fixture must have.
  func field(_ key: String) throws -> String {
    guard let value = optionalField(key) else { throw Missing(key: key) }
    return value
  }

  func optionalField(_ key: String) -> String? { input?[key] as? String }

  struct Missing: Error {
    let key: String
  }

  func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: body)
  }

  /// A case table from `apps/ios/fixtures/cases`, which the web's tests run too.
  static func table<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let data = try Data(contentsOf: folder.appendingPathComponent("cases/\(name).json"))
    return try JSONDecoder().decode(type, from: data)
  }
}

extension Data {
  /// The JSON this holds, for comparing two encodings of the same value.
  var json: NSObject? {
    (try? JSONSerialization.jsonObject(with: self, options: [.fragmentsAllowed])) as? NSObject
  }
}
