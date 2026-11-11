# Reference-format test fixture

`seedream55-reference.heic` is the unmodified `test/fixtures/images/test.heic`
fixture from [ExifReader](https://github.com/mattiasw/ExifReader), whose package is
already used by this project. Source repository license: MPL-2.0.

- Source: https://raw.githubusercontent.com/mattiasw/ExifReader/main/test/fixtures/images/test.heic
- Source Git blob: `d6061da838869a4a5eda936f794da7a689a256cb`
- SHA-256: `4ea589f9728e7e3c08060473ffde0189719a1810550571de693d743e1bf86292`
- Bytes: 1,147,043; encoded primary `ispe`: 4032 × 3024; decoded primary after
  its orientation transform: 3024 × 4032. Both describe 12,192,768 pixels.

The HEIF test is a synthetic container-boundary test: it derives an in-memory generic `mif1` major-brand variant while
preserving the original compatible brands and encoded image payload. This
checks container recognition and primary dimensions, not a second model output.
The HEIC/HEIF payload is actually decoded by the exact server dependency
[`libheif-js@1.23.5`](https://www.npmjs.com/package/libheif-js/v/1.23.5), an
[LGPL-3.0 Emscripten build of libheif](https://github.com/catdad-experiments/libheif-js).
Its packaged WASM has no runtime dependencies or installation scripts; the
lockfile records its integrity. No upstream source/binary has been modified.
The isolated native Node process has a 20-second deadline, 128 MiB V8 old-space
limit, 512 MiB maximum WASM memory and 64 KiB output cap. These are individual
limits, not a claim that total RSS is capped at 512 MiB. It receives no provider
or database credentials and returns dimensions only, never converted pixels.

All eight format tests must also pass inside the built production Linux image.
Local Windows verification is not evidence of deployed decoder availability.
The current production FFmpeg 6.1.2 is not used for HEIC/HEIF: FFmpeg's official
[7.0 changelog](https://github.com/FFmpeg/FFmpeg/blob/n7.0/Changelog) introduced
HEIF/AVIF still/tiled-image support, so local FFmpeg 8 verification alone was
not a valid production compatibility claim.
Other image formats are generated as small local FFmpeg fixtures. No user image,
provider credential, model request or billable output is included.
