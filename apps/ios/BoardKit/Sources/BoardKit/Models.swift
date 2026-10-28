// The board's answers as the client reads them: the fields of the server's schemas in
// `packages/shared` that the app uses, under the same names. Ids are ULIDs and times ISO-8601
// strings, kept as the strings they are: both sort as text, and the views format times
// themselves. A field the schema gives a default is decoded with that default when it is missing,
// and a value of a closed set is an `OrUnknown`.

import Foundation

/// Who a token signs in as.
public struct BoardActor: Sendable, Hashable, Codable {
  public let name: String
  public let role: String
  /// The GitHub account a sign-in token belongs to; nil for the user's own token.
  public let signIn: SignIn?
}

public struct SignIn: Sendable, Hashable, Codable {
  public let login: String
  public let avatarUrl: String
}

/// How a board lets people in, asked before anyone has a token.
public struct AuthConfig: Sendable, Hashable, Codable {
  public let github: Bool
  /// Whether the board takes the app's own sign-in with GitHub (`AppSignIn`), which it does only
  /// once it names the app; false from a board that doesn't say.
  public let appLanding: Bool

  public init(github: Bool, appLanding: Bool = false) {
    self.github = github
    self.appLanding = appLanding
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    github = try container.decode(Bool.self, forKey: .github)
    appLanding = try container.decodeIfPresent(Bool.self, forKey: .appLanding) ?? false
  }
}

/// The session the app's sign-in with GitHub ends in: a token like any other.
public struct AppSession: Sendable, Hashable, Codable {
  public let session: String
}

public struct SignedOut: Sendable, Hashable, Codable {
  public let signedOut: Bool
}

public struct ArchivedChannel: Sendable, Hashable, Codable {
  public let name: String
  public let at: String
  public let by: String
  public let reason: String
}

public struct Society: Sendable, Hashable, Codable {
  public let name: String
  public let createdAt: String
  /// The channels that take posts; an archived one moves to `archivedChannels`.
  public let channels: [String]
  public let archivedChannels: [ArchivedChannel]
  public let timezone: String

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    name = try container.decode(String.self, forKey: .name)
    createdAt = try container.decode(String.self, forKey: .createdAt)
    channels = try container.decode([String].self, forKey: .channels)
    archivedChannels =
      try container.decodeIfPresent([ArchivedChannel].self, forKey: .archivedChannels) ?? []
    timezone = try container.decodeIfPresent(String.self, forKey: .timezone) ?? "UTC"
  }
}

/// What the board does when a task's last stage completes.
public enum CompletionEffect: String, Sendable, Hashable {
  case none, merge, ghpr
}

public struct ProjectArchive: Sendable, Hashable, Codable {
  public let at: String
  public let by: String
  public let reason: String
}

public struct Project: Sendable, Hashable, Codable {
  public let slug: String
  public let name: String
  public let repo: String?
  public let defaultBranch: String
  public let channels: [String]
  public let archivedChannels: [ArchivedChannel]
  public let members: [String]
  public let approvers: [String]
  public let createdAt: String
  public let onDone: OrUnknown<CompletionEffect>
  /// Set once the project is archived.
  public let archived: ProjectArchive?

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    slug = try container.decode(String.self, forKey: .slug)
    name = try container.decode(String.self, forKey: .name)
    repo = try container.decodeIfPresent(String.self, forKey: .repo)
    defaultBranch = try container.decode(String.self, forKey: .defaultBranch)
    channels = try container.decode([String].self, forKey: .channels)
    archivedChannels =
      try container.decodeIfPresent([ArchivedChannel].self, forKey: .archivedChannels) ?? []
    members = try container.decode([String].self, forKey: .members)
    approvers = try container.decode([String].self, forKey: .approvers)
    createdAt = try container.decode(String.self, forKey: .createdAt)
    onDone =
      try container.decodeIfPresent(OrUnknown<CompletionEffect>.self, forKey: .onDone)
      ?? .known(.none)
    archived = try container.decodeIfPresent(ProjectArchive.self, forKey: .archived)
  }
}

/// The CLIs a citizen's turns run in.
public enum CliKind: String, Sendable, Hashable {
  case claude, codex
}

/// A citizen on the board's roster, with what the sky and its cards read of it.
public struct Member: Sendable, Hashable, Codable {
  public enum Status: String, Sendable, Hashable {
    case active, retired
  }

