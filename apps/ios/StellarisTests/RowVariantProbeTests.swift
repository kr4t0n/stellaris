import SwiftUI
import UIKit
import XCTest

@testable import Stellaris

/// A probe, not for the repository: how a list's row draws at rest, highlighted, and selected, under
/// each kind of row background, with the list on the island gray.
final class RowVariantProbeTests: XCTestCase {
  enum Variant: String, CaseIterable {
    case system, translucent, opaque, clear
  }

  struct Probe: View {
    let variant: Variant

    var body: some View {
      NavigationStack {
        List {
          Section("Probe") {
            row(Button("A button row") {})
            row(NavigationLink("A link row", value: "b"))
            row(Button("Another button row") {})
          }
        }
        .scrollContentBackground(.hidden)
        .background(MessageColor.island)
        .navigationDestination(for: String.self) { Text($0) }
      }
    }

    @ViewBuilder private func row(_ content: some View) -> some View {
      switch variant {
      case .system: content
      case .translucent: content.listRowBackground(MessageColor.surface2.opacity(0.5))
      case .opaque: content.listRowBackground(Color(red: 29 / 255, green: 29 / 255, blue: 29 / 255))
      case .clear: content.listRowBackground(Color.clear)
      }
    }
  }

  @MainActor func testRowVariants() async throws {
    let size = CGSize(width: 410, height: 678)
    var lines: [String] = []
    for variant in Variant.allCases {
      var spots: [CGPoint] = []
      var classes: [String] = []
      let rest = try await Snapshot.image(
        of: Probe(variant: variant), size: size, type: Snapshot.typeSizes[0]
      ) { view in
        let cells = try self.cells(in: view)
        spots = cells.map { cell in
          let frame = cell.convert(cell.bounds, to: nil)
          return CGPoint(x: frame.minX + frame.width * 0.8, y: frame.midY)
        }
        classes = cells.map { String(describing: type(of: $0)) }
      }
      let marked = try await Snapshot.image(
        of: Probe(variant: variant), size: size, type: Snapshot.typeSizes[0]
      ) { view in
        let cells = try self.cells(in: view)
        cells[0].isHighlighted = true
        cells[1].isSelected = true
        cells[2].isHighlighted = true
        cells[2].isSelected = true
      }
      try Snapshot.keep(rest, named: "probe-\(variant.rawValue)-rest", in: self)
      try Snapshot.keep(marked, named: "probe-\(variant.rawValue)-marked", in: self)
      for (index, spot) in spots.enumerated() {
        let before = Snapshot.color(in: rest, at: spot).map { "\($0)" } ?? "none"
        let after = Snapshot.color(in: marked, at: spot).map { "\($0)" } ?? "none"
        lines.append("probe: \(variant.rawValue) row \(index) \(classes[index]) rest \(before) marked \(after)")
      }
    }
    for line in lines {
      print(line)
    }
    let attachment = XCTAttachment(string: lines.joined(separator: "\n"))
    attachment.name = "probe-row-variants.txt"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor private func cells(in view: UIView) throws -> [UICollectionViewCell] {
    let list = try XCTUnwrap(find(in: view), "no list")
    let cells = list.visibleCells.sorted { $0.frame.minY < $1.frame.minY }
    _ = try XCTUnwrap(cells.dropFirst(2).first, "fewer than three rows")
    return Array(cells.prefix(3))
  }

  @MainActor private func find(in view: UIView) -> UICollectionView? {
    if let list = view as? UICollectionView {
      return list
    }
    for subview in view.subviews {
      if let list = find(in: subview) {
        return list
      }
    }
    return nil
  }
}
