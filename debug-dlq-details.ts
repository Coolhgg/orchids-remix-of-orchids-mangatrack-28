import { prisma } from './src/lib/prisma'

async function debugDLQDetails() {
  console.log("=== Detailed DLQ Analysis ===\n")
  
  // Get a sample of each error type
  const samples = await prisma.workerFailure.findMany({
    where: { resolved_at: null },
    take: 5,
    select: {
      id: true,
      queue_name: true,
      job_id: true,
      error_message: true,
      stack_trace: true,
      created_at: true,
      payload: true,
    },
    orderBy: { created_at: 'desc' }
  })
  
  for (const s of samples) {
    console.log(`=== Failure: ${s.id.slice(0, 8)} ===`)
    console.log(`Queue: ${s.queue_name}`)
    console.log(`Job ID: ${s.job_id}`)
    console.log(`Created: ${s.created_at}`)
    console.log(`Error: ${s.error_message?.slice(0, 200)}`)
    console.log(`Payload: ${JSON.stringify(s.payload)?.slice(0, 200)}`)
    console.log()
  }
  
  // Check the canonicalize queue errors specifically
  console.log("\n=== Canonicalize Queue Error Sample ===")
  const canonicalizeError = await prisma.workerFailure.findFirst({
    where: { 
      resolved_at: null,
      queue_name: 'canonicalize'
    },
    select: {
      error_message: true,
      stack_trace: true,
      payload: true,
    }
  })
  
  if (canonicalizeError) {
    console.log("Full error message:")
    console.log(canonicalizeError.error_message?.slice(0, 500))
    console.log("\nPayload:")
    console.log(JSON.stringify(canonicalizeError.payload, null, 2)?.slice(0, 500))
  }
  
  await prisma.$disconnect()
}

debugDLQDetails().catch(e => {
  console.error("Error:", e.message)
  process.exit(1)
})
