// A proposal's charter read as its kind and said in one line: ports of `describeCharter` in
// `packages/shared/src/board.ts`, with the charter schemas it reads through, and of the web's
// `proposalTitle` in `apps/web/src/board/governance.ts`. Both run the case table in
// `apps/ios/fixtures/cases/describe-charter.json`.

/// A member proposal's charter, as `MemberProposalSchema` reads it.
public struct MemberCharter: Sendable, Hashable {
  public let name: String
  public let role: String
  public let cli: OrUnknown<CliKind>
  public let model: String?
  public let homeRunner: String?
  public let memberships: [String]
  /// The channels the citizen follows, as refs.
  public let subscriptions: [String]
  public let seedInstructions: String?
}

/// A role's charter, as `RoleCharterSchema` reads it, with its defaults filled in.
public struct RoleCharter: Sendable, Hashable {
  public let name: String
  public let purpose: String
  /// The verbs it grants; a verb a newer board added reads as its name.
  public let verbs: [String]
  public let wakeTriggers: [String]
  public let reviewDate: String?
  public let maxReplicas: Double
  public let backlogThreshold: Double
  public let resident: Bool
  public let societyScope: Bool
  public let reflects: Bool
}

/// A channel proposal's charter: a society channel when `project` is nil.
public struct ChannelCharter: Sendable, Hashable {
  public let project: String?
  public let name: String
  public let purpose: String

  /// The channel's ref, as `channelRef` spells it.
  public var ref: String { project.map { "\($0)/\(name)" } ?? name }
}

/// What a reallocation changes in a role, each field given its new value.
public struct RoleChanges: Sendable, Hashable {
  public let maxReplicas: Double?
  public let backlogThreshold: Double?
  public let wakeTriggers: [String]?
  public let verbs: [String]?
}

public struct ReallocationCharter: Sendable, Hashable {
  public let role: String
  public let changes: RoleChanges
  public let description: String
}

public struct RetirementCharter: Sendable, Hashable {
  public let agent: String
  public let reason: String
}

public struct SkillCharter: Sendable, Hashable {
  public let name: String
  public let summary: String
}

public struct ArchiveCharter: Sendable, Hashable {
  public let project: String
  public let reason: String
}

/// A proposal's charter read as its kind, as the board's schema for the kind reads it. A field a
/// schema leaves out takes the schema's default, and a field of the wrong shape, or null where the
/// schema takes none, leaves the charter unread, as the schema's `safeParse` fails. A value of a
/// closed set the board may grow (a CLI, a verb, a wake) reads as it is, so a charter from a newer
/// board stays readable.
public enum Charter: Sendable, Hashable {
  case member(MemberCharter)
  case role(RoleCharter)
  case channel(ChannelCharter)
  case reallocation(ReallocationCharter)
  case retirement(RetirementCharter)
  case skill(SkillCharter)
  case archive(ArchiveCharter)

  /// The charter of a proposal of `kind`; nil for a kind this client doesn't know, or for a
  /// charter that doesn't parse as its kind.
  public init?(kind: OrUnknown<Proposal.Kind>, charter: [String: JSONValue]) {
    let fields = CharterFields(charter)
    do {
      switch kind {
      case .known(.member):
        self = .member(
          MemberCharter(
            name: try fields.name("name"), role: try fields.name("role"),
            cli: OrUnknown(rawValue: try fields.string("cli")),
            model: try fields.optionalString("model"),
            homeRunner: try fields.optionalName("homeRunner"),
            memberships: try fields.strings("memberships", default: [], each: isName),
            subscriptions: try fields.strings("subscriptions", default: [], each: isChannelRef),
            seedInstructions: try fields.optionalString("seedInstructions")))
      case .known(.role):
        self = .role(try RoleCharter(fields))
      case .known(.channel):
        self = .channel(
          ChannelCharter(
            project: try fields.nullableName("project"), name: try fields.name("name"),
            purpose: try fields.text("purpose")))
      case .known(.reallocation):
        guard case .object(let changes)? = fields.values["changes"] else {
          throw Unread()
        }
        self = .reallocation(
          ReallocationCharter(
            role: try fields.name("role"), changes: try RoleChanges(changes),
            description: try fields.text("description")))
      case .known(.retirement):
        self = .retirement(
          RetirementCharter(agent: try fields.name("agent"), reason: try fields.text("reason")))
      case .known(.skill):
        self = .skill(
          SkillCharter(name: try fields.name("name"), summary: try fields.text("summary", max: 200)))
      case .known(.archive):
        self = .archive(
          ArchiveCharter(project: try fields.name("project"), reason: try fields.text("reason")))
      case .unknown:
        return nil
      }
    } catch {
      return nil
    }
  }

