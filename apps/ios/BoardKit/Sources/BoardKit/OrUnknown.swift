/// A value of a set the board may grow, such as a task's status: one this client knows, or the
/// raw value of one a newer server added. The app is installed apart from the server and falls
/// behind its releases, so a value it doesn't know must leave the answer around it readable.
public enum OrUnknown<Value>: Sendable, Hashable, Codable
where Value: RawRepresentable & Sendable & Hashable, Value.RawValue == String {
  case known(Value)
  case unknown(String)

  public init(rawValue: String) {
    self = Value(rawValue: rawValue).map(OrUnknown.known) ?? .unknown(rawValue)
  }

  public init(from decoder: any Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .known(let value): value.rawValue
    case .unknown(let rawValue): rawValue
    }
  }

  /// The value, or nil for one this client doesn't know.
  public var value: Value? {
    if case .known(let value) = self { value } else { nil }
  }
}
