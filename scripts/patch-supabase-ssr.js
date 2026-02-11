/**
 * Patches @supabase/ssr package.json with an "exports" field.
 * Turbopack's Edge Runtime bundler requires the "exports" field to resolve modules.
 * Without it, middleware compilation fails with "Cannot find module '@supabase/ssr'".
 * 
 * This script should run after every `bun install` since the package.json gets overwritten.
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'node_modules', '@supabase', 'ssr', 'package.json');

try {
  if (!fs.existsSync(pkgPath)) {
    console.log('[patch-supabase-ssr] @supabase/ssr not installed, skipping');
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  if (pkg.exports) {
    console.log('[patch-supabase-ssr] Already patched, skipping');
    process.exit(0);
  }

  pkg.exports = {
    '.': {
      import: './dist/module/index.js',
      require: './dist/main/index.js',
      default: './dist/module/index.js',
    },
    './package.json': './package.json',
  };

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[patch-supabase-ssr] Patched exports field successfully');
} catch (err) {
  console.error('[patch-supabase-ssr] Failed to patch:', err.message);
  // Non-fatal — the resolveAlias in next.config.ts is a fallback
}
