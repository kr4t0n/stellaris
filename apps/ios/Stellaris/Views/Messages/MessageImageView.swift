import BoardKit
import SwiftUI
import UIKit

extension EnvironmentValues {
  /// The height of the conversation a message shows in, which caps its images' heights.
  @Entry var conversationHeight: CGFloat = .infinity
}

/// An image in a message, at its own width or the column's, whichever is smaller, never cropped,
/// and no taller than 60% of the conversation. A placeholder of a fixed size holds its place while
/// it loads; a tap opens it in a viewer, or follows the link it sits in. Its description is what
/// VoiceOver reads and what shows when it can't load, and one on a runner's machine alone reads as
/// that text.
struct MessageImageView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.conversationHeight) private var conversationHeight
  @Environment(\.openURL) private var openURL
  let image: MessageImage
  @State private var state = Loading.loading

  private enum Loading {
    case loading, failed
    case loaded(UIImage)
  }

  /// What VoiceOver calls it.
  private var name: String {
    image.alt.isEmpty ? "an image" : image.alt
  }

  var body: some View {
    if let source = image.source {
      shown
        .task(id: image) { await load(source) }
    } else {
      words
    }
  }

  private var words: some View {
    Text(image.text)
      .font(MessageType.text())
      .foregroundStyle(MessageColor.secondary)
  }

  @ViewBuilder private var shown: some View {
    switch state {
    case .loading:
      RoundedRectangle(cornerRadius: 8)
        .fill(MessageColor.surface2.opacity(0.5))
        .frame(maxWidth: 240, minHeight: 160, maxHeight: 160)
        .overlay { ProgressView() }
        .accessibilityElement()
        .accessibilityLabel("Loading \(name)")
    case .failed:
      words
    case .loaded(let picture):
      Button {
        if let link = image.link, let url = MessageText.url(for: link) {
          openURL(url)
        } else {
          model.viewing = ViewedImage(image: picture, alt: image.alt)
        }
      } label: {
        FittedImage(natural: picture.size, maxHeight: conversationHeight * 0.6) {
          Image(uiImage: picture)
            .resizable()
        }
        .clipShape(.rect(cornerRadius: 8))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(image.alt.isEmpty ? "Image" : image.alt)
      .accessibilityIdentifier("message-image")
    }
  }

  private func load(_ source: MessageImageSource) async {
    state = .loading
    do {
      state = .loaded(try await model.images.image(source, using: model))
    } catch is CancellationError {
      return
    } catch {
      state = .failed
    }
  }
}

/// Sizes an image as the web's message does: at its own width, a pixel to a point, or the width
/// offered, whichever is smaller, as tall as its shape asks, then shrunk whole to `maxHeight`.
private struct FittedImage: Layout {
  let natural: CGSize
  let maxHeight: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard natural.width > 0, natural.height > 0 else {
      return .zero
    }
    var width = min(natural.width, proposal.width ?? natural.width)
    var height = width * natural.height / natural.width
    if height > maxHeight {
      height = maxHeight
      width = height * natural.width / natural.height
    }
    return CGSize(width: width, height: height)
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}

/// An image on its own, fitted to the screen, which a pinch or a double tap zooms.
struct ImageViewer: View {
  @Environment(\.dismiss) private var dismiss
  let image: UIImage
  let alt: String

  var body: some View {
    NavigationStack {
      ZoomableImage(image: image)
        .ignoresSafeArea()
        .background(Color.black)
        .accessibilityElement()
        .accessibilityLabel(alt.isEmpty ? "Image" : alt)
        .accessibilityAddTraits(.isImage)
        .navigationTitle(alt)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          // A symbol, which the outer display puts in the side column at the window's edge.
          ToolbarItem(placement: .confirmationAction) {
            Button {
              dismiss()
            } label: {
              Label("Done", systemImage: "checkmark")
            }
          }
        }
    }
  }
}

private struct ZoomableImage: UIViewRepresentable {
  let image: UIImage

  func makeUIView(context: Context) -> ZoomView {
    ZoomView(image: image)
  }

  func updateUIView(_ view: ZoomView, context: Context) {}
}

/// A scroll view that fits its image to its bounds, zooms in to four times that with a pinch or a
/// double tap, and keeps the image centred while it is smaller than the view.
private final class ZoomView: UIScrollView, UIScrollViewDelegate {
  private let imageView: UIImageView
  /// The bounds the image was last fitted to.
  private var fitted = CGSize.zero

  init(image: UIImage) {
    imageView = UIImageView(image: image)
    super.init(frame: .zero)
    delegate = self
    addSubview(imageView)
    showsHorizontalScrollIndicator = false
    showsVerticalScrollIndicator = false
    contentInsetAdjustmentBehavior = .never
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoomByTap))
    doubleTap.numberOfTapsRequired = 2
    addGestureRecognizer(doubleTap)
  }

  required init?(coder: NSCoder) {
    return nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let size = imageView.image?.size ?? .zero
    if bounds.size != fitted, bounds.width > 0, bounds.height > 0, size.width > 0,
      size.height > 0
    {
      fitted = bounds.size
      let fit = min(bounds.width / size.width, bounds.height / size.height)
      zoomScale = 1
      imageView.frame = CGRect(origin: .zero, size: size)
      contentSize = size
      minimumZoomScale = fit
      maximumZoomScale = fit * 4
      zoomScale = fit
    }
    centre()
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? {
    imageView
  }

  func scrollViewDidZoom(_ scrollView: UIScrollView) {
    centre()
  }

  private func centre() {
    let frame = imageView.frame
    contentInset = UIEdgeInsets(
      top: max(0, (bounds.height - frame.height) / 2),
      left: max(0, (bounds.width - frame.width) / 2), bottom: 0, right: 0)
  }

  @objc private func zoomByTap() {
    let zoomed = zoomScale > minimumZoomScale * 1.01
    setZoomScale(zoomed ? minimumZoomScale : minimumZoomScale * 2.5, animated: true)
  }
}