  public let name: String
  /// The citizen's role. The board always sends it; the sky's tables, which the web's tests write
  /// from boards of their own, leave it out.
  public let role: String?
  /// Nil for the user, who takes no turns.
  public let cli: OrUnknown<CliKind>?
  public let status: OrUnknown<Status>
  /// The model configured on the record, if any; the CLI's own default applies otherwise.
  public let model: String?
  /// The model the CLI reported on the citizen's last turn.
  public let lastModel: String?
  /// The projects the citizen belongs to.
  public let memberships: [String]
  public let lastTurnAt: String?
}

/// The scheduler's sessions, each an `agent/scope` key with the conversation's part after it, as
/// the session keys of `packages/shared` spell them: those in a turn, those queued, and the warm
/// ones.
public struct SchedulerView: Sendable, Hashable, Codable {
  /// Whether the society is paused, which dims the sky. The board always sends it; the sky's
  /// tables leave it out.
  public let paused: Bool?
  public let running: [String]
  public let pending: [String]
  public let resident: [String]

  public init(paused: Bool?, running: [String], pending: [String], resident: [String]) {
    self.paused = paused
    self.running = running
    self.pending = pending
    self.resident = resident
  }
}

/// A channel as the channel list gives it, with its count and its latest message.
public struct ChannelSummary: Sendable, Hashable, Codable {
  /// `general` for a society channel, `demo/general` for a project's.
  public let ref: String
  public let project: String?
  public let name: String
  public let messages: Int
  public let lastMessageId: String?
  public let lastAt: String?
  /// Set for an archived channel, listed for its history.
  public let archived: ArchivedChannel?
}

/// What a task verb did, on the post it made of its note in the task's thread.
public struct TaskStep: Sendable, Hashable, Codable {
  public enum Action: String, Sendable, Hashable {
    case advanced, returned, abandoned, landed, reopened
  }

  public let action: OrUnknown<Action>
  public let stage: String
  /// Where the task went, or nil once it left its plan.
  public let to: String?
}

/// The decision on a proposal, on the post the deciding verb made in its thread.
public struct ProposalStep: Sendable, Hashable, Codable {
  public enum Action: String, Sendable, Hashable {
    case approved, rejected
  }

  public let action: OrUnknown<Action>
}

/// What a verb recorded on the post it made in its subject's thread, or `unknown`, with its fields
/// as sent, for a shape a newer server added.
public enum MessageStep: Sendable, Hashable, Codable {
  case task(TaskStep)
  case proposal(ProposalStep)
  case unknown([String: JSONValue])

  private enum Keys: String, CodingKey { case stage, action }

  public init(from decoder: any Decoder) throws {
    // A task's step names the stage it acted at; a proposal's names only its action.
    let keys = try decoder.container(keyedBy: Keys.self)
    if keys.contains(.stage), let step = try? TaskStep(from: decoder) {
      self = .task(step)
    } else if !keys.contains(.stage), keys.contains(.action),
      let step = try? ProposalStep(from: decoder)
    {
      self = .proposal(step)
    } else {
      self = .unknown(try [String: JSONValue](from: decoder))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case .task(let step): try step.encode(to: encoder)
    case .proposal(let step): try step.encode(to: encoder)
    case .unknown(let fields): try fields.encode(to: encoder)
    }
  }
}

/// A knowledge topic written, written again, or removed.
public struct KnowledgeNotice: Sendable, Hashable, Codable {
  public enum Action: String, Sendable, Hashable {
    case written, updated, removed
  }

  public let action: OrUnknown<Action>
  public let topic: String
  /// The project the topic belongs to, or nil for the society's.
  public let project: String?
}

/// What a verb recorded on a post about its work outside any thread, by its kind, or `unknown`,
/// with its fields as sent, for a kind a newer server added.
public enum MessageNotice: Sendable, Hashable, Codable {
  case knowledge(KnowledgeNotice)
  case unknown([String: JSONValue])

  private enum Keys: String, CodingKey { case kind }

  public init(from decoder: any Decoder) throws {
    let kind = try? decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .kind)
    if kind == "knowledge", let notice = try? KnowledgeNotice(from: decoder) {
      self = .knowledge(notice)
    } else {
      self = .unknown(try [String: JSONValue](from: decoder))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case .knowledge(let notice):
      try notice.encode(to: encoder)
      var keys = encoder.container(keyedBy: Keys.self)
      try keys.encode("knowledge", forKey: .kind)
    case .unknown(let fields): try fields.encode(to: encoder)
    }
  }

  /// The notice's kind, as the board names it.
  public var kind: String {
    switch self {
    case .knowledge: "knowledge"
    case .unknown(let fields): fields["kind"]?.string ?? ""
    }
  }
}

