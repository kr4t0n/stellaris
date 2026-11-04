import BoardKit
import Foundation
import SwiftUI

/// What approving a proposal would create or change, drawn for its kind as the web's
/// `ProposalCharter` draws it once decided: a citizen, a role, a channel, a reallocation, a
/// retirement, a skill, or an archive, field by field. A charter that doesn't read as its kind, or
/// of a kind the app doesn't know, shows as the board sent it. It opens beside the proposal's
/// thread, or in a sheet where there is no room beside it.
struct CharterView: View {
  @Environment(AppModel.self) private var model
  let proposal: Proposal

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        SectionTitle(heading)
        fields
          .padding(.top, 8)
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(MessageColor.island)
    .accessibilityIdentifier("charter-\(proposal.id)")
  }

  private var heading: String {
    switch proposal.status {
    case .known(.proposed): "What it would make"
    case .known(.provisioned): "What it made"
    default: "What it proposed"
    }
  }

  @ViewBuilder private var fields: some View {
    switch Charter(proposal) {
    case .member(let hire)?:
      VStack(alignment: .leading, spacing: 6) {
        Field("Citizen") {
          HStack(spacing: 6) {
            CliMarkGlyph(cli: hire.cli, size: 13)
            Text(hire.name)
          }
        }
        Field("Role", hire.role)
        Field("CLI and model", "\(hire.cli.rawValue) · \(hire.model ?? "cli default")")
        Field("Projects", listed(hire.memberships))
        Field("Also follows", listed(hire.subscriptions))
        if let runner = hire.homeRunner {
          Field("Runs on", runner)
        }
        if let seed = hire.seedInstructions {
          Block(title: "Seed instructions") {
            MessageBody(document: model.document(id: "seed:\(proposal.id)", markdown: seed))
          }
        }
      }
    case .role(let role)?:
      VStack(alignment: .leading, spacing: 6) {
        Field("Role", role.name)
        Field("Purpose", role.purpose)
        Field("Verbs") { Verbs(names: role.verbs) }
        Field("Wake triggers", listed(role.wakeTriggers))
        Field("Replicas per project", number(role.maxReplicas))
        Field("Warm session", role.resident ? "yes" : "no")
        Field("Society role", role.societyScope ? "yes, in no project" : "no")
        Field("Reflects", role.reflects ? "yes" : "no")
      }
    case .channel(let channel)?:
      VStack(alignment: .leading, spacing: 6) {
        Field("Channel", "#\(channel.ref)")
        Field("Purpose", channel.purpose)
      }
    case .reallocation(let reallocation)?:
      VStack(alignment: .leading, spacing: 6) {
        Field("Role", reallocation.role)
        if let replicas = reallocation.changes.maxReplicas {
          Field("Replicas per project", number(replicas))
        }
        if let threshold = reallocation.changes.backlogThreshold {
          Field("Backlog per member", number(threshold))
        }
        if let wakes = reallocation.changes.wakeTriggers {
          Field("Wake triggers", listed(wakes))
        }
        if let verbs = reallocation.changes.verbs {
          Field("Verbs") { Verbs(names: verbs) }
        }
        Field("Why", reallocation.description)
      }
    case .retirement(let retirement)?:
      let member = model.store.members.first { $0.name == retirement.agent }
      VStack(alignment: .leading, spacing: 6) {
        Field(
          "Citizen",
          model.displayName(retirement.agent) + (member?.role.map { " · \($0)" } ?? ""))
        Field("Holds now", holds(member))
        Field("Reason", retirement.reason)
      }
    case .skill(let skill)?:
      VStack(alignment: .leading, spacing: 6) {
        Field("Skill", skill.name)
        Field("Summary", skill.summary)
      }
    case .archive(let archive)?:
      VStack(alignment: .leading, spacing: 6) {
        let name = model.store.projectName(archive.project)
        Field("Project", name == archive.project ? name : "\(name) · \(archive.project)")
        if proposal.status == .known(.proposed) {
          Field("Members who leave", listed(leaving(archive.project)))
          let open = model.store.tasksInPlay(of: archive.project).count
          Field("Tasks in play", open == 0 ? "none" : "\(open): approval is refused")
        }
        Field("Reason", archive.reason)
      }
    case nil:
      Text(asSent)
        .font(MessageType.code)
        .foregroundStyle(MessageColor.tertiary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MessageColor.surface2.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .textSelection(.enabled)
    }
  }

  private func listed(_ values: [String]) -> String {
    values.isEmpty ? "none" : values.joined(separator: ", ")
  }

  /// A number as the web writes it.
  private func number(_ value: Double) -> String {
    javaScriptNumber(value)
  }

  private func holds(_ member: Member?) -> String {
    guard let held = member?.claimsHeld else {
      return "unknown"
    }
    return held == 1 ? "1 stage" : "\(held) stages"
  }

  /// The active members who leave a project its archive ends.
  private func leaving(_ project: String) -> [String] {
    model.store.members
      .filter { $0.status == .known(.active) && $0.memberships.contains(project) }
      .map(\.name)
  }

  /// The charter as the board sent it, indented.
  private var asSent: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = (try? encoder.encode(proposal.charter)) ?? Data()
    return String(decoding: data, as: UTF8.self)
  }
}

/// A field of the charter: its label, and its value beside it, or under it at the accessibility
/// sizes, where the value takes the width.
private struct Field<Value: View>: View {
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .caption) private var labelWidth: CGFloat = 120
  let label: String
  let value: Value

  init(_ label: String, @ViewBuilder value: () -> Value) {
    self.label = label
    self.value = value()
  }

  var body: some View {
    let layout =
      typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
    layout {
      Text(label)
        .font(MessageType.small())
        .foregroundStyle(MessageColor.tertiary)
        .frame(width: typeSize.isAccessibilitySize ? nil : labelWidth, alignment: .leading)
      value
        .font(MessageType.text())
        .foregroundStyle(MessageColor.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityElement(children: .combine)
  }
}

extension Field where Value == Text {
  init(_ label: String, _ value: String) {
    self.init(label) { Text(value) }
  }
}

/// The verbs a role is granted, each in code's face on a tint, wrapping as words do.
private struct Verbs: View {
  let names: [String]

  var body: some View {
    if names.isEmpty {
      Text("none")
    } else {
      Text(
        names.map { name in
          var verb = AttributedString("\u{2009}\(name)\u{2009}")
          verb.font = MessageType.code
          verb.foregroundColor = MessageColor.tertiary
          verb.backgroundColor = MessageColor.surface2.opacity(0.7)
          return verb
        }
        .reduce(into: AttributedString()) { line, verb in
          if !line.characters.isEmpty {
            line.append(AttributedString(" "))
          }
          line.append(verb)
        })
    }
  }
}

/// A part of a charter set apart on a tint, under its label, as the web's charter blocks are.
private struct Block<Content: View>: View {
  let title: String
  let content: Content

  init(title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(MessageType.small(.medium))
        .foregroundStyle(MessageColor.muted)
        .textCase(.uppercase)
      content
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(MessageColor.surface2.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.06)))
    .padding(.top, 8)
  }
}