  /// The proposal's charter read as its kind.
  public init?(_ proposal: Proposal) {
    self.init(kind: proposal.kind, charter: proposal.charter)
  }
}

/// The charter in one line, as the board announces a proposal and its thread is titled: "member
/// eng-2 as engineer on claude for demo". A charter that doesn't read as its kind, or of a kind this
/// client doesn't know, is its kind and its fields as JSON, with the keys in order of their UTF-16
/// code units, where the web keeps the order the board wrote them in.
public func describeCharter(_ kind: OrUnknown<Proposal.Kind>, _ charter: [String: JSONValue])
  -> String
{
  switch Charter(kind: kind, charter: charter) {
  case .member(let member)?:
    let place =
      member.memberships.isEmpty ? "" : " for \(member.memberships.joined(separator: ", "))"
    return "member \(member.name) as \(member.role) on \(member.cli.rawValue)\(place)"
  case .role(let role)?:
    return
      "role \(role.name) (\(role.verbs.count) verbs, up to \(javaScriptNumber(role.maxReplicas)) per project)"
  case .channel(let channel)?:
    return "channel \(channel.ref): \(channel.purpose)"
  case .retirement(let retirement)?:
    return "retirement of \(retirement.agent): \(retirement.reason)"
  case .reallocation(let reallocation)?:
    return
      "reallocation of role \(reallocation.role) (\(describe(reallocation.changes))): \(reallocation.description)"
  case .skill(let skill)?:
    var summary = trimmedAsJavaScript(Substring(skill.summary).unicodeScalars)
    while summary.last == "." {
      summary.removeLast()
    }
    return "skill \(skill.name): \(String(String.UnicodeScalarView(summary)))"
  case .archive(let archive)?:
    return "archive of project \(archive.project): \(archive.reason)"
  case nil:
    return "\(kind.rawValue) \(javaScriptJSON(.object(charter)))"
  }
}

/// The proposal in one line, as the board announces it, starting with a capital: "Member eng-2 as
/// engineer on claude for demo".
public func proposalTitle(_ proposal: Proposal) -> String {
  let line = describeCharter(proposal.kind, proposal.charter)
  guard let first = line.unicodeScalars.first else {
    return line
  }
  return String(first).uppercased() + String(line.unicodeScalars.dropFirst())
}

/// Who may decide the proposal, in words, as the web's `decidersOf` says it: "you", or "you or
/// another steward" when the proposer holds a role that may decide it, since a proposer never
/// decides its own.
public func decidersOf(_ proposal: Proposal, proposerRole: String?) -> String {
  let who = proposalApprovers(proposal).flatMap { role -> [String] in
    if role == userRole {
      return proposal.proposedBy == userName ? [] : ["you"]
    }
    return [role == proposerRole ? "another \(role)" : "the \(role)"]
  }
  // As `Intl.ListFormat` joins a disjunction in English.
  switch who.count {
  case 0: return "nobody"
  case 1: return who[0]
  case 2: return "\(who[0]) or \(who[1])"
  default: return who.dropLast().joined(separator: ", ") + ", or " + (who.last ?? "")
  }
}

/// What a reallocation changes, as `describeRoleChanges` says it.
private func describe(_ changes: RoleChanges) -> String {
  var parts: [String] = []
  if let replicas = changes.maxReplicas {
    parts.append("up to \(javaScriptNumber(replicas)) per project")
  }
  if let threshold = changes.backlogThreshold {
    parts.append("backlog threshold \(javaScriptNumber(threshold))")
  }
  if let wakes = changes.wakeTriggers {
    parts.append(
      wakes.isEmpty ? "no ambient wakes" : "wakes on \(wakes.joined(separator: ", "))")
  }
  if let verbs = changes.verbs {
    parts.append("\(verbs.count) verbs")
  }
  return parts.joined(separator: ", ")
}