public struct Message: Sendable, Hashable, Codable, Identifiable {
  public let id: String
  public let author: String
  public let channel: String
  public let thread: String?
  /// On a summary post, the task whose thread it closed, as older builds wrote it.
  public let task: String?
  /// On a summary post, the thread it closed.
  public let closes: String?
  public let step: MessageStep?
  public let notice: MessageNotice?
  public let ts: String
  public let mentions: [String]
  public let body: String
}

public struct ThreadSubject: Sendable, Hashable, Codable {
  public enum Kind: String, Sendable, Hashable {
    case task, proposal
  }

  public let kind: OrUnknown<Kind>
  public let id: String
}

/// A conversation off a channel; a task's or a proposal's takes its subject's id.
public struct BoardThread: Sendable, Hashable, Codable, Identifiable {
  public enum State: String, Sendable, Hashable {
    case open, closed
  }

  public let id: String
  public let channel: String
  public let title: String
  public let subject: ThreadSubject?
  public let state: OrUnknown<State>
  public let openedBy: String
  public let openedAt: String
  public let closedBy: String?
  public let closedAt: String?
  /// The summary it closed with.
  public let body: String
}

/// A thread as the thread list gives it, with its count and its latest message.
public struct ThreadSummary: Sendable, Hashable, Codable, Identifiable {
  public let thread: BoardThread
  public let messages: Int
  public let lastMessageId: String?
  public let lastAuthor: String?

  public var id: String { thread.id }

  private enum CodingKeys: String, CodingKey { case messages, lastMessageId, lastAuthor }

  public init(from decoder: any Decoder) throws {
    thread = try BoardThread(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    messages = try container.decode(Int.self, forKey: .messages)
    lastMessageId = try container.decodeIfPresent(String.self, forKey: .lastMessageId)
    lastAuthor = try container.decodeIfPresent(String.self, forKey: .lastAuthor)
  }

  public func encode(to encoder: any Encoder) throws {
    try thread.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(messages, forKey: .messages)
    try container.encode(lastMessageId, forKey: .lastMessageId)
    try container.encode(lastAuthor, forKey: .lastAuthor)
  }
}

public struct ThreadDetail: Sendable, Hashable, Codable {
  public let thread: BoardThread
  public let messages: [Message]
}

/// A message that asks the user something, unanswered, with the thread it is in, or nil for a
/// channel post.
public struct UserRequest: Sendable, Hashable, Codable {
  public let message: Message
  public let thread: BoardThread?
}

public struct Stage: Sendable, Hashable, Codable, Identifiable {
  public let id: String
  public let name: String
  public let role: String?
  public let agent: String?
  public let gate: Bool
  /// Everyone who has held the stage, oldest first.
  public let holders: [String]
  public let completedBy: String?
  public let completedAt: String?

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    name = try container.decode(String.self, forKey: .name)
    role = try container.decodeIfPresent(String.self, forKey: .role)
    agent = try container.decodeIfPresent(String.self, forKey: .agent)
    gate = try container.decodeIfPresent(Bool.self, forKey: .gate) ?? false
    holders = try container.decodeIfPresent([String].self, forKey: .holders) ?? []
    completedBy = try container.decodeIfPresent(String.self, forKey: .completedBy)
    completedAt = try container.decodeIfPresent(String.self, forKey: .completedAt)
  }
}

/// A send-back: the stage the work came back from, who sent it, and when.
public struct TaskReturn: Sendable, Hashable, Codable {
  public let from: String
  public let by: String
  public let at: String
}

/// The pull request a `ghpr` task lands through.
public struct PullRequestLink: Sendable, Hashable, Codable {
  public let url: String
  public let number: Int
  public let subject: String?
  public let body: String?
  public let linkedBy: String
  public let linkedAt: String
}

public struct BoardTask: Sendable, Hashable, Codable, Identifiable {
  public enum Status: String, Sendable, Hashable {
    case open, claimed, done, abandoned
  }

