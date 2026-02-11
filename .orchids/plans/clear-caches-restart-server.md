# Clear Caches and Restart Dev Server

## Commands to Run

Execute these commands in your terminal to clear all stale data and restart a single dev server:

### Step 1: Kill All Running Processes

```bash
# Kill all Node/Next/Bun processes
pkill -9 -f "next" 2>/dev/null
pkill -9 -f "node" 2>/dev/null  
pkill -9 -f "bun" 2>/dev/null

# Alternative: kill by port if above doesn't work
lsof -ti:3000 | xargs kill -9 2>/dev/null
```

### Step 2: Clear All Caches

```bash
# Clear Next.js build cache
rm -rf .next

# Clear node_modules cache
rm -rf node_modules/.cache

# Clear Turbopack cache
rm -rf .turbo

# Clear temp files
rm -rf /tmp/next-* /tmp/turbo* /tmp/bun-*

# Clear bun cache (if phantom deps persist)
rm -rf ~/.bun/install/cache
```

### Step 3: Reinstall Dependencies (Optional but Recommended)

```bash
# Clean install
rm -rf node_modules
bun install
```

### Step 4: Start Fresh Dev Server

```bash
# Start single dev server
bun run dev
```

### One-Liner (Copy-Paste Ready)

```bash
pkill -9 -f "next"; pkill -9 -f "node"; pkill -9 -f "bun"; rm -rf .next node_modules/.cache .turbo /tmp/next-* /tmp/turbo*; sleep 2; bun run dev
```

## Verification

After running the commands, you should see:
- Only ONE `next dev` process running
- Clean build output without cached artifacts
- No `[Redis]` or `[DNS]` spam during initial compilation (with our recent fixes)

Check running processes:
```bash
ps aux | grep -E "next|node|bun" | grep -v grep
```

Should show only:
- 1 `bun run dev` process
- 1 `next dev` process
- A few webpack loader processes (normal)