extension RoleCharter {
  fileprivate init(_ fields: CharterFields) throws {
    name = try fields.name("name")
    purpose = try fields.text("purpose")
    verbs = try fields.strings("verbs", default: nil, each: { _ in true })
    wakeTriggers = try fields.strings("wakeTriggers", default: ["heartbeat"], each: { _ in true })
    reviewDate = try fields.optionalString("reviewDate")
    maxReplicas = try fields.integer("maxReplicas", atLeast: 1) ?? 1
    backlogThreshold = try fields.positive("backlogThreshold") ?? 3
    resident = try fields.bool("resident") ?? false
    societyScope = try fields.bool("societyScope") ?? false
    reflects = try fields.bool("reflects") ?? true
  }
}

extension RoleChanges {
  /// The changes, as `RoleChangesSchema` reads them: no field but its four, and at least one.
  fileprivate init(_ values: [String: JSONValue]) throws {
    let known: Set<String> = ["maxReplicas", "backlogThreshold", "wakeTriggers", "verbs"]
    guard Set(values.keys).isSubset(of: known) else {
      throw Unread()
    }
    let fields = CharterFields(values)
    maxReplicas = try fields.integer("maxReplicas", atLeast: 1)
    backlogThreshold = try fields.positive("backlogThreshold")
    wakeTriggers = try fields.optionalStrings("wakeTriggers")
    verbs = try fields.optionalStrings("verbs")
    guard maxReplicas != nil || backlogThreshold != nil || wakeTriggers != nil || verbs != nil
    else {
      throw Unread()
    }
  }
}

/// A charter that doesn't parse as its kind.
private struct Unread: Error {}

/// A charter's fields, read as Zod reads them: a field left out is undefined, and null is a value
/// of its own, which no optional field and no default takes.
private struct CharterFields {
  let values: [String: JSONValue]

  init(_ values: [String: JSONValue]) {
    self.values = values
  }

  func string(_ key: String) throws -> String {
    guard case .string(let value)? = values[key] else {
      throw Unread()
    }
    return value
  }

  func optionalString(_ key: String) throws -> String? {
    values[key] == nil ? nil : try string(key)
  }

  /// A string of at least one code point and at most `max`, as Zod counts a string's length.
  func text(_ key: String, max: Int? = nil) throws -> String {
    let value = try string(key)
    let length = value.unicodeScalars.count
    guard length >= 1, max.map({ length <= $0 }) ?? true else {
      throw Unread()
    }
    return value
  }

  func name(_ key: String) throws -> String {
    let value = try string(key)
    guard isName(value) else {
      throw Unread()
    }
    return value
  }

  func optionalName(_ key: String) throws -> String? {
    values[key] == nil ? nil : try name(key)
  }

  /// A name, null, or left out, which reads as null.
  func nullableName(_ key: String) throws -> String? {
    switch values[key] {
    case nil, .null?: nil
    default: try name(key)
    }
  }

  /// A list of strings each `each` takes, or `fallback` when left out; with no fallback, required.
  func strings(_ key: String, default fallback: [String]?, each: (String) -> Bool) throws
    -> [String]
  {
    guard let value = values[key] else {
      guard let fallback else {
        throw Unread()
      }
      return fallback
    }
    guard case .array(let items) = value else {
      throw Unread()
    }
    return try items.map { item in
      guard case .string(let string) = item, each(string) else {
        throw Unread()
      }
      return string
    }
  }

  func optionalStrings(_ key: String) throws -> [String]? {
    values[key] == nil ? nil : try strings(key, default: nil, each: { _ in true })
  }

  /// A safe integer no less than `atLeast`, as `z.number().int().min()` takes; nil when left out.
  func integer(_ key: String, atLeast minimum: Double) throws -> Double? {
    guard let value = values[key] else {
      return nil
    }
    guard case .number(let number) = value, number.rounded(.towardZero) == number,
      abs(number) <= 9_007_199_254_740_991, number >= minimum
    else {
      throw Unread()
    }
    return number
  }

  /// A number above zero, as `z.number().positive()` takes; nil when left out.
  func positive(_ key: String) throws -> Double? {
    guard let value = values[key] else {
      return nil
    }
    guard case .number(let number) = value, number.isFinite, number > 0 else {
      throw Unread()
    }
    return number
  }

