// noVNC 1.6.0 ships an awaited WebCodecs probe in CommonJS output. Vite cannot
// bundle that combination. Keep H.264 disabled until a tested upstream package
// provides a compatible probe; all other noVNC encodings remain available.
const probe = "exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();";

export function patchNovncBrowser(source) {
  if (source.split(probe).length !== 2) {
    throw new Error("noVNC 1.6.0 compatibility patch no longer matches exactly once; review the dependency before building.");
  }
  return source.replace(probe, "exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = false;");
}
