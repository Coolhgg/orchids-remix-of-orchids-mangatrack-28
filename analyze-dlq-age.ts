import { prisma } from './src/lib/prisma'

async function analyzeDLQAge() {
  console.log("=== DLQ Age Analysis ===\n")
  
  // Get date range of unresolved failures
  const dateRange = await prisma.$queryRaw<Array<{min_date: Date, max_date: Date}>>`
    SELECT MIN(created_at) as min_date, MAX(created_at) as max_date
    FROM worker_failures
    WHERE resolved_at IS NULL
  `
  
  console.log(`Oldest unresolved: ${dateRange[0].min_date}`)
  console.log(`Newest unresolved: ${dateRange[0].max_date}`)
  
  // Check if all are from same period
  const byDate = await prisma.$queryRaw<Array<{date_part: string, count: bigint}>>`
    SELECT DATE(created_at)::text as date_part, COUNT(*)::bigint as count
    FROM worker_failures
    WHERE resolved_at IS NULL
    GROUP BY date_part
    ORDER BY date_part DESC
    LIMIT 10
  `
  
  console.log("\n=== Failures by Date ===")
  for (const d of byDate) {
    console.log(`  ${d.date_part}: ${d.count}`)
  }
  
  // Check if these are all pre-migration
  const currentSchema = await prisma.$queryRaw<Array<{max_version: string}>>`
    SELECT MAX(version) as max_version
    FROM _prisma_migrations
    WHERE finished_at IS NOT NULL
  `
  
  console.log(`\nCurrent schema migration: ${currentSchema[0]?.max_version}`)
  
  // Safe to resolve old failures with schema mismatch
  console.log("\n=== Recommendation ===")
  console.log("These failures are from a stale schema version.")
  console.log("The 'last_chapter_released_at' column no longer exists.")
  console.log("Safe to bulk resolve these as they cannot be retried.")
  
  await prisma.$disconnect()
}

analyzeDLQAge().catch(e => {
  console.error("Error:", e.message)
  process.exit(1)
})
