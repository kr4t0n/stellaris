import BoardKit
import UIKit

/// An image open in the viewer, with its description.
struct ViewedImage: Identifiable {
  let id = UUID()
  let image: UIImage
  let alt: String
}

/// Why an image in a message can't be shown.
enum ImageFailure: Error {
  /// Its bytes aren't an image, or the board sent none, as for a file too large to send.
  case unreadable
  /// Nothing the app can load: an address that isn't `https`, or a project's file.
  case unsupported
}

/// The images messages show, each loaded as its source asks and decoded off the main actor: an
/// uploaded one with the token, kept by its id, since an upload never changes; one on a task's
/// branch, read through the board from the project's runner; and one on the web, over `https`
/// without the token.
@MainActor final class BoardImages {
  private let uploads = NSCache<NSString, UIImage>()

  init() {
    uploads.totalCostLimit = 96 << 20
  }

  func image(_ source: MessageImageSource, using model: AppModel) async throws -> UIImage {
    switch source {
    case .upload(let id):
      if let kept = uploads.object(forKey: id as NSString) {
        return kept
      }
      let data = try await model.imageData(id)
      let image = try await Self.decode(data)
      uploads.setObject(image, forKey: id as NSString, cost: data.count)
      return image
    case .file(.task(let task), let path):
      let file = try await model.send(BoardAPI.taskFile(task, path: path))
      guard let data = file.data else {
        throw ImageFailure.unreadable
      }
      return try await Self.decode(data)
    case .file(.project, _):
      throw ImageFailure.unsupported
    case .web(let href):
      guard let url = URL(string: href), url.scheme?.lowercased() == "https" else {
        throw ImageFailure.unsupported
      }
      let (data, response) = try await model.environment.session.data(from: url)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw ImageFailure.unreadable
      }
      return try await Self.decode(data)
    }
  }

  @concurrent private nonisolated static func decode(_ data: Data) async throws -> UIImage {
    guard let image = UIImage(data: data) else {
      throw ImageFailure.unreadable
    }
    return await image.byPreparingForDisplay() ?? image
  }
}
