#!/usr/bin/env python3
"""
Hestia Dashboard — Build Script
Produces an obfuscated, minified dist file from the readable source.

Usage:
    python3 build.py [--version 1.3.0]

Output:
    dist/index.html          <- deploy this to GitHub release
    dist/build-info.json     <- version metadata for HPM
"""

import re, os, sys, json, hashlib
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────
SRC  = 'dashboard-unified.html'
DIST = 'dist/index.html'
META = 'dist/build-info.json'

COPYRIGHT_BLOCK = """<!--
Hestia™ Home Dashboard
Copyright © 2026 Haven. All rights reserved.
License: CC BY-NC 4.0 — personal use only.
https://github.com/h4ven88/hestia-dashboard
-->"""


def get_version():
    for arg in sys.argv[1:]:
        if arg.startswith('--version'):
            parts = arg.split('=') if '=' in arg else [arg, sys.argv[sys.argv.index(arg)+1]]
            return parts[-1].strip()
    # Auto-read from source
    with open(SRC) as f:
        m = re.search(r"HESTIA_VERSION\s*=\s*'([^']+)'", f.read())
        return m.group(1) if m else '1.0.0'


def minify_css(css):
    """Remove comments, collapse whitespace in CSS."""
    css = re.sub(r'/\*(?!!)([\s\S]*?)\*/', '', css)  # remove non-bang comments
    css = re.sub(r'\s+', ' ', css)
    css = re.sub(r'\s*([{};:,>+~])\s*', r'\1', css)
    css = re.sub(r';}', '}', css)
    return css.strip()


def minify_js(js):
    """
    Light JS minification:
    - Remove single-line comments (preserve copyright bangs /*!...)
    - Collapse whitespace
    - Does NOT rename variables (keeps dashboard functions callable from HTML)
    """
    # Remove // comments but not URLs (https://)
    js = re.sub(r'(?<!:)//(?!!)[^\n]*', '', js)
    # Remove multi-line comments (preserve /*! ... */)
    js = re.sub(r'/\*(?!!)([\s\S]*?)\*/', '', js)
    # Collapse multiple blank lines
    js = re.sub(r'\n{3,}', '\n\n', js)
    # Strip leading whitespace on lines
    js = re.sub(r'^\s+', '', js, flags=re.MULTILINE)
    # Collapse lines that are just whitespace
    js = re.sub(r'\n\s*\n', '\n', js)
    return js.strip()


def obfuscate_strings(js):
    """
    Replace string literals in JS with hex/unicode escapes.
    Makes casual reading much harder without breaking execution.
    Skips template literals and strings containing HTML.
    """
    def escape_str(m):
        quote = m.group(1)
        content = m.group(2)
        # Skip if contains HTML tags, CSS vars, or is very short
        if re.search(r'[<>{]|var\(|url\(', content) or len(content) < 4:
            return m.group(0)
        # Skip URL strings
        if re.match(r'https?://', content):
            return m.group(0)
        # Encode to unicode escapes
        encoded = ''.join(
            f'\\u{ord(c):04x}' if ord(c) > 32 and c not in ('"', "'", '\\') else c
            for c in content
        )
        return quote + encoded + quote

    # Only process simple string literals, not template literals
    js = re.sub(r'(["\'])([^"\'\\<>\n]{4,}?)\1', escape_str, js)
    return js


def build():
    version    = get_version()
    build_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    print(f"Building Hestia™ v{version} — {build_date}")
    print(f"Source: {SRC}")

    with open(SRC, 'r', encoding='utf-8') as f:
        src = f.read()

    # Update version in source before processing
    src = re.sub(r"HESTIA_VERSION\s*=\s*'[^']+'",   f"HESTIA_VERSION='v{version}'",   src)
    src = re.sub(r"HESTIA_BUILD_DATE\s*=\s*'[^']+'", f"HESTIA_BUILD_DATE='{build_date}'", src)

    # ── Extract + process CSS ────────────────────────────────────────
    css_blocks = []

    def collect_css(m):
        css_blocks.append(minify_css(m.group(1)))
        return '<style>' + '§CSS§' + str(len(css_blocks)-1) + '§</style>'

    src = re.sub(r'<style>([\s\S]*?)</style>', collect_css, src)

    # ── Extract + process JS ─────────────────────────────────────────
    js_blocks = []

    def collect_js(m):
        js = minify_js(m.group(1))
        # String obfuscation disabled — requires terser for production
        # js = obfuscate_strings(js)
        js_blocks.append(js)
        return '<script>' + '§JS§' + str(len(js_blocks)-1) + '§</script>'

    src = re.sub(r'<script>([\s\S]*?)</script>', collect_js, src)

    # ── Minify HTML ───────────────────────────────────────────────────
    # Remove HTML comments (keep copyright bang comments)
    src = re.sub(r'<!--(?!!)([\s\S]*?)-->', '', src)
    # Collapse whitespace between tags
    src = re.sub(r'>\s{2,}<', '> <', src)
    # Remove blank lines
    src = re.sub(r'\n{2,}', '\n', src)

    # ── Restore CSS + JS ─────────────────────────────────────────────
    for i, css in enumerate(css_blocks):
        src = src.replace('<style>§CSS§' + str(i) + '§</style>', f'<style>{css}</style>')
    for i, js in enumerate(js_blocks):
        src = src.replace('<script>§JS§' + str(i) + '§</script>', f'<script>{js}</script>')

    # ── Prepend copyright block AFTER DOCTYPE ─────────────────────────
    # DOCTYPE must be absolute first — insert copyright on line 2
    if '<!DOCTYPE html>' in src:
        src = src.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n' + COPYRIGHT_BLOCK, 1)
    else:
        src = '<!DOCTYPE html>\n' + COPYRIGHT_BLOCK + '\n' + src

    # ── Write output ─────────────────────────────────────────────────
    os.makedirs('dist', exist_ok=True)
    with open(DIST, 'w', encoding='utf-8') as f:
        f.write(src)

    # ── Build metadata ────────────────────────────────────────────────
    src_size  = os.path.getsize(SRC)
    dist_size = os.path.getsize(DIST)
    checksum  = hashlib.sha256(src.encode()).hexdigest()

    meta = {
        'name':       'Hestia Dashboard',
        'version':    version,
        'buildDate':  build_date,
        'sourceSize': src_size,
        'distSize':   dist_size,
        'reduction':  f'{(1 - dist_size/src_size)*100:.1f}%',
        'sha256':     checksum,
        'licence':    'CC BY-NC 4.0',
        'copyright':  '© 2026 Haven',
    }
    with open(META, 'w') as f:
        json.dump(meta, f, indent=2)

    print(f"\n✓ Built successfully")
    print(f"  Source:  {src_size/1024:.1f}KB")
    print(f"  Dist:    {dist_size/1024:.1f}KB ({meta['reduction']} reduction)")
    print(f"  SHA-256: {checksum[:16]}...")
    print(f"  Output:  {DIST}")
    print(f"  Meta:    {META}")


if __name__ == '__main__':
    build()
