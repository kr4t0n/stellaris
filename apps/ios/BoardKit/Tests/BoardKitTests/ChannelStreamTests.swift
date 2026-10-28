import Foundation
import Testing

@testable import BoardKit

/// A channel's stream: its messages with each thread opened on it, in time order.
@Suite struct ChannelStreamTests {
  private func message(_ id: String, at ts: String) throws -> Message {
    try JSONDecoder().decode(
      Message.self,
      from: Data(
        #"{"id":"\#(id)","author":"eng-1","channel":"general","ts":"\#(ts)","mentions":[],"body":"x"}"#
          .utf8))
  }

  private func thread(_ id: String, in channel: String, at ts: String) throws -> ThreadSummary {
    try JSONDecoder().decode(
      ThreadSummary.self,
      from: Data(
        #"{"id":"\#(id)","channel":"\#(channel)","title":"t","state":"open","openedBy":"eng-1","openedAt":"\#(ts)","body":"","messages":0,"lastMessageId":null,"lastAuthor":null}"#
          .utf8))
  }

  @Test func ordersMessagesAndThreadsByTimeThenId() throws {
    let early = "2026-01-01T09:00:00.000Z"
    let later = "2026-01-01T09:05:00.000Z"
    let latest = "2026-01-01T09:10:00.000Z"
    let items = channelStream(
      "general",
      messages: [
        try message("00000000000000000000000003", at: early),
        try message("0000000000000000000000000B", at: latest),
      ],
      threads: [
        try thread("0000000000000000000000000A", in: "general", at: latest),
        try thread("00000000000000000000000004", in: "general", at: later),
        try thread("00000000000000000000000005", in: "demo/general", at: later),
      ])
    #expect(
      items.map(\.id) == [
        "00000000000000000000000003", "00000000000000000000000004", "0000000000000000000000000A",
        "0000000000000000000000000B",
      ])
  }

  @Test func holdsTheCapturedThreadsOfItsChannel() throws {
    let threads = try JSONDecoder().decode(
      [ThreadSummary].self, from: try Fixture("threads").body)
    let general = channelStream("general", messages: [], threads: threads)
    #expect(!general.isEmpty)
    #expect(general.count == threads.filter { $0.thread.channel == "general" }.count)
  }
}
