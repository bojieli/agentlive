# Synthetic image fixtures

`pixel.jpg` is a one-pixel red JPEG generated locally from an empty Chrome canvas with `fillRect` and `toDataURL("image/jpeg")`. It contains no user image or private source content. Tests use it to verify header preflight and real browser decoding. Synthetic marker-only cases separately exercise parser limits; they are not assertions of browser decodability.

`pixel.webp` is a two-by-three-pixel blue static WebP generated locally from a Chrome canvas with `fillRect` and `toDataURL("image/webp")`. It contains no external image data.
