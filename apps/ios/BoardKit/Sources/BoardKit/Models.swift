// The board's answers as the client reads them, mirroring the server's schemas in
// `packages/shared` field for field. Ids are ULIDs and times ISO-8601 strings, kept as the
// strings they are: both sort as text, and the views format times themselves. A field the schema
// gives a default is decoded with that default when it is missing.

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
public enum CompletionEffect: String, Sendable, Hashable, Codable {
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
  public let onDone: CompletionEffect
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
    onDone = try container.decodeIfPresent(CompletionEffect.self, forKey: .onDone) ?? .none
    archived = try container.decodeIfPresent(ProjectArchive.self, forKey: .archived)
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
  public enum Action: String, Sendable, Hashable, Codable {
    case advanced, returned, abandoned, landed, reopened
  }

  public let action: Action
  public let stage: String
  /// Where the task went, or nil once it left its plan.
  public let to: String?
}

/// The decision on a proposal, on the post the deciding verb made in its thread.
public struct ProposalStep: Sendable, Hashable, Codable {
  public enum Action: String, Sendable, Hashable, Codable {
    case approved, rejected
  }

  public let action: Action
}

public enum MessageStep: Sendable, Hashable, Codable {
  case task(TaskStep)
  case proposal(ProposalStep)

  private enum Keys: String, CodingKey { case stage }

  public init(from decoder: any Decoder) throws {
    // A task's step names the stage it acted at; a proposal's has none.
    if try decoder.container(keyedBy: Keys.self).contains(.stage) {
      self = .task(try TaskStep(from: decoder))
    } else {
      self = .proposal(try ProposalStep(from: decoder))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case .task(let step): try step.encode(to: encoder)
    case .proposal(let step): try step.encode(to: encoder)
    }
  }
}

/// What a verb recorded on a post about its work outside any thread: a knowledge topic written,
/// written again, or removed.
public struct MessageNotice: Sendable, Hashable, Codable {
  public let kind: String
  public let action: String
  public let topic: String
  public let project: String?
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
  public enum Kind: String, Sendable, Hashable, Codable {
    case task, proposal
  }

  public let kind: Kind
  public let id: String
}

/// A conversation off a channel; a task's or a proposal's takes its subject's id.
public struct BoardThread: Sendable, Hashable, Codable, Identifiable {
  public enum State: String, Sendable, Hashable, Codable {
    case open, closed
  }

  public let id: String
  public let channel: String
  public let title: String
  public let subject: ThreadSubject?
  public let state: State
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
  public enum Status: String, Sendable, Hashable, Codable {
    case open, claimed, done, abandoned
  }

  public let id: String
  public let project: String
  /// The channel of the project the task is filed in, where its thread hangs.
  public let channel: String
  public let title: String
  public let status: Status
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
  public let onDone: CompletionEffect
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
    status = try container.decode(Status.self, forKey: .status)
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
    onDone = try container.decodeIfPresent(CompletionEffect.self, forKey: .onDone) ?? .none
    pullRequest = try container.decodeIfPresent(PullRequestLink.self, forKey: .pullRequest)
    completing = try container.decodeIfPresent(Bool.self, forKey: .completing) ?? false
    returned = try container.decodeIfPresent(TaskReturn.self, forKey: .returned)
    body = try container.decode(String.self, forKey: .body)
  }
}

public struct Proposal: Sendable, Hashable, Codable, Identifiable {
  public enum Kind: String, Sendable, Hashable, Codable {
    case role, member, channel, reallocation, retirement, skill, archive
  }

  public enum Status: String, Sendable, Hashable, Codable {
    case proposed, approved, rejected, provisioned, retired
  }

  public let id: String
  public let kind: Kind
  public let proposedBy: String
  public let status: Status
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
  public enum Outcome: String, Sendable, Hashable, Codable {
    case approved, rejected
  }

  public let id: String
  public let proposalId: String
  public let decidedBy: String
  public let outcome: Outcome
  public let reason: String?
  public let ts: String
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
