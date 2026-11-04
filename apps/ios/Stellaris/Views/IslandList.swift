import SwiftUI

/// Board's, Needs you's, and Settings' lists on the conversation's island gray, as the web's board
/// views sit on the island the conversation does, in place of the system's black.
private struct IslandList: ViewModifier {
  func body(content: Content) -> some View {
    content
      .scrollContentBackground(.hidden)
      .background(MessageColor.island)
  }
}

extension View {
  /// The list on the conversation's island gray.
  func islandList() -> some View {
    modifier(IslandList())
  }

  /// A row of a list on the island gray: on `surface-2` at 50% over it, the web's row under the
  /// pointer and the composer's box, so a grouped list's sections read apart from the gray around
  /// them; or, in a plain list, on the island itself, as the web's rows are.
  func islandRow(plain: Bool = false) -> some View {
    listRowBackground(plain ? Color.clear : MessageColor.surface2.opacity(0.5))
  }
}
