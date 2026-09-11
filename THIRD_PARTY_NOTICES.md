# Third-party notices

TongPin ChatRoom uses the following vendored data. Package dependencies keep their respective licenses in the package distributions and lock files.

## Unicode Emoji and CLDR

The emoji picker and reaction whitelist are generated from Unicode Emoji 17.0, Unicode 17.0.0, and CLDR 48.2 data. The pinned upstream files, source URLs, and SHA-256 hashes are in `vendor/unicode/17.0/sources.json`. The complete Unicode license is preserved in `vendor/unicode/17.0/LICENSE-UNICODE.txt`.

Copyright © 1991–2026 Unicode, Inc. The vendored Unicode data is distributed under the Unicode License v3 (SPDX: `Unicode-3.0`). The Chinese and English names and search annotations derive from CLDR. Generation retains fully qualified sequences, variation selectors, joiners, and actual modifier variants.

`scripts/build_emoji.py` reproduces the two generated JSON files using only these local sources. Its `--check` mode verifies their content without writing. No platform emoji fonts or glyph artwork are included; rendering uses the user's installed system fonts.