  func bool(_ key: String) throws -> Bool? {
    guard let value = values[key] else {
      return nil
    }
    guard case .bool(let flag) = value else {
      throw Unread()
    }
    return flag
  }
}

/// Whether `text` is a board name: 1 to 32 lowercase letters, digits, or hyphens, starting with a
/// letter or a digit, as `NAME_PATTERN` has it.
func isName(_ text: String) -> Bool {
  let scalars = Array(text.unicodeScalars)
  guard (1...32).contains(scalars.count), scalars[0] != "-" else {
    return false
  }
  return scalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
}

/// Whether `text` is a channel's ref, `<channel>` or `<project>/<channel>`.
func isChannelRef(_ text: String) -> Bool {
  let parts = text.split(separator: "/", omittingEmptySubsequences: false)
  return (1...2).contains(parts.count) && parts.allSatisfy { isName(String($0)) }
}

/// `value` as JavaScript's `String(value)` writes a number: the fewest digits that read back as it,
/// plain from a millionth up to 10^21 and with an exponent outside that, "-0" as "0".
public func javaScriptNumber(_ value: Double) -> String {
  if value.isNaN {
    return "NaN"
  }
  if value.isInfinite {
    return value < 0 ? "-Infinity" : "Infinity"
  }
  if value == 0 {
    return "0"
  }
  // Swift's description has the same fewest digits, in a form of its own: "1e-07", "5.0".
  let text = "\(abs(value))"
  var mantissa = Substring(text)
  var exponent = 0
  if let mark = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
    mantissa = text[..<mark]
    exponent = Int(text[text.index(after: mark)...]) ?? 0
  }
  let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
  var digits = String(parts[0]) + (parts.count > 1 ? String(parts[1]) : "")
  // Where the point falls among the digits, as ECMAScript's Number::toString counts it.
  var point = parts[0].count + exponent
  while digits.count > 1, digits.first == "0" {
    digits.removeFirst()
    point -= 1
  }
  while digits.count > 1, digits.last == "0" {
    digits.removeLast()
  }
  let sign = value < 0 ? "-" : ""
  let count = digits.count
  if count <= point, point <= 21 {
    return sign + digits + String(repeating: "0", count: point - count)
  }
  if 0 < point, point <= 21 {
    return sign + digits.prefix(point) + "." + digits.dropFirst(point)
  }
  if -6 < point, point <= 0 {
    return sign + "0." + String(repeating: "0", count: -point) + digits
  }
  let power = point - 1
  let lead = count == 1 ? digits : digits.prefix(1) + "." + digits.dropFirst()
  return sign + lead + "e" + (power >= 0 ? "+" : "-") + String(abs(power))
}

/// `value` as JavaScript's `JSON.stringify` writes it, but for an object's keys, which go in order
/// of their UTF-16 code units, since the order the board wrote them in isn't kept.
func javaScriptJSON(_ value: JSONValue) -> String {
  switch value {
  case .null:
    return "null"
  case .bool(let flag):
    return flag ? "true" : "false"
  case .number(let number):
    return number.isFinite ? javaScriptNumber(number) : "null"
  case .string(let string):
    return quotedAsJSON(string)
  case .array(let items):
    return "[" + items.map(javaScriptJSON).joined(separator: ",") + "]"
  case .object(let members):
    let keys = members.keys.sorted(by: sortsBefore)
    return "{"
      + keys.map { quotedAsJSON($0) + ":" + javaScriptJSON(members[$0] ?? .null) }
      .joined(separator: ",") + "}"
  }
}

/// A string quoted as `JSON.stringify` quotes one: `"` and `\` escaped, and control characters as
/// their short escapes or `\u00xx`.
private func quotedAsJSON(_ string: String) -> String {
  var quoted = "\""
  for scalar in string.unicodeScalars {
    switch scalar {
    case "\"": quoted += "\\\""
    case "\\": quoted += "\\\\"
    case "\u{08}": quoted += "\\b"
    case "\u{0C}": quoted += "\\f"
    case "\n": quoted += "\\n"
    case "\r": quoted += "\\r"
    case "\t": quoted += "\\t"
    case _ where scalar.value < 0x20:
      let hex = String(scalar.value, radix: 16)
      quoted += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
    default: quoted.unicodeScalars.append(scalar)
    }
  }
  return quoted + "\""
}
