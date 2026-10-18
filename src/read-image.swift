import Foundation
import Vision
import ImageIO

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString:Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 15000, height <= 15000,
      width * height <= 30000000 else { throw NSError(domain:"ImageOCR", code:1) }
let frameCount = CGImageSourceGetCount(source)
guard frameCount > 0, frameCount <= 120, width * height * frameCount <= 60000000 else { throw NSError(domain:"ImageOCR", code:2) }
var lines:[[String:Any]] = []
var seen:Set<String> = []
var totalPixels = 0
for frame in 0..<frameCount {
 guard let image = CGImageSourceCreateImageAtIndex(source, frame, nil), image.width <= 15000, image.height <= 15000, image.width * image.height <= 30000000 else { throw NSError(domain:"ImageOCR", code:3) }
 totalPixels += image.width * image.height
 guard totalPixels <= 60000000 else { throw NSError(domain:"ImageOCR", code:4) }
 let request = VNRecognizeTextRequest()
 request.recognitionLevel = .accurate
 request.recognitionLanguages = ["zh-Hans", "en-US"]
 request.usesLanguageCorrection = false
 try VNImageRequestHandler(cgImage:image).perform([request])
 for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  // Retain distinct readings/confidences from every frame, not just frame one.
  let key = candidate.string + "\u{0}" + String(candidate.confidence)
  if seen.insert(key).inserted { lines.append(["text":candidate.string,"confidence":candidate.confidence,"frame":frame+1]) }
 }
}
let output:[String:Any] = ["text":lines.compactMap { $0["text"] as? String }.joined(separator:"\n"), "lines":lines, "reader":"macOS Vision OCR", "width":width, "height":height,"frameCount":frameCount]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:output))