  public let id: String
  public let project: String
  /// The channel of the project the task is filed in, where its thread hangs.
  public let channel: String
  public let title: String
  public let status: OrUnknown<Status>
  public let createdBy: String
  public let createdAt: String
  public let updatedAt: String
  /// The holder of the current stage.
  public let claimedBy: String?
  public let leaseExpiresAt: String?
  public let parentId: String?
  public let blockedBy: [String]
  public let requiredCapabilities: [String]
  public let stages: [Stage]
  /// The current stage's id.
  public let stage: String
  /// When the current stage last became current or lost its holder.
  public let stageSince: String
  public let stageSeq: Int
  public let onDone: OrUnknown<CompletionEffect>
  public let pullRequest: PullRequestLink?
  /// The last stage is complete and the completion effect is running.
  public let completing: Bool
  /// The latest send-back while its rework lasts.
  public let returned: TaskReturn?
  public let body: String

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    project = try container.decode(String.self, forKey: .project)
    channel = try container.decodeIfPresent(String.self, forKey: .channel) ?? "general"
    title = try container.decode(String.self, forKey: .title)
    status = try container.decode(OrUnknown<Status>.self, forKey: .status)
    createdBy = try container.decode(String.self, forKey: .createdBy)
    createdAt = try container.decode(String.self, forKey: .createdAt)
    updatedAt = try container.decode(String.self, forKey: .updatedAt)
    claimedBy = try container.decodeIfPresent(String.self, forKey: .claimedBy)
    leaseExpiresAt = try container.decodeIfPresent(String.self, forKey: .leaseExpiresAt)
    parentId = try container.decodeIfPresent(String.self, forKey: .parentId)
    blockedBy = try container.decode([String].self, forKey: .blockedBy)
    requiredCapabilities = try container.decode([String].self, forKey: .requiredCapabilities)
    stages = try container.decode([Stage].self, forKey: .stages)
    stage = try container.decode(String.self, forKey: .stage)
    stageSince = try container.decode(String.self, forKey: .stageSince)
    stageSeq = try container.decode(Int.self, forKey: .stageSeq)
    onDone =
      try container.decodeIfPresent(OrUnknown<CompletionEffect>.self, forKey: .onDone)
      ?? .known(.none)
    pullRequest = try container.decodeIfPresent(PullRequestLink.self, forKey: .pullRequest)
    completing = try container.decodeIfPresent(Bool.self, forKey: .completing) ?? false
    returned = try container.decodeIfPresent(TaskReturn.self, forKey: .returned)
    body = try container.decode(String.self, forKey: .body)
  }
}

public struct Proposal: Sendable, Hashable, Codable, Identifiable {
  public enum Kind: String, Sendable, Hashable {
    case role, member, channel, reallocation, retirement, skill, archive
  }

  public enum Status: String, Sendable, Hashable {
    case proposed, approved, rejected, provisioned, retired
  }

  public let id: String
  public let kind: OrUnknown<Kind>
  public let proposedBy: String
  public let status: OrUnknown<Status>
  public let createdAt: String
  public let decidedBy: String?
  public let decidedAt: String?
  public let reason: String?
  public let charter: [String: JSONValue]
  public let provisionedAt: String?
  /// The proposer's rationale.
  public let body: String
}

public struct Decision: Sendable, Hashable, Codable, Identifiable {
  public enum Outcome: String, Sendable, Hashable {
    case approved, rejected
  }

  public let id: String
  public let proposalId: String
  public let decidedBy: String
  public let outcome: OrUnknown<Outcome>
  public let reason: String?
  public let ts: String
}

/// Where a message is and who wrote it, as the board answers a lookup of the ids a text names.
public struct MessageRef: Sendable, Hashable, Codable {
  public let id: String
  public let author: String
  public let channel: String
  public let thread: String?
  public let ts: String

  public init(id: String, author: String, channel: String, thread: String? = nil, ts: String) {
    self.id = id
    self.author = author
    self.channel = channel
    self.thread = thread
    self.ts = ts
  }
}

/// A path on a task's branch as the board reads it from the project's runner: a file, with its
/// bytes in base64, or a folder.
public struct BranchFile: Sendable, Hashable, Codable {
  public enum Kind: String, Sendable, Hashable {
    case file, dir
  }

  public let kind: OrUnknown<Kind>
  public let path: String
  /// A file's bytes in base64; nil for a folder, or for a file too large for the board to send.
  public let content: String?

  /// A file's bytes, when the board sent them.
  public var data: Data? {
    content.flatMap { Data(base64Encoded: $0) }
  }
}

/// A project's status page. `revision` counts its updates.
public struct Dashboard: Sendable, Hashable, Codable {
  public let project: String
  public let revision: Int
  /// Nil until someone updates the dashboard the project began with.
  public let updatedBy: String?
  public let updatedAt: String?
  public let body: String
}

/// An entry of the board's event log. The type stays a string, so an event a newer server adds
/// reads as one that touches nothing.
public struct BoardEvent: Sendable, Hashable, Codable, Identifiable {
  public let id: String
  public let ts: String
  public let type: String
  public let actor: String
  public let payload: [String: JSONValue]
}
